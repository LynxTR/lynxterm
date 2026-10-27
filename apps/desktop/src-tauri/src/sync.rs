//! Client for user's own Worker. All sent data pre-encrypted except auth key, which proves
//! master password without revealing it.

use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::LazyLock;

use data_encoding::BASE64;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, State};

use crate::err;
use crate::vault::{self, Header, Kdf, Key32, Vault, WireItem, derive};

#[derive(Deserialize)]
struct Prelogin {
    enrolled: bool,
    kdf: Option<Kdf>,
    salt: Option<String>,
}

#[derive(Deserialize)]
struct Token {
    token: String,
}

#[derive(Deserialize)]
struct Login {
    token: String,
    header: Header,
}

#[derive(Deserialize)]
struct Page {
    header: Option<Header>,
    items: Vec<WireItem>,
    more: bool,
}

#[derive(Deserialize)]
struct Pushed {
    accepted: Vec<WireItem>,
}

/// Expected `Lynxterm-Worker` response header. Keep in step with `VERSION` in Worker's
/// index.ts; mismatch stops sync, names side to update.
const WORKER_VERSION: u32 = 1;

/// Header missing on success: Worker predates versioning. Missing on error: maybe no Worker
/// at all; error passes through.
fn check_version(header: Option<&str>, ok: bool) -> Result<(), String> {
    let version = match header {
        Some(v) => v.trim().parse().unwrap_or(0),
        None if ok => 0,
        None => return Ok(()),
    };
    match version.cmp(&WORKER_VERSION) {
        Ordering::Less => Err(
            "Your Worker is out of date. Deploy the latest Lynxterm Worker to keep syncing.".into(),
        ),
        Ordering::Greater => {
            Err("Your Worker is newer than this app. Update Lynxterm to keep syncing.".into())
        }
        Ordering::Equal => Ok(()),
    }
}

/// Another device changed master password; Worker dropped other sign-ins. App prompts for
/// new one. Keep in step with `SIGNED_OUT` in useSync.ts.
const SIGNED_OUT: &str = "Signed out: the master password was changed on another device";

pub(crate) static HTTP: LazyLock<reqwest::Client> = LazyLock::new(reqwest::Client::new);

async fn call<T: DeserializeOwned>(req: reqwest::RequestBuilder) -> Result<T, String> {
    let (http, req) = req.build_split();
    let req = req.map_err(err)?;
    // Only signed-in devices send token; 401 then means Worker forgot it.
    let signed_in = req.headers().contains_key(reqwest::header::AUTHORIZATION);
    let res = http
        .execute(req)
        .await
        .map_err(|e| format!("Can't reach your Worker: {e}"))?;
    check_version(
        res.headers()
            .get("lynxterm-worker")
            .and_then(|v| v.to_str().ok()),
        res.status().is_success(),
    )?;
    if res.status().is_success() {
        return res.json().await.map_err(err);
    }
    if signed_in && res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(SIGNED_OUT.into());
    }
    #[derive(Deserialize)]
    struct Fail {
        error: String,
    }
    let status = res.status();
    Err(res
        .json::<Fail>()
        .await
        .map_or_else(|_| status.to_string(), |f| f.error))
}

fn base_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(url).map_err(|_| "Use your Worker's https:// address")?;
    // Plain http only for local `wrangler dev`. Whole-host match: http://localhost.example.com
    // is remote.
    let local =
        parsed.scheme() == "http" && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
    if parsed.scheme() == "https" || local {
        Ok(url.into())
    } else {
        Err("Use your Worker's https:// address".into())
    }
}

async fn prelogin(url: &str) -> Result<Prelogin, String> {
    call(HTTP.get(format!("{url}/v1/prelogin"))).await
}

/// (device token, Worker header, wrap key).
async fn login(
    url: &str,
    password: &str,
    pre: Prelogin,
) -> Result<(String, Header, Key32), String> {
    let (Some(kdf), Some(salt)) = (pre.kdf, pre.salt) else {
        return Err("This Worker has no vault yet".into());
    };
    let (wrap, auth) = derive(password, &salt, kdf)?;
    let res: Login = call(
        HTTP.post(format!("{url}/v1/login"))
            .json(&json!({ "authKey": BASE64.encode(&*auth) })),
    )
    .await?;
    Ok((res.token, res.header, wrap))
}

pub async fn put_header(
    url: &str,
    token: &str,
    auth: &[u8; 32],
    header: &Header,
) -> Result<(), String> {
    let _: serde_json::Value = call(
        HTTP.put(format!("{url}/v1/header"))
            .bearer_auth(token)
            .json(&json!({ "authKey": BASE64.encode(auth), "header": header })),
    )
    .await?;
    Ok(())
}

/// Pull, then push changes (only `send` kinds if given). True if pull changed anything:
/// app reloads lists only then.
#[tauri::command]
pub async fn sync_now(vault: State<'_, Vault>, send: Option<Vec<String>>) -> Result<bool, String> {
    sync(&vault, send.as_deref()).await
}

