//! Encrypted local vault, one JSON file.
//!
//! master password --Argon2id--> master key --HKDF--> wrap key --unwraps--> vault key
//!                                           \--HKDF--> auth key (proves password to Worker)
//! recovery code   --HKDF-----------------------------> recovery key --unwraps--> vault key
//! vault key --XChaCha20-Poly1305--> each item (AAD: id + kind)
//!
//! Worker stores header and sealed items verbatim.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, Generate, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use data_encoding::{BASE32_NOPAD, BASE64, HEXLOWER};
use hkdf::Hkdf;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::err;

pub type Key32 = Zeroizing<[u8; 32]>;

const KDF: Kdf = Kdf {
    m: 64 * 1024,
    t: 3,
    p: 1,
}; // 64 MiB, 3 passes
const VAULT_KEY_AAD: &[u8] = b"lynxterm/v1/vault-key";
const CHECK_AAD: &[u8] = b"lynxterm/v1/check";
const SYNC_TOKEN_AAD: &[u8] = b"lynxterm/v1/sync-token";
#[cfg(test)]
pub const FAST: Kdf = Kdf { m: 8, t: 1, p: 1 };

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub struct Kdf {
    m: u32,
    t: u32,
    p: u32,
}

impl Kdf {
    /// Settings may come from Worker. Weaker than `KDF` makes auth key it holds cheap to
    /// brute-force.
    fn strong(self) -> bool {
        #[cfg(test)]
        if self == FAST {
            return true;
        }
        self.m >= KDF.m && self.t >= KDF.t
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
pub struct Sealed {
    nonce: String,
    ct: String,
}

/// What new device needs. Opaque to Worker.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Header {
    kdf: Kdf,
    salt: String,
    wrapped_vk: Sealed,
    recovery_vk: Sealed,
    /// Known plaintext under vault key: proves key or header belongs to this vault.
    check: Sealed,
}

#[derive(Serialize, Deserialize, Clone)]
struct Item {
    kind: String,
    /// Server rev last synced at; 0 = never.
    rev: u64,
    dirty: bool,
    /// `None`: tombstone, so sync spreads delete.
    sealed: Option<Sealed>,
}

#[derive(Serialize, Deserialize)]
struct SyncConfig {
    url: String,
    token: Sealed,
    last_rev: u64,
    /// Kinds kept local: never pushed or pulled.
    #[serde(default)]
    skip: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    #[serde(flatten)]
    header: Header,
    items: BTreeMap<String, Item>,
    sync: Option<SyncConfig>,
}

/// `rev` from server, `base_rev` to server.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WireItem {
    id: String,
    #[serde(default)] // push response has only id, rev
    pub(crate) kind: String,
    #[serde(default)]
    rev: u64,
    #[serde(default)]
    base_rev: u64,
    sealed: Option<Sealed>,
}

pub struct Open {
    vk: Key32,
    file: VaultFile,
    path: PathBuf,
}

#[derive(Default)]
pub struct Vault(Mutex<Option<Open>>);

impl Vault {
    pub fn with<R>(&self, f: impl FnOnce(&mut Open) -> Result<R, String>) -> Result<R, String> {
        let mut guard = self.0.lock().unwrap();
        f(guard.as_mut().ok_or("The vault is locked")?)
    }

    pub fn set(&self, open: Open) {
        *self.0.lock().unwrap() = Some(open);
    }
}

fn cipher(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new_from_slice(key).expect("key is 32 bytes")
}

fn seal(key: &[u8; 32], aad: &[u8], msg: &[u8]) -> Sealed {
    let nonce = XNonce::generate(); // 24 bytes: random nonce safe
    let ct = cipher(key)
        .encrypt(&nonce, Payload { msg, aad })
        .expect("encryption cannot fail");
    Sealed {
        nonce: BASE64.encode(&nonce),
        ct: BASE64.encode(&ct),
    }
}

fn unseal(key: &[u8; 32], aad: &[u8], sealed: &Sealed) -> Result<Zeroizing<Vec<u8>>, String> {
    let nonce = BASE64.decode(sealed.nonce.as_bytes()).map_err(err)?;
    let nonce = XNonce::try_from(nonce.as_slice()).map_err(|_| "Corrupt vault: bad nonce")?;
    let ct = BASE64.decode(sealed.ct.as_bytes()).map_err(err)?;
    cipher(key)
        .decrypt(&nonce, Payload { msg: &ct, aad })
        .map(Zeroizing::new)
        .map_err(|_| "Decryption failed".to_string())
}

