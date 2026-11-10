use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::err;
use crate::metrics::Watched;
use crate::ssh::{self, Sessions};
use crate::vault::Vault;

const KIND: &str = "service";
/// File order, as serviceFile.ts.
const FUNCTIONS: [&str; 8] = [
    "detect",
    "preflight",
    "install",
    "check",
    "logs",
    "fix",
    "upgrade",
    "uninstall",
];
/// Quick, read-only: run without terminal. Rest need one (sudo, following logs).
const BACKGROUND: [&str; 3] = ["detect", "preflight", "check"];
/// Bundled services (/services) by file name; their ids are builtin:<name>. The frontend
/// bundles the same folder; a test keeps this list matching it.
const BUILTIN: [(&str, &str); 7] = [
    ("bun", include_str!("../../../../services/bun.sh")),
    ("deno", include_str!("../../../../services/deno.sh")),
    ("go", include_str!("../../../../services/go.sh")),
    ("node", include_str!("../../../../services/node.sh")),
    ("php", include_str!("../../../../services/php.sh")),
    ("rust", include_str!("../../../../services/rust.sh")),
    ("ssh", include_str!("../../../../services/ssh.sh")),
];

/// Kept apart so editor locks function lines; assembled into a file when run.
#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Service {
    id: String,
    name: String,
    description: String,
    check_on_connect: bool,
    /// Minutes between checks while app runs; 0 off.
    check_every: u32,
    shared: String,
    functions: BTreeMap<String, String>,
    why: String,
    fix_label: String,
}

crate::kind_commands!(services_list, service_save(service): Service, KIND);

/// Local `sh -n`: parses, runs nothing. None if valid, else sh's first error line
/// (`sh: 12: Syntax error...`, bash: `sh: line 12: ...`).
#[tauri::command]
pub fn service_check(script: String) -> Result<Option<String>, String> {
    let mut child = Command::new("sh")
        .arg("-n")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Syntax check needs sh, on macOS or Linux".to_owned())?;
    // Dropped after write: sh sees end of file. Write error ignored: sh may quit reading at
    // first error; its exit status tells.
    let _ = child.stdin.take().unwrap().write_all(script.as_bytes());
    let out = child.wait_with_output().map_err(err)?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    Ok((!out.status.success()).then(|| stderr.lines().next().unwrap_or("").to_owned()))
}

/// What a script sees as LYNXTERM_AUTH.
fn auth_ok(auth: &str) -> Result<(), String> {
    match auth {
        "publickey" | "password" => Ok(()),
        _ => Err(format!("Unknown sign-in: {auth}")),
    }
}

/// Same file as serviceFile.ts builds, so editor line numbers match sh errors.
fn file(s: &Service) -> String {
    let mut lines = vec![
        "# shared: variables and helpers".to_owned(),
        s.shared.clone(),
    ];
    for name in FUNCTIONS {
        if let Some(body) = s.functions.get(name) {
            lines.extend([format!("{name}() {{"), body.clone(), "}".into()]);
        }
    }
    lines.push("\"$@\"".into());
    lines.join("\n")
}

/// Script text and a file name for a service id: a built-in's bundled file, or an own one
/// from the vault. Anything else is refused, so an id never reaches a path or the vault
/// unchecked.
fn script_for(vault: &Vault, id: &str) -> Result<(String, String), String> {
    if let Some(name) = id.strip_prefix("builtin:") {
        let (_, text) = BUILTIN
            .iter()
            .find(|(n, _)| *n == name)
            .ok_or_else(|| "Unknown service".to_owned())?;
        return Ok((text.to_string(), format!("builtin-{name}")));
    }
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Unknown service".into());
    }
    let service: Service = vault.with(|v| v.get(id))?;
    Ok((file(&service), id.to_owned()))
}

/// Built here, so only known functions and ids get in; `sh -c '...'` reads the same in every
/// login shell, fish too.
#[tauri::command]
pub fn service_command(
    vault: State<'_, Vault>,
    service_id: String,
    function: String,
    auth: String,
) -> Result<String, String> {
    if !FUNCTIONS.contains(&function.as_str()) || BACKGROUND.contains(&function.as_str()) {
        return Err(format!("{function} doesn't run in a terminal"));
    }
    auth_ok(&auth)?;
    let (script, name) = script_for(&vault, &service_id)?;
    let path = format!("~/.lynxterm/services/{name}.sh");
    // base64: file text can hold any quote; its letters need none.
    let b64 = data_encoding::BASE64.encode(script.as_bytes());
    Ok(format!(
        "sh -c 'umask 077 && mkdir -p ~/.lynxterm/services && printf %s {b64} | base64 -d > {path} \
         && exec env LYNXTERM_AUTH={auth} sh {path} {function}'"
    ))
}

#[derive(Serialize)]
pub struct Ran {
    code: u32,
    output: String,
}

/// Script built here, never taken from frontend.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn service_run(
    vault: State<'_, Vault>,
    sessions: State<'_, Sessions>,
    watched: State<'_, Watched>,
    service_id: String,
    function: String,
    session: Option<u32>,
    host_id: String,
    auth: String,
    fresh: bool,
) -> Result<Ran, String> {
    if !BACKGROUND.contains(&function.as_str()) {
        return Err(format!("{function} runs in a terminal"));
    }
    auth_ok(&auth)?;
    let (text, _) = script_for(&vault, &service_id)?;
    // fresh: connection opened now, never a reused one. Script sees LYNXTERM_FRESH and may
    // take it as proof the server still lets this host in (ssh.sh undo timer).
    let (session, env) = if fresh {
        watched.forget(&host_id);
        (None, "export LYNXTERM_FRESH=1\n")
    } else {
        (session, "")
    };
    let script = format!("export LYNXTERM_AUTH={auth}\n{env}set -- {function}\n{text}\n");
    let handle = watched.pick(&sessions, &vault, session, &host_id).await?;
    let ran = tokio::time::timeout(Duration::from_secs(20), ssh::exec_status(&handle, &script))
        .await
        .map_err(|_| format!("{function} took over 20 seconds"))?;
    let (code, output) = ran.inspect_err(|_| {
        if session.is_none() {
            watched.forget(&host_id);
        }
    })?;
    Ok(Ran { code, output })
}

#[cfg(test)]
mod tests {
    use super::{BUILTIN, Service, file, service_check};

    #[test]
    fn builtins_match_folder() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../services");
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "sh"))
            .map(|p| p.file_stem().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let mut listed: Vec<String> = BUILTIN.iter().map(|(n, _)| n.to_string()).collect();
        listed.sort();
        assert_eq!(names, listed);
    }

    #[test]
    fn file_matches_editor_order() {
        let s: Service = serde_json::from_str(
            r#"{"name":"x","shared":"A=1","functions":{"check":"echo ok","detect":"true"}}"#,
        )
        .unwrap();
        assert_eq!(
            file(&s),
            "# shared: variables and helpers\nA=1\ndetect() {\ntrue\n}\ncheck() {\necho ok\n}\n\"$@\""
        );
    }

    #[test]
    fn sh_finds_line() {
        assert_eq!(service_check("f() {\n  echo hi\n}\n".into()).unwrap(), None);
        let bad = service_check("f() {\n  echo hi\n".into()).unwrap().unwrap();
        assert!(bad.contains('2') || bad.contains('3'), "{bad}");
    }
}
