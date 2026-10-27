//! Per-host command history (opt-in), remote command list, shell integration install.
//! History in vault: encrypted, synced.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ssh::{self, Sessions};
use crate::vault::{Vault, new_id};

const KIND: &str = "history";
const MAX_COMMANDS: usize = 500;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    /// user@host:port: unsaved hosts get history too.
    host_key: String,
    /// Oldest first.
    commands: Vec<String>,
}

#[tauri::command]
pub fn history_list(vault: State<'_, Vault>) -> Result<Vec<History>, String> {
    let items = vault.with(|v| v.list::<History>(KIND))?;
    Ok(items.into_iter().map(|(_, h)| h).collect())
}

/// Replaces host's history. Sync conflict can leave twin items per host; save folds
/// them into one.
#[tauri::command]
pub fn history_save(
    vault: State<'_, Vault>,
    host_key: String,
    mut commands: Vec<String>,
) -> Result<(), String> {
    let excess = commands.len().saturating_sub(MAX_COMMANDS);
    commands.drain(..excess);
    vault.with(|v| {
        let ids: Vec<String> = v
            .list::<History>(KIND)?
            .into_iter()
            .filter(|(_, h)| h.host_key == host_key)
            .map(|(id, _)| id)
            .collect();
        let id = ids.first().cloned().unwrap_or_else(new_id);
        for twin in ids.iter().skip(1) {
            v.delete(twin)?;
        }
        v.put(&id, KIND, &History { host_key, commands })
    })
}

/// All hosts when `host_key` is None.
#[tauri::command]
pub fn history_clear(vault: State<'_, Vault>, host_key: Option<String>) -> Result<(), String> {
    vault.with(|v| {
        for (id, h) in v.list::<History>(KIND)? {
            if host_key.as_ref().is_none_or(|k| *k == h.host_key) {
                v.delete(&id)?;
            }
        }
        Ok(())
    })
}

/// Every command on server PATH, for suggestions.
#[tauri::command]
pub async fn ssh_commands(sessions: State<'_, Sessions>, id: u32) -> Result<Vec<String>, String> {
    let script = "command -v bash >/dev/null 2>&1 || exit 0\n\
                  bash -c 'compgen -c' 2>/dev/null | sort -u | head -n 5000\n";
    let output = ssh::exec(&*sessions.handle(id)?, script).await?;
    Ok(output
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect())
}

/// Appends integration block to ~/.bashrc and ~/.zshrc, once.
const INSTALL: &str = concat!(
    r#"case "$SHELL" in
  */zsh) [ -f ~/.zshrc ] || touch ~/.zshrc ;;
  *) [ -f ~/.bashrc ] || touch ~/.bashrc ;;
esac
for f in ~/.bashrc ~/.zshrc; do
  [ -f "$f" ] || continue
  grep -q '>>> lynxterm shell integration' "$f" && continue
  cat >> "$f" <<'LYNXTERM_EOF'
"#,
    include_str!("shell-integration.sh"),
    "\nLYNXTERM_EOF\ndone\n"
);

/// Deletes block from ~/.bashrc and ~/.zshrc; rest untouched.
const REMOVE: &str = r#"for f in ~/.bashrc ~/.zshrc; do
  [ -f "$f" ] || continue
  grep -q '>>> lynxterm shell integration' "$f" || continue
  awk '/^# >>> lynxterm shell integration >>>/{skip=1} !skip{print} /^# <<< lynxterm shell integration <<</{skip=0}' "$f" > "$f.lynxterm-tmp" &&
    cat "$f.lynxterm-tmp" > "$f" && rm -f "$f.lynxterm-tmp"
done
"#;

/// On saved host, no terminal open.
#[tauri::command]
pub async fn shell_integration_host(
    vault: State<'_, Vault>,
    host_id: String,
    password: String,
    remove: bool,
) -> Result<(), String> {
    let (_, session) = ssh::connect_saved(&vault, &host_id, &password).await?;
    ssh::exec(&session, if remove { REMOVE } else { INSTALL })
        .await
        .map(drop)
}

#[tauri::command]
pub async fn shell_integration_install(
    sessions: State<'_, Sessions>,
    id: u32,
) -> Result<(), String> {
    ssh::exec(&*sessions.handle(id)?, INSTALL).await.map(drop)
}

#[cfg(test)]
mod tests {
    use super::{INSTALL, REMOVE};
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn sh(home: &std::path::Path, script: &str) {
        let mut child = Command::new("sh")
            .arg("-s")
            .env("HOME", home)
            .env("SHELL", "/bin/bash")
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn installs_once_and_bash_emits_the_markers() {
        let home = std::env::temp_dir().join(format!("lynxterm-home-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        sh(&home, INSTALL);
        sh(&home, INSTALL); // second run must not add second copy
        let rc = std::fs::read_to_string(home.join(".bashrc")).unwrap();
        assert_eq!(rc.matches(">>> lynxterm shell integration").count(), 1);

        let out = Command::new("bash")
            .args([
                "--rcfile",
                home.join(".bashrc").to_str().unwrap(),
                "-i",
                "-c",
            ])
            .arg("__lynxterm_prompt; echo \"$PS1\"")
            .env("HOME", &home)
            .output()
            .unwrap();
        let out = String::from_utf8_lossy(&out.stdout);
        assert!(
            out.contains("\u{1b}]133;D\u{7}"),
            "prompt hook output: {out:?}"
        );
        assert!(
            out.contains("\u{1b}]7;file://"),
            "prompt hook output: {out:?}"
        );
        assert!(out.contains("133;B"), "PS1 should be wrapped: {out:?}");

        std::fs::write(
            home.join(".bashrc"),
            format!("alias ll='ls -l'\n{rc}export KEEP=1\n"),
        )
        .unwrap();
        sh(&home, REMOVE);
        let rc = std::fs::read_to_string(home.join(".bashrc")).unwrap();
        assert!(!rc.contains("lynxterm"), "block left behind: {rc}");
        assert!(
            rc.contains("alias ll='ls -l'") && rc.contains("export KEEP=1"),
            "lost lines: {rc}"
        );
        let _ = std::fs::remove_dir_all(home);
    }
}
