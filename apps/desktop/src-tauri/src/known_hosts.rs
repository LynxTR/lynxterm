//! User's ~/.ssh/known_hosts, shared with OpenSSH. Not synced: per machine.

use std::fs;

use russh::keys::{HashAlg, PublicKey};
use serde::Serialize;

use crate::err;
use crate::ssh::expand_home;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    /// 1-based line number, for delete.
    line: usize,
    /// Host patterns; empty when OpenSSH stored them hashed.
    hosts: String,
    algorithm: String,
    fingerprint: String,
}

/// `i`: 0-based line index.
fn parse(i: usize, line: &str) -> Option<KnownHost> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
        return None; // comments, @cert-authority, @revoked markers
    }
    let mut parts = line.split_whitespace();
    let hosts = parts.next()?;
    let algorithm = parts.next()?;
    let key = PublicKey::from_openssh(&format!("{algorithm} {}", parts.next()?)).ok()?;
    Some(KnownHost {
        line: i + 1,
        hosts: if hosts.starts_with("|1|") { "" } else { hosts }.into(),
        algorithm: algorithm.into(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
    })
}

fn read() -> String {
    fs::read_to_string(expand_home("~/.ssh/known_hosts")).unwrap_or_default()
}

#[tauri::command]
pub fn known_hosts_list() -> Vec<KnownHost> {
    read()
        .lines()
        .enumerate()
        .filter_map(|(i, line)| parse(i, line))
        .collect()
}

/// `fingerprint` guards against file changing meanwhile.
#[tauri::command]
pub fn known_host_delete(line: usize, fingerprint: String) -> Result<(), String> {
    let text = read();
    let mut lines: Vec<&str> = text.lines().collect();
    let target = line.checked_sub(1).and_then(|i| parse(i, lines.get(i)?));
    if target.map(|k| k.fingerprint) != Some(fingerprint) {
        return Err("known_hosts changed on disk; reload and try again".into());
    }
    lines.remove(line - 1);
    fs::write(expand_home("~/.ssh/known_hosts"), lines.join("\n") + "\n").map_err(err)
}

#[cfg(test)]
mod tests {
    use super::parse;

    const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    #[test]
    fn parses_plain_and_hashed_and_skips_the_rest() {
        let plain = parse(0, &format!("github.com,140.82.121.4 ssh-ed25519 {KEY}")).unwrap();
        assert_eq!(plain.hosts, "github.com,140.82.121.4");
        assert!(plain.fingerprint.starts_with("SHA256:"));

        let hashed = parse(0, &format!("|1|abc=|def= ssh-ed25519 {KEY} comment")).unwrap();
        assert_eq!(hashed.hosts, "");

        assert!(parse(0, "# a comment").is_none());
        assert!(parse(0, &format!("@revoked * ssh-ed25519 {KEY}")).is_none());
        assert!(parse(0, "host ssh-ed25519 not-base64").is_none());
    }
}