fn hkdf(ikm: &[u8], info: &[u8]) -> Key32 {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(None, ikm)
        .expand(info, &mut *out)
        .expect("32 is a valid length");
    out
}

/// (wrap key, auth key). Only auth key leaves device.
pub fn derive(password: &str, salt_b64: &str, kdf: Kdf) -> Result<(Key32, Key32), String> {
    if !kdf.strong() {
        return Err("Refused: weaker password hashing than Lynxterm uses".into());
    }
    let salt = BASE64.decode(salt_b64.as_bytes()).map_err(err)?;
    let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(err)?;
    let mut master = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, &mut *master)
        .map_err(err)?;
    Ok((
        hkdf(&*master, b"lynxterm/v1/wrap"),
        hkdf(&*master, b"lynxterm/v1/auth"),
    ))
}

fn recovery_key(code: &str) -> Result<Key32, String> {
    let clean: String = code.chars().filter(char::is_ascii_alphanumeric).collect();
    let bytes = BASE32_NOPAD
        .decode(clean.to_ascii_uppercase().as_bytes())
        .map_err(|_| "That is not a valid recovery code")?;
    Ok(hkdf(&Zeroizing::new(bytes), b"lynxterm/v1/recovery"))
}

fn to_key32(bytes: &[u8]) -> Result<Key32, String> {
    Ok(Zeroizing::new(
        bytes.try_into().map_err(|_| "Corrupt vault: bad key")?,
    ))
}

impl Header {
    pub fn unwrap_vk(&self, wrap: &[u8; 32]) -> Result<Key32, String> {
        let vk =
            unseal(wrap, VAULT_KEY_AAD, &self.wrapped_vk).map_err(|_| "Wrong master password")?;
        to_key32(&vk)
    }

    /// Checks password. (vault key, auth key).
    pub fn open(&self, password: &str) -> Result<(Key32, Key32), String> {
        let (wrap, auth) = derive(password, &self.salt, self.kdf)?;
        Ok((self.unwrap_vk(&wrap)?, auth))
    }
}

fn read(path: &Path) -> Result<VaultFile, String> {
    serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)
}

/// Temp file then rename: crash mid-write never corrupts vault. Owner-only.
fn write(path: &Path, file: &VaultFile) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let _ = fs::remove_file(&tmp); // crash leftover, maybe looser permissions
    crate::write_private(&tmp, &serde_json::to_vec_pretty(file).map_err(err)?)?;
    fs::rename(&tmp, path).map_err(err)
}

/// Rewraps vault key; returns new auth key.
fn set_password(header: &mut Header, vk: &[u8; 32], password: &str) -> Result<Key32, String> {
    if password.chars().count() < 10 {
        return Err("Use at least 10 characters for the master password".into());
    }
    header.salt = BASE64.encode(&<[u8; 16]>::generate());
    let (wrap, auth) = derive(password, &header.salt, header.kdf)?;
    header.wrapped_vk = seal(&wrap, VAULT_KEY_AAD, vk);
    Ok(auth)
}

/// (vault, recovery code shown once).
pub(crate) fn create(path: PathBuf, password: &str, kdf: Kdf) -> Result<(Open, String), String> {
    let vk = Zeroizing::new(<[u8; 32]>::generate());
    let code = BASE32_NOPAD.encode(&*Zeroizing::new(<[u8; 20]>::generate())); // 160 bits
    let code = code
        .as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-");

    let mut header = Header {
        kdf,
        salt: String::new(),
        wrapped_vk: Sealed::default(),
        recovery_vk: seal(&*recovery_key(&code)?, VAULT_KEY_AAD, &*vk),
        check: seal(&vk, CHECK_AAD, b"lynxterm"),
    };
    set_password(&mut header, &vk, password)?;
    let file = VaultFile {
        header,
        items: BTreeMap::new(),
        sync: None,
    };
    write(&path, &file)?;
    Ok((Open { vk, file, path }, code))
}

fn unlock(path: PathBuf, password: &str) -> Result<Open, String> {
    let file = read(&path)?;
    let (vk, _) = file.header.open(password)?;
    Ok(Open { vk, file, path })
}