/// Kinds with unpushed changes. No request.
#[tauri::command]
pub fn sync_pending(vault: State<'_, Vault>) -> Result<BTreeSet<String>, String> {
    Ok(vault
        .with(|v| Ok(v.dirty()))?
        .into_iter()
        .map(|i| i.kind)
        .collect())
}

#[tauri::command]
pub fn sync_skipped(vault: State<'_, Vault>) -> Result<Vec<String>, String> {
    vault.with(|v| Ok(v.skipped().to_vec()))
}

#[tauri::command]
pub fn sync_skip(vault: State<'_, Vault>, kinds: Vec<String>) -> Result<(), String> {
    vault.with(|v| v.set_sync_skip(kinds))
}

async fn sync(vault: &Vault, send: Option<&[String]>) -> Result<bool, String> {
    let Some((url, token, mut since)) = vault.with(|v| v.sync_target())? else {
        return Ok(false);
    };
    let mut changed = false;
    loop {
        let page: Page = call(
            HTTP.get(format!("{url}/v1/sync?since={since}"))
                .bearer_auth(&token),
        )
        .await?;
        let (last, page_changed) = vault.with(|v| v.apply_pull(page.header, page.items))?;
        (since, changed) = (last, changed || page_changed);
        if !page.more {
            break;
        }
    }
    let dirty: Vec<WireItem> = vault
        .with(|v| Ok(v.dirty()))?
        .into_iter()
        .filter(|i| send.is_none_or(|kinds| kinds.contains(&i.kind)))
        .collect();
    for chunk in dirty.chunks(500) {
        let res: Pushed = call(
            HTTP.post(format!("{url}/v1/sync"))
                .bearer_auth(&token)
                .json(&json!({ "items": chunk })),
        )
        .await?;
        // Conflicts stay dirty; next pull turns them into copies.
        vault.with(|v| v.apply_push(chunk, &res.accepted))?;
    }
    Ok(changed)
}

#[tauri::command]
pub fn sync_url(vault: State<'_, Vault>) -> Result<Option<String>, String> {
    vault.with(|v| Ok(v.sync_target()?.map(|(url, ..)| url)))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Sign-ins, not unique devices: rejoin counts twice.
    devices: u32,
    /// False once Worker sets `NEW_DEVICES = off`.
    new_devices: bool,
}

#[tauri::command]
pub async fn sync_status(vault: State<'_, Vault>) -> Result<Status, String> {
    let Some((url, token, _)) = vault.with(|v| v.sync_target())? else {
        return Err("Sync is not set up".into());
    };
    call(HTTP.get(format!("{url}/v1/status")).bearer_auth(&token)).await
}

/// Empty Worker: enrols this vault. Else signs in.
#[tauri::command]
pub async fn sync_connect(
    vault: State<'_, Vault>,
    url: String,
    enroll_token: String,
    password: String,
) -> Result<(), String> {
    connect(&vault, &url, &enroll_token, &password).await
}

async fn connect(
    vault: &Vault,
    url: &str,
    enroll_token: &str,
    password: &str,
) -> Result<(), String> {
    let url = base_url(url)?;
    let pre = prelogin(&url).await?;
    let (token, header) = if pre.enrolled {
        sign_in(vault, &url, password, pre).await?
    } else {
        let header = vault.with(|v| Ok(v.header().clone()))?;
        let (_, auth) = header.open(password)?; // also checks password
        let res: Token = call(HTTP.post(format!("{url}/v1/enrol")).json(&json!({
            "enrollToken": enroll_token,
            "authKey": BASE64.encode(&*auth),
            "header": header,
        })))
        .await?;
        (res.token, header)
    };
    vault.with(|v| v.connect_sync(url, &token, header))?;
    sync(vault, None).await.map(|_| ())
}

/// Worker must already hold this vault. (device token, header).
async fn sign_in(
    vault: &Vault,
    url: &str,
    password: &str,
    pre: Prelogin,
) -> Result<(String, Header), String> {
    let (token, header, _) = login(url, password, pre).await?;
    if !vault.with(|v| Ok(v.same_vault(&header)))? {
        return Err(
            "This Worker already holds a different vault. Join it from a fresh install instead."
                .into(),
        );
    }
    Ok((token, header))
}

/// Re-sign-in after another device changed master password. New password then unlocks this
/// device too.
#[tauri::command]
pub async fn sync_sign_in(vault: State<'_, Vault>, password: String) -> Result<(), String> {
    sign_in_again(&vault, &password).await
}

async fn sign_in_again(vault: &Vault, password: &str) -> Result<(), String> {
    let Some((url, ..)) = vault.with(|v| v.sync_target())? else {
        return Err("Sync is not set up".into());
    };
    let pre = prelogin(&url).await?;
    let (token, header) = sign_in(vault, &url, password, pre).await?;
    vault.with(|v| v.connect_sync(url, &token, header))?;
    sync(vault, None).await.map(|_| ())
}

#[tauri::command]
pub async fn vault_join(
    app: AppHandle,
    vault: State<'_, Vault>,
    url: String,
    password: String,
    remember_device: bool,
) -> Result<(), String> {
    let path = vault::vault_path(&app)?;
    if path.exists() {
        return Err("This device already has a vault".into());
    }
    join(&vault, path, &url, &password).await?;
    vault.with(|v| {
        vault::remember(v, remember_device);
        Ok(())
    })
}

