//! Agentless server monitoring: cron keeps 7 days of per-minute samples in
//! ~/.lynxterm/metrics on server; app reads it, plus live samples, over SSH.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh::Disconnect;
use tauri::State;

use crate::ssh::{self, Handle, Sessions};
use crate::vault::Vault;

/// Prints one line: `unix_time cpu% mem_used_mb mem_total_mb disk% load1 cores rx_B/s tx_B/s`.
/// CPU, network measured over 1 s, so each run takes about 1 s. Network: every interface
/// except loopback. History saved before load and network has only first five fields.
const SAMPLE: &str = r#"net() { awk 'NR>2 { split($0, p, ":"); if (p[1] ~ /^ *lo$/) next; split(p[2], f, " "); r+=f[1]; t+=f[9] } END { printf "%.0f %.0f", r, t }' /proc/net/dev; }
a=$(head -1 /proc/stat); na=$(net); sleep 1; b=$(head -1 /proc/stat); nb=$(net)
cpu=$(printf '%s\n%s\n' "$a" "$b" | awk '{i=$5+$6; t=0; for(k=2;k<=NF;k++) t+=$k} NR==1{pi=i; pt=t} NR==2{printf "%.0f", (t>pt ? 100*(1-(i-pi)/(t-pt)) : 0)}')
mem=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf "%d %d", (t-a)/1024, t/1024}' /proc/meminfo)
disk=$(df -P / | awk 'NR==2{print $5+0}')
load=$(cut -d' ' -f1 /proc/loadavg)
cores=$(grep -c ^processor /proc/cpuinfo)
rate=$(printf '%s %s\n' "$na" "$nb" | awk '{r=$3-$1; t=$4-$2; printf "%.0f %.0f", (r>0?r:0), (t>0?t:0)}')
echo "$(date +%s) $cpu $mem $disk $load $cores $rate"
"#;

const TAG: &str = "lynxterm-metrics";

/// Prints `os <id>`: os-release ID (debian, ubuntu…), else kernel name.
const OS: &str = ". /etc/os-release 2>/dev/null; echo \"os ${ID:-$(uname -s | tr A-Z a-z)}\"\n";

fn install_script() -> String {
    format!(
        r#"command -v crontab >/dev/null || {{ echo "cron isn't installed on this server"; exit 1; }}
[ -r /proc/stat ] || {{ echo "Monitoring needs a Linux server"; exit 1; }}
mkdir -p ~/.lynxterm
cat > ~/.lynxterm/metrics.sh <<'LYNXTERM_EOF'
# Lynxterm monitoring: appends a sample a minute, keeps the last 7 days.
f=$HOME/.lynxterm/metrics
{{
{SAMPLE}}} >> "$f"
# Trimming hourly, not every minute, keeps disk writes small.
if [ "$(date +%M)" = 00 ]; then tail -n 10080 "$f" > "$f.tmp" && mv "$f.tmp" "$f"; fi
LYNXTERM_EOF
(crontab -l 2>/dev/null | grep -v {TAG}; echo '* * * * * sh $HOME/.lynxterm/metrics.sh # {TAG}') | crontab -
"#
    )
}

/// Fixed scripts only; frontend can't send its own.
fn script(action: &str) -> Result<String, String> {
    Ok(match action {
        // First line "on"/"off" (cron job present?), then saved samples.
        "history" => format!(
            "crontab -l 2>/dev/null | grep -q {TAG} && echo on || echo off\ncat ~/.lynxterm/metrics 2>/dev/null\ntrue\n"
        ),
        "sample" => SAMPLE.to_owned(),
        "os" => OS.to_owned(),
        "install" => install_script(),
        "remove" => format!(
            "crontab -l 2>/dev/null | grep -v {TAG} | crontab -\nrm -f ~/.lynxterm/metrics.sh ~/.lynxterm/metrics ~/.lynxterm/metrics.tmp\n"
        ),
        _ => return Err(format!("Unknown metrics action: {action}")),
    })
}

/// Over open terminal session's connection.
#[tauri::command]
pub async fn metrics(
    sessions: State<'_, Sessions>,
    id: u32,
    action: String,
) -> Result<String, String> {
    ssh::exec(&*sessions.handle(id)?, &script(&action)?).await
}

/// Background connections to saved hosts: monitoring without terminal open.
#[derive(Default)]
pub struct Watched(Mutex<HashMap<String, Arc<Handle>>>);

/// Saved host over background connection, kept for next call. Key-based hosts only:
/// passwords never stored.
#[tauri::command]
pub async fn metrics_host(
    vault: State<'_, Vault>,
    watched: State<'_, Watched>,
    host_id: String,
    action: String,
) -> Result<String, String> {
    let script = script(&action)?;
    let open = watched.0.lock().unwrap().get(&host_id).cloned();
    let handle = match open.filter(|h| !h.is_closed()) {
        Some(handle) => handle,
        None => {
            let handle = Arc::new(ssh::connect_saved(&vault, &host_id, "").await?.1);
            watched
                .0
                .lock()
                .unwrap()
                .insert(host_id.clone(), handle.clone());
            handle
        }
    };
    ssh::exec(&handle, &script).await.inspect_err(|_| {
        watched.0.lock().unwrap().remove(&host_id);
    })
}

#[tauri::command]
pub async fn metrics_unwatch(watched: State<'_, Watched>, host_id: String) -> Result<(), String> {
    let handle = watched.0.lock().unwrap().remove(&host_id);
    if let Some(h) = handle {
        let _ = h.disconnect(Disconnect::ByApplication, "", "en").await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn sh(script: &str, home: &std::path::Path) -> String {
        let mut child = Command::new("sh")
            .arg("-s")
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        String::from_utf8(out.stdout).unwrap()
    }

    fn assert_sample(line: &str) {
        let fields: Vec<f64> = line
            .split_whitespace()
            .map(|f| f.parse().unwrap())
            .collect();
        assert_eq!(fields.len(), 9, "{line}");
        assert!(fields[1] <= 100.0 && fields[4] <= 100.0, "{line}");
        assert!(fields[2] <= fields[3], "{line}");
        assert!(
            fields[5] >= 0.0 && fields[6] >= 1.0,
            "load and cores: {line}"
        );
        assert!(fields[7] >= 0.0 && fields[8] >= 0.0, "network: {line}");
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn sample_prints_nine_numbers() {
        assert_sample(sh(super::SAMPLE, &std::env::temp_dir()).trim());
    }

    // Installed script body, without cron.
    #[test]
    #[cfg(target_os = "linux")]
    fn installed_script_appends_a_sample() {
        let home = std::env::temp_dir().join(format!("lynxterm-metrics-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".lynxterm")).unwrap();
        let script = super::install_script();
        let body = script.split("'LYNXTERM_EOF'\n").nth(1).unwrap();
        let body = body.split("LYNXTERM_EOF\n").next().unwrap();
        sh(body, &home);
        let saved = std::fs::read_to_string(home.join(".lynxterm/metrics")).unwrap();
        assert_sample(saved.trim());
        std::fs::remove_dir_all(home).unwrap();
    }
}