/// (vault, new auth key to update Worker).
pub(crate) fn recover(
    path: PathBuf,
    code: &str,
    new_password: &str,
) -> Result<(Open, Key32), String> {
    let mut file = read(&path)?;
    let vk = unseal(
        &*recovery_key(code)?,
        VAULT_KEY_AAD,
        &file.header.recovery_vk,
    )
    .map_err(|_| "Wrong recovery code")?;
    let vk = to_key32(&vk)?;
    let auth = set_password(&mut file.header, &vk, new_password)?;
    write(&path, &file)?;
    Ok((Open { vk, file, path }, auth))
}

/// Fresh device adopts vault from Worker.
pub fn join(
    path: PathBuf,
    header: Header,
    wrap: &[u8; 32],
    url: String,
    token: &str,
) -> Result<Open, String> {
    let vk = header.unwrap_vk(wrap)?;
    let file = VaultFile {
        header: header.clone(),
        items: BTreeMap::new(),
        sync: None,
    };
    let mut open = Open { vk, file, path };
    open.connect_sync(url, token, header)?;
    Ok(open)
}

pub fn new_id() -> String {
    HEXLOWER.encode(&<[u8; 16]>::generate())
}

fn aad(id: &str, kind: &str) -> Vec<u8> {
    format!("lynxterm/v1/item/{kind}/{id}").into_bytes()
}

impl Open {
    pub fn get<T: DeserializeOwned>(&self, id: &str) -> Result<T, String> {
        let item = self.file.items.get(id).ok_or("No such item")?;
        let sealed = item.sealed.as_ref().ok_or("Item was deleted")?;
        let plain = unseal(&self.vk, &aad(id, &item.kind), sealed)?;
        serde_json::from_slice(&plain).map_err(err)
    }

    /// Undecryptable items (server tampering) skipped, not fatal.
    pub fn list<T: DeserializeOwned>(&self, kind: &str) -> Result<Vec<(String, T)>, String> {
        Ok(self
            .file
            .items
            .iter()
            .filter(|(_, item)| item.kind == kind && item.sealed.is_some())
            .filter_map(|(id, _)| Some((id.clone(), self.get(id).ok()?)))
            .collect())
    }

    pub fn put<T: Serialize>(&mut self, id: &str, kind: &str, value: &T) -> Result<(), String> {
        let plain = Zeroizing::new(serde_json::to_vec(value).map_err(err)?);
        let rev = self.file.items.get(id).map_or(0, |item| item.rev);
        let sealed = Some(seal(&self.vk, &aad(id, kind), &plain));
        self.file.items.insert(
            id.into(),
            Item {
                kind: kind.into(),
                rev,
                dirty: true,
                sealed,
            },
        );
        write(&self.path, &self.file)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        if let Some(item) = self.file.items.get_mut(id) {
            item.sealed = None;
            item.dirty = true;
        }
        write(&self.path, &self.file)
    }

    /// (synced server rev, dirty).
    pub fn sync_state(&self, id: &str) -> (u64, bool) {
        self.file
            .items
            .get(id)
            .map_or((0, true), |item| (item.rev, item.dirty))
    }

    pub fn header(&self) -> &Header {
        &self.file.header
    }

    /// Worker header is this vault's and safe to adopt. `check` alone can be copied beside
    /// junk keys. `recovery_vk` never changes; refusing others keeps recovery code working.
    pub fn same_vault(&self, header: &Header) -> bool {
        header.recovery_vk == self.file.header.recovery_vk
            && header.kdf.strong()
            && unseal(&self.vk, CHECK_AAD, &header.check).is_ok()
    }

    /// (url, device token, last pulled rev) if sync set up.
    pub fn sync_target(&self) -> Result<Option<(String, String, u64)>, String> {
        let Some(sync) = &self.file.sync else {
            return Ok(None);
        };
        let token = unseal(&self.vk, SYNC_TOKEN_AAD, &sync.token)?;
        let token = String::from_utf8(token.to_vec()).map_err(err)?;
        Ok(Some((sync.url.clone(), token, sync.last_rev)))
    }

    pub fn connect_sync(&mut self, url: String, token: &str, header: Header) -> Result<(), String> {
        self.file.header = header; // Worker's copy may carry newer password
        // Re-sign-in to same Worker keeps `skip` and `last_rev`.
        let (last_rev, skip) = match self.file.sync.take() {
            Some(old) if old.url == url => (old.last_rev, old.skip),
            _ => (0, Vec::new()),
        };
        self.file.sync = Some(SyncConfig {
            url,
            token: seal(&self.vk, SYNC_TOKEN_AAD, token.as_bytes()),
            last_rev,
            skip,
        });
        write(&self.path, &self.file)
    }

