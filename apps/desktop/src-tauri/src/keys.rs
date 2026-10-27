use std::collections::BTreeSet;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use chacha20poly1305::aead::Generate;
use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{HashAlg, PrivateKey, decode_secret_key, load_secret_key};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::hosts;
use crate::ssh::{self, expand_home};
use crate::vault::{Vault, new_id};
use crate::{err, write_private};

const KIND: &str = "key";

/// Private key: unencrypted OpenSSH text; vault key seals whole item.
#[derive(Serialize, Deserialize)]
struct StoredKey {
    name: String,
    algorithm: String,
    fingerprint: String,
    public_key: String,
    private_key: Zeroizing<String>,
    /// Unix seconds; 0 for keys older than this field.
    #[serde(default)]
    created_at: u64,
    /// "generated" or "imported".
    #[serde(default)]
    origin: String,
}

/// Sent to webview: never private key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyMeta {
    id: String,
    name: String,
    algorithm: String,
    fingerprint: String,
    public_key: String,
    created_at: u64,
    origin: String,
    /// Server rev last synced at; 0 = never.
    rev: u64,
    dirty: bool,
}

fn to_stored(name: String, key: &PrivateKey, origin: &str) -> Result<StoredKey, String> {
    let public = key.public_key();
    Ok(StoredKey {
        name,
        algorithm: public.algorithm().to_string(),
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        public_key: public.to_openssh().map_err(err)?,
        private_key: key.to_openssh(LineEnding::LF).map_err(err)?,
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()),
        origin: origin.into(),
    })
}

pub fn load_key(vault: &Vault, id: &str) -> Result<PrivateKey, String> {
    let stored: StoredKey = vault.with(|v| v.get(id))?;
    decode_secret_key(&stored.private_key, None).map_err(err)
}

#[tauri::command]
pub fn keys_list(vault: State<'_, Vault>) -> Result<Vec<KeyMeta>, String> {
    vault.with(|v| {
        Ok(v.list::<StoredKey>(KIND)?
            .into_iter()
            .map(|(id, k)| {
                let (rev, dirty) = v.sync_state(&id);
                KeyMeta {
                    id,
                    name: k.name,
                    algorithm: k.algorithm,
                    fingerprint: k.fingerprint,
                    public_key: k.public_key,
                    created_at: k.created_at,
                    origin: k.origin,
                    rev,
                    dirty,
                }
            })
            .collect())
    })
}

/// Ed25519, created inside vault.
#[tauri::command]
pub fn key_generate(vault: State<'_, Vault>, name: String) -> Result<(), String> {
    let seed = Zeroizing::new(<[u8; 32]>::generate());
    let mut key = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    key.set_comment(format!("{name}@lynxterm"));
    let stored = to_stored(name, &key, "generated")?;
    vault.with(|v| v.put(&new_id(), KIND, &stored))
}

/// Private key to Downloads. Needs master password again.
#[tauri::command]
pub async fn key_export(
    app: AppHandle,
    vault: State<'_, Vault>,
    id: String,
    password: String,
) -> Result<String, String> {
    let header = vault.with(|v| Ok(v.header().clone()))?;
    header.open(&password)?; // proves owner still at keyboard
    let stored: StoredKey = vault.with(|v| v.get(&id))?;

    let dir = app.path().download_dir().map_err(err)?;
    let base: String = stored
        .name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "-_.".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let path = crate::sftp::free_path(&dir, &base);
    write_private(&path, stored.private_key.as_bytes())?;
    let mut public = path.clone().into_os_string();
    public.push(".pub");
    fs::write(public, format!("{}\n", stored.public_key)).map_err(err)?;
    Ok(path.display().to_string())
}

/// Appends public key to host's ~/.ssh/authorized_keys. Signs in with host's current setup
/// (its key, or `password`).
#[tauri::command]
pub async fn key_install(
    vault: State<'_, Vault>,
    id: String,
    host_id: String,
    password: String,
    use_for_host: bool,
) -> Result<(), String> {
    let stored: StoredKey = vault.with(|v| v.get(&id))?;
    let (mut host, session) = ssh::connect_saved(&vault, &host_id, &password).await?;

    let line = stored.public_key.replace('\'', "'\\''"); // safe inside single quotes
    let command = format!(
        "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && \
         (grep -qxF '{line}' ~/.ssh/authorized_keys || echo '{line}' >> ~/.ssh/authorized_keys)"
    );
    ssh::exec(&session, &command).await?;
    if use_for_host {
        host.key_id = id;
        host.id = host_id;
        vault.with(|v| v.put(&host.id, hosts::KIND, &host))?;
    }
    Ok(())
}

/// Private keys in ~/.ssh: files with sibling `.pub`.
#[tauri::command]
pub fn keys_scan() -> BTreeSet<String> {
    let Ok(entries) = fs::read_dir(expand_home("~/.ssh")) else {
        return BTreeSet::new();
    };
    entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|name| expand_home(&format!("~/.ssh/{name}.pub")).exists())
        .map(|name| format!("~/.ssh/{name}"))
        .collect()
}

/// `source`: file path or pasted OpenSSH / PEM / PuTTY key. Returns key id.
#[tauri::command]
pub fn key_import(
    vault: State<'_, Vault>,
    name: String,
    source: String,
    passphrase: String,
) -> Result<String, String> {
    let pass = (!passphrase.is_empty()).then_some(passphrase.as_str());
    let source = source.trim();
    let key = if source.contains('\n') {
        decode_secret_key(source, pass)
    } else {
        load_secret_key(expand_home(source), pass)
    }
    .map_err(err)?;
    let stored = to_stored(name, &key, "imported")?;

    vault.with(|v| {
        // Same key reimported: update entry, no twin.
        let existing = v.list::<StoredKey>(KIND)?;
        let id = existing
            .into_iter()
            .find(|(_, k)| k.fingerprint == stored.fingerprint)
            .map_or_else(new_id, |(id, _)| id);
        v.put(&id, KIND, &stored)?;
        Ok(id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passphrase_is_stripped_and_key_survives() {
        let path = std::env::temp_dir().join(format!("lynxterm-test-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        let made = std::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "pw", "-f"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(made.success());

        assert!(
            load_secret_key(&path, None).is_err(),
            "encrypted key needs its passphrase"
        );
        let key = load_secret_key(&path, Some("pw")).unwrap();
        let stored = to_stored("test".into(), &key, "imported").unwrap();
        let back = decode_secret_key(&stored.private_key, None).unwrap();
        assert_eq!(
            back.public_key().fingerprint(HashAlg::Sha256).to_string(),
            stored.fingerprint
        );

        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("pub"));
    }
}