async fn join(vault: &Vault, path: PathBuf, url: &str, password: &str) -> Result<(), String> {
    let url = base_url(url)?;
    let pre = prelogin(&url).await?;
    let (token, header, wrap) = login(&url, password, pre).await?;
    vault.set(vault::join(path, header, &wrap, url, &token)?);
    sync(vault, None).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_which_side_to_update() {
        assert!(check_version(Some("1"), true).is_ok());
        assert!(check_version(Some("1"), false).is_ok());
        let old = check_version(None, true).unwrap_err();
        assert!(old.contains("Worker is out of date"));
        assert_eq!(check_version(Some("0"), false).unwrap_err(), old);
        assert!(
            check_version(Some("2"), true)
                .unwrap_err()
                .contains("Update Lynxterm")
        );
        assert!(check_version(None, false).is_ok());
    }

    #[test]
    fn plain_http_only_for_this_machine() {
        assert!(base_url("https://lynxterm-vault.you.workers.dev/").is_ok());
        assert!(base_url("http://127.0.0.1:8788").is_ok());
        assert!(base_url("http://localhost:8787").is_ok());
        for url in [
            "http://localhost.example.com",
            "http://localhost@example.com",
            "http://127.0.0.1.nip.io",
            "lynxterm-vault.you.workers.dev",
        ] {
            assert!(base_url(url).is_err(), "{url}");
        }
    }

    /// Two devices via real Worker. Needs fresh local one:
    ///   pnpm -C apps/vault-worker exec wrangler dev --port 8788 --persist-to $(mktemp -d)
    ///   LYNXTERM_TEST_WORKER=http://127.0.0.1:8788 cargo test -- --ignored
    /// (.dev.vars must set ENROLL_TOKEN=local-test-token)
    #[test]
    #[ignore]
    fn two_devices_sync_through_a_worker() {
        let url = std::env::var("LYNXTERM_TEST_WORKER").expect("set LYNXTERM_TEST_WORKER");
        let tmp = |name: &str| {
            std::env::temp_dir().join(format!("lynxterm-e2e-{name}-{}.json", std::process::id()))
        };
        let password = "correct horse battery";
        tauri::async_runtime::block_on(async {
            let a = Vault::default();
            let (mut open, code) = vault::create(tmp("a"), password, vault::FAST).unwrap();
            open.put("h1", "host", &"from A").unwrap();
            a.set(open);
            connect(&a, &url, "local-test-token", password)
                .await
                .unwrap();

            let b = Vault::default();
            join(&b, tmp("b"), &url, password).await.unwrap();
            assert_eq!(b.with(|v| v.get::<String>("h1")).unwrap(), "from A");

            b.with(|v| v.put("h2", "host", &"from B")).unwrap();
            b.with(|v| v.delete("h1")).unwrap();
            assert!(!sync(&b, None).await.unwrap(), "nothing new for B");
            assert!(sync(&a, None).await.unwrap(), "A gets B's changes");
            assert!(
                !sync(&a, None).await.unwrap(),
                "and nothing more after that"
            );
            let hosts: Vec<String> = a
                .with(|v| v.list("host"))
                .unwrap()
                .into_iter()
                .map(|(_, h)| h)
                .collect();
            assert_eq!(hosts, ["from B"]);
            assert!(a.with(|v| Ok(v.dirty())).unwrap().is_empty());

            // History not due stays local; next full sync sends it.
            b.with(|v| v.put("c1", "history", &"ls")).unwrap();
            sync(&b, Some(&["host".into()])).await.unwrap();
            assert_eq!(b.with(|v| Ok(v.dirty())).unwrap().len(), 1);
            sync(&b, None).await.unwrap();
            assert!(b.with(|v| Ok(v.dirty())).unwrap().is_empty());

            // Second enrolment refused; wrong password can't join.
            assert!(
                connect(&a, &url, "local-test-token", "wrong password!!")
                    .await
                    .is_err()
            );
            assert!(
                join(&Vault::default(), tmp("c"), &url, "wrong password!!")
                    .await
                    .is_err()
            );

            // Recovery on A changes password, signs B out until B signs in with new one.
            let new_password = "brand new password";
            let (open, auth) = vault::recover(tmp("a"), &code, new_password).unwrap();
            let (url_a, token_a, _) = open.sync_target().unwrap().unwrap();
            let header = open.header().clone();
            a.set(open);
            put_header(&url_a, &token_a, &auth, &header).await.unwrap();
            assert_eq!(sync(&b, None).await.unwrap_err(), SIGNED_OUT);
            assert!(sync(&a, None).await.is_ok(), "A stays signed in");
            assert!(
                sign_in_again(&b, password).await.is_err(),
                "the old password is out"
            );
            sign_in_again(&b, new_password).await.unwrap();
            assert!(sync(&b, None).await.is_ok());
            assert!(
                b.with(|v| v.header().open(new_password).map(|_| ()))
                    .is_ok()
            );
        });
        for name in ["a", "b"] {
            let _ = std::fs::remove_file(tmp(name));
        }
    }
}