    pub fn skipped(&self) -> &[String] {
        self.file.sync.as_ref().map_or(&[], |s| &s.skip)
    }

    /// Kind turned back on was skipped by earlier pulls: next pull restarts from 0.
    pub fn set_sync_skip(&mut self, skip: Vec<String>) -> Result<(), String> {
        let sync = self.file.sync.as_mut().ok_or("Sync is not set up")?;
        if sync.skip.iter().any(|kind| !skip.contains(kind)) {
            sync.last_rev = 0;
        }
        sync.skip = skip;
        write(&self.path, &self.file)
    }

    /// Unpushed local changes, skipped kinds excluded.
    pub fn dirty(&self) -> Vec<WireItem> {
        let skip = self.skipped();
        self.file
            .items
            .iter()
            .filter(|(_, item)| item.dirty && !skip.contains(&item.kind))
            .map(|(id, item)| WireItem {
                id: id.clone(),
                kind: item.kind.clone(),
                rev: 0,
                base_rev: item.rev,
                sealed: item.sealed.clone(),
            })
            .collect()
    }

    /// Merges Worker page: (pulled-up-to rev, any item changed). Own pushes echoed back
    /// not counted.
    pub fn apply_pull(
        &mut self,
        header: Option<Header>,
        items: Vec<WireItem>,
    ) -> Result<(u64, bool), String> {
        let mut touched = false;
        if let Some(header) = header.filter(|h| *h != self.file.header) {
            if !self.same_vault(&header) {
                return Err("This Worker holds a different vault".into());
            }
            self.file.header = header; // password changed on another device
            touched = true;
        }

        let skip = self.skipped().to_vec();
        let start = self.file.sync.as_ref().map_or(0, |s| s.last_rev);
        let mut last = start;
        let mut changed = false;
        for remote in items {
            last = last.max(remote.rev);
            if skip.contains(&remote.kind) {
                continue;
            }
            if let Some(local) = self.file.items.get(&remote.id).cloned() {
                if local.rev >= remote.rev {
                    continue; // have it; usually own push echoed back
                }
                // Both sides changed: server keeps id, ours saved as copy. Local delete loses
                // to remote edit.
                if let (true, Some(sealed)) = (local.dirty, &local.sealed) {
                    let plain = unseal(&self.vk, &aad(&remote.id, &local.kind), sealed)?;
                    let copy = new_id();
                    let sealed = Some(seal(&self.vk, &aad(&copy, &local.kind), &plain));
                    self.file.items.insert(
                        copy,
                        Item {
                            kind: local.kind,
                            rev: 0,
                            dirty: true,
                            sealed,
                        },
                    );
                }
            }
            changed = true;
            self.file.items.insert(
                remote.id,
                Item {
                    kind: remote.kind,
                    rev: remote.rev,
                    dirty: false,
                    sealed: remote.sealed,
                },
            );
        }
        if touched || changed || last != start {
            if let Some(sync) = &mut self.file.sync {
                sync.last_rev = last;
            }
            write(&self.path, &self.file)?;
        }
        Ok((last, changed))
    }

    pub fn apply_push(&mut self, pushed: &[WireItem], accepted: &[WireItem]) -> Result<(), String> {
        for done in accepted {
            let Some(item) = self.file.items.get_mut(&done.id) else {
                continue;
            };
            let sent = pushed.iter().find(|p| p.id == done.id).map(|p| &p.sealed);
            item.rev = done.rev;
            // Edited mid-flight: stays dirty, on new rev.
            if sent == Some(&item.sealed) {
                item.dirty = false;
            }
        }
        write(&self.path, &self.file)
    }
}

pub fn vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(err)?;
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("vault.json"))
}

/// Vault key in OS keychain: quick unlock on this device.
fn device_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("lynxterm", "vault-key").map_err(err)
}

pub fn remember(open: &Open, yes: bool) {
    let Ok(entry) = device_entry() else { return };
    let _ = if yes {
        entry.set_secret(&*open.vk)
    } else {
        entry.delete_credential()
    };
}

