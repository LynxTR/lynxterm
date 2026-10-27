use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::{
    HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, check_known_hosts, known_hosts,
};
use russh::{ChannelMsg, Disconnect, client};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use crate::hosts::Host;
use crate::vault::Vault;

pub type Handle = client::Handle<Client>;

enum Input {
    Data(Vec<u8>),
    Resize(u32, u32),
}

/// Input sender plus connection, kept so SFTP can open more channels on it.
type Session = (UnboundedSender<Input>, Arc<Handle>);

#[derive(Default)]
pub struct Sessions {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Session>>,
}

impl Sessions {
    pub fn handle(&self, id: u32) -> Result<Arc<Handle>, String> {
        let open = self.open.lock().unwrap();
        open.get(&id)
            .map(|(_, handle)| handle.clone())
            .ok_or_else(|| "That session has ended".into())
    }
}

pub struct Client {
    host: String,
    port: u16,
    /// User-approved fingerprint for host not yet in known_hosts.
    trust: Option<String>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    // Known host must match ~/.ssh/known_hosts; changed key refused.
    // New host accepted only if fingerprint is the user-approved one.
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = key.public_key();
        match check_known_hosts(&self.host, self.port, &key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
                if self.trust.as_deref() != Some(fingerprint.as_str()) {
                    // Frontend reads this prefix to show "trust this host?" prompt.
                    return Err(std::io::Error::other(format!("unknown-host:{fingerprint}")).into());
                }
                known_hosts::learn_known_hosts(&self.host, self.port, &key)?;
                Ok(true)
            }
            Err(russh::keys::Error::KeyChanged { line }) => Err(russh::Error::KeyChanged { line }),
            Err(e) => Err(e.into()),
        }
    }
}

pub fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), std::env::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => path.into(),
    }
}

pub fn describe(e: russh::Error) -> String {
    match e {
        russh::Error::KeyChanged { line } => {
            format!(
                "Host key CHANGED (known_hosts line {line}). Possible attack, refusing to connect."
            )
        }
        e => e.to_string(),
    }
}

/// Connects, authenticates: password if given, else vault key.
pub async fn connect(
    vault: &Vault,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    key_id: &str,
    trust: Option<String>,
) -> Result<Handle, String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        ..Default::default()
    });
    let handler = Client {
        host: host.into(),
        port,
        trust,
    };
    let mut session = client::connect(config, (host, port), handler)
        .await
        .map_err(describe)?;

    let auth = if password.is_empty() {
        let key = crate::keys::load_key(vault, key_id)?;
        let hash = session
            .best_supported_rsa_hash()
            .await
            .map_err(describe)?
            .flatten();
        session
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
    } else {
        session.authenticate_password(user, password).await
    };
    if !auth.map_err(describe)?.success() {
        return Err("Authentication failed".into());
    }
    Ok(session)
}

/// Saved host's key must already be in known_hosts.
pub async fn connect_saved(
    vault: &Vault,
    host_id: &str,
    password: &str,
) -> Result<(Host, Handle), String> {
    let h: Host = vault.with(|v| v.get(host_id))?;
    let session = connect(vault, &h.host, h.port, &h.user, password, &h.key_id, None)
        .await
        .map_err(|e| match e.strip_prefix("unknown-host:") {
            Some(_) => "Open a terminal to this host once to trust its key first".into(),
            None => e,
        })?;
    Ok((h, session))
}

/// Returns combined output; non-zero exit is error. Script goes to `sh` on stdin, so it
/// works whatever the login shell (even fish).
pub async fn exec(session: &Handle, script: &str) -> Result<String, String> {
    let mut channel = session.channel_open_session().await.map_err(describe)?;
    channel.exec(true, "sh -s").await.map_err(describe)?;
    channel.data(script.as_bytes()).await.map_err(describe)?;
    channel.eof().await.map_err(describe)?;
    let (mut status, mut output) = (0, Vec::new());
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                output.extend_from_slice(&data)
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => status = exit_status,
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    let output = String::from_utf8_lossy(&output).into_owned();
    if status != 0 {
        return Err(format!(
            "The server said (exit {status}): {}",
            output.trim()
        ));
    }
    Ok(output)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_open(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    vault: State<'_, Vault>,
    host: String,
    port: u16,
    user: String,
    password: String,
    key_id: String,
    trust: Option<String>,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let session = connect(&vault, &host, port, &user, &password, &key_id, trust).await?;
    let mut channel = session.channel_open_session().await.map_err(describe)?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(describe)?;
    channel.request_shell(false).await.map_err(describe)?;

    let id = sessions.next.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = unbounded_channel();
    let session = Arc::new(session);
    sessions
        .open
        .lock()
        .unwrap()
        .insert(id, (tx, session.clone()));

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
              msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                  let _ = on_data.send(InvokeResponseBody::Raw(data.to_vec()));
                }
                Some(ChannelMsg::Close) | None => break,
                _ => {}
              },
              input = rx.recv() => match input {
                Some(Input::Data(bytes)) => if channel.data(&bytes[..]).await.is_err() { break },
                Some(Input::Resize(c, r)) => { let _ = channel.window_change(c, r, 0, 0).await; }
                None => break,
              },
            }
        }
        // Empty frame tells frontend session ended.
        let _ = on_data.send(InvokeResponseBody::Raw(Vec::new()));
        let _ = session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        app.state::<Sessions>().open.lock().unwrap().remove(&id);
    });

    Ok(id)
}

fn send(sessions: &Sessions, id: u32, input: Input) {
    if let Some((tx, _)) = sessions.open.lock().unwrap().get(&id) {
        let _ = tx.send(input);
    }
}

#[tauri::command]
pub fn ssh_write(sessions: State<'_, Sessions>, id: u32, data: String) {
    send(&sessions, id, Input::Data(data.into_bytes()));
}

#[tauri::command]
pub fn ssh_resize(sessions: State<'_, Sessions>, id: u32, cols: u32, rows: u32) {
    send(&sessions, id, Input::Resize(cols, rows));
}

#[tauri::command]
pub fn ssh_close(sessions: State<'_, Sessions>, id: u32) {
    // Dropping sender ends session loop, which disconnects.
    sessions.open.lock().unwrap().remove(&id);
}