fn quick_unlock(path: PathBuf) -> Result<Open, String> {
    let file = read(&path)?;
    let vk = to_key32(&Zeroizing::new(device_entry()?.get_secret().map_err(err)?))?;
    unseal(&vk, CHECK_AAD, &file.header.check)?; // stale key from older vault fails here
    Ok(Open { vk, file, path })
}

/// "none" (no vault yet), "locked" or "unlocked".
#[tauri::command]
pub fn vault_status(app: AppHandle, vault: State<'_, Vault>) -> Result<&'static str, String> {
    let mut guard = vault.0.lock().unwrap();
    if guard.is_none() {
        let path = vault_path(&app)?;
        if !path.exists() {
            return Ok("none");
        }
        *guard = quick_unlock(path).ok();
    }
    Ok(guard.as_ref().map_or("locked", |_| "unlocked"))
}

// Async: Argon2 ~1s, off UI thread.
#[tauri::command]
pub async fn vault_create(
    app: AppHandle,
    vault: State<'_, Vault>,
    password: String,
    remember_device: bool,
) -> Result<String, String> {
    let path = vault_path(&app)?;
    if path.exists() {
        return Err("A vault already exists".into());
    }
    let (open, code) = create(path, &password, KDF)?;
    remember(&open, remember_device);
    vault.set(open);
    Ok(code)
}

#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    vault: State<'_, Vault>,
    password: String,
    remember_device: bool,
) -> Result<(), String> {
    let open = unlock(vault_path(&app)?, &password)?;
    remember(&open, remember_device);
    vault.set(open);
    Ok(())
}

#[tauri::command]
pub async fn vault_recover(
    app: AppHandle,
    vault: State<'_, Vault>,
    code: String,
    new_password: String,
) -> Result<(), String> {
    let (open, auth) = recover(vault_path(&app)?, &code, &new_password)?;
    let sync = open.sync_target()?;
    let header = open.header().clone();
    vault.set(open);
    if let Some((url, token, _)) = sync {
        crate::sync::put_header(&url, &token, &auth, &header)
            .await
            .map_err(|e| {
                format!("Recovered on this device, but your Worker wasn't updated: {e}")
            })?;
    }
    Ok(())
}

/// Wipes vault key from memory and OS keychain.
#[tauri::command]
pub fn vault_lock(vault: State<'_, Vault>) {
    if let Some(open) = vault.0.lock().unwrap().take() {
        remember(&open, false);
    }
}

/// Needs master password. Erases local vault and keychain key; Worker copy untouched, next
/// run can rejoin. Caller restarts app so sessions, tunnels opened with old vault die.
#[tauri::command]
pub async fn vault_erase(
    app: AppHandle,
    vault: State<'_, Vault>,
    password: String,
) -> Result<(), String> {
    let path = vault_path(&app)?;
    if !path.exists() {
        return Ok(());
    }
    let open = unlock(path.clone(), &password)?; // wrong password: nothing touched
    remember(&open, false);
    vault.0.lock().unwrap().take();
    let _ = fs::remove_file(path.with_extension("json.tmp"));
    fs::remove_file(&path).map_err(err)
}

#[tauri::command]
pub fn app_restart(app: AppHandle) {
    app.restart();
}

/// Host, group, snippet or key. Forwards use `forward_delete`, which also stops one.
#[tauri::command]
pub fn item_delete(vault: State<'_, Vault>, id: String) -> Result<(), String> {
    vault.with(|v| v.delete(&id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("lynxterm-{name}-{}.json", std::process::id()))
    }

    #[test]
    fn create_unlock_recover() {
        let path = temp("vault");
        let (mut open, code) = create(path.clone(), "correct horse battery", FAST).unwrap();
        open.put("a", "host", &"secret value").unwrap();

        assert!(unlock(path.clone(), "wrong password!!").is_err());
        let open = unlock(path.clone(), "correct horse battery").unwrap();
        assert_eq!(open.get::<String>("a").unwrap(), "secret value");
        assert!(!fs::read_to_string(&path).unwrap().contains("secret value"));

        assert!(recover(path.clone(), "AAAA-AAAA", "new password here").is_err());
        recover(path.clone(), &code.to_lowercase(), "new password here").unwrap();
        let mut open = unlock(path.clone(), "new password here").unwrap();
        assert_eq!(open.get::<String>("a").unwrap(), "secret value");

        open.delete("a").unwrap();
        assert!(open.get::<String>("a").is_err());
        assert!(open.list::<String>("host").unwrap().is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn sync_conflict_keeps_both_and_foreign_vault_is_refused() {
        let path = temp("sync");
        let (mut open, _) = create(path.clone(), "correct horse battery", FAST).unwrap();
        open.put("a", "host", &"v1").unwrap();
        let pushed = open.dirty();
        let accepted = vec![WireItem {
            rev: 1,
            ..pushed[0].clone()
        }];
        open.apply_push(&pushed, &accepted).unwrap();
        assert!(open.dirty().is_empty());

        // Local edit while another device pushed rev 2.
        open.put("a", "host", &"ours").unwrap();
        let theirs = WireItem {
            id: "a".into(),
            kind: "host".into(),
            rev: 2,
            base_rev: 0,
            sealed: Some(seal(&open.vk, &aad("a", "host"), b"\"theirs\"")),
        };
        open.apply_pull(None, vec![theirs]).unwrap();
        let mut values: Vec<String> = open
            .list("host")
            .unwrap()
            .into_iter()
            .map(|(_, v)| v)
            .collect();
        values.sort();
        assert_eq!(values, ["ours", "theirs"]);

        let other = temp("other");
        let (stranger, _) = create(other.clone(), "another password", FAST).unwrap();
        assert!(
            open.apply_pull(Some(stranger.header().clone()), vec![])
                .is_err()
        );
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(other);
    }

    #[test]
    fn worker_headers_keep_the_recovery_part_and_strong_settings() {
        let path = temp("forged");
        let (mut open, code) = create(path.clone(), "correct horse battery", FAST).unwrap();
        // Password change from another device: adopted.
        let mut changed = open.header().clone();
        set_password(&mut changed, &open.vk, "new password here").unwrap();
        open.apply_pull(Some(changed.clone()), vec![]).unwrap();

        // Real check beside junk keys, or weak settings: refused.
        let junk = Sealed {
            nonce: BASE64.encode(&[0u8; 24]),
            ct: BASE64.encode(&[0u8; 48]),
        };
        let weak = Kdf {
            m: 1024,
            t: 1,
            p: 1,
        };
        let forged = Header {
            wrapped_vk: junk.clone(),
            recovery_vk: junk,
            ..changed.clone()
        };
        let cheap = Header {
            kdf: weak,
            ..changed.clone()
        };
        for header in [forged, cheap] {
            assert!(open.apply_pull(Some(header), vec![]).is_err());
        }
        assert!(derive("new password here", &changed.salt, weak).is_err());

        // Neither saved: new password and recovery code still open vault.
        assert!(unlock(path.clone(), "new password here").is_ok());
        assert!(recover(path.clone(), &code, "another password").is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn skipped_kinds_stay_local_until_turned_back_on() {
        let path = temp("skip");
        let (mut open, _) = create(path.clone(), "correct horse battery", FAST).unwrap();
        let header = open.header().clone();
        open.connect_sync("https://w.example".into(), "token", header)
            .unwrap();
        open.set_sync_skip(vec!["history".into()]).unwrap();

        open.put("h", "host", &"a host").unwrap();
        open.put("c", "history", &"ls").unwrap();
        let kinds: Vec<_> = open.dirty().into_iter().map(|i| i.kind).collect();
        assert_eq!(kinds, ["host"]);

        let theirs = WireItem {
            id: "r".into(),
            kind: "history".into(),
            rev: 5,
            base_rev: 0,
            sealed: Some(seal(&open.vk, &aad("r", "history"), b"\"remote\"")),
        };
        assert_eq!(
            open.apply_pull(None, vec![theirs.clone()]).unwrap(),
            (5, false)
        );
        assert!(open.get::<String>("r").is_err());
        assert_eq!(open.apply_pull(None, vec![]).unwrap(), (5, false));

        open.set_sync_skip(vec![]).unwrap();
        assert_eq!(open.sync_target().unwrap().unwrap().2, 0);
        assert_eq!(open.apply_pull(None, vec![theirs]).unwrap(), (5, true));
        assert_eq!(open.get::<String>("r").unwrap(), "remote");

        open.set_sync_skip(vec!["history".into()]).unwrap();
        let header = open.header().clone();
        open.connect_sync("https://w.example".into(), "new token", header)
            .unwrap();
        assert_eq!(open.skipped(), ["history"]);
        assert_eq!(open.sync_target().unwrap().unwrap().2, 5);
        let _ = fs::remove_file(path);
    }
}
