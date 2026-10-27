//! SFTP over open terminal session's connection.

use std::path::{Path, PathBuf};

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::err;
use crate::ssh::{Sessions, describe};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    name: String,
    is_dir: bool,
    size: u64,
}

#[derive(Serialize)]
pub struct Listing {
    path: String,
    entries: Vec<Entry>,
}

// fresh SFTP channel per call; cache one per session if browsing feels slow.
async fn open(sessions: &Sessions, id: u32) -> Result<SftpSession, String> {
    let channel = sessions
        .handle(id)?
        .channel_open_session()
        .await
        .map_err(describe)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(describe)?;
    SftpSession::new(channel.into_stream()).await.map_err(err)
}

fn join(dir: &str, name: &str) -> String {
    format!("{}/{name}", dir.trim_end_matches('/'))
}

/// First free path in `dir`: name, name-1, name-2…
pub fn free_path(dir: &Path, name: &str) -> PathBuf {
    (0..)
        .map(|n| {
            dir.join(if n == 0 {
                name.to_string()
            } else {
                format!("{name}-{n}")
            })
        })
        .find(|p| !p.exists())
        .unwrap()
}

/// Empty `path`: login directory.
#[tauri::command]
pub async fn sftp_list(
    sessions: State<'_, Sessions>,
    id: u32,
    path: String,
) -> Result<Listing, String> {
    let sftp = open(&sessions, id).await?;
    let path = sftp
        .canonicalize(if path.is_empty() { "." } else { &path })
        .await
        .map_err(err)?;
    let mut entries = Vec::new();
    for e in sftp.read_dir(path.clone()).await.map_err(err)? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let mut is_dir = e.file_type().is_dir();
        // Symlink to folder (like /bin) opens as folder; STAT follows links.
        if e.file_type().is_symlink() {
            is_dir = sftp
                .metadata(join(&path, &name))
                .await
                .is_ok_and(|m| m.file_type().is_dir());
        }
        entries.push(Entry {
            name,
            is_dir,
            size: e.metadata().size.unwrap_or(0),
        });
    }
    entries.sort_by_key(|e| (!e.is_dir, e.name.to_lowercase()));
    Ok(Listing { path, entries })
}

/// Saves into Downloads folder; returns local path.
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    id: u32,
    path: String,
) -> Result<String, String> {
    // Name comes from server: plain file name only, no path tricks.
    let name: String = path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() && !"/\\:".contains(*c))
        .collect();
    let name = if name.is_empty() || name == "." || name == ".." {
        "download".into()
    } else {
        name
    };

    let sftp = open(&sessions, id).await?;
    let mut remote = sftp.open(path).await.map_err(err)?;
    let dir = app.path().download_dir().map_err(err)?;
    let target = free_path(&dir, &name);
    let mut local = tokio::fs::File::create_new(&target).await.map_err(err)?;
    tokio::io::copy(&mut remote, &mut local)
        .await
        .map_err(err)?;
    Ok(target.display().to_string())
}

#[tauri::command]
pub async fn sftp_upload(
    sessions: State<'_, Sessions>,
    id: u32,
    local: String,
    dir: String,
) -> Result<(), String> {
    let local = PathBuf::from(local);
    if local.is_dir() {
        return Err("Folders can't be uploaded yet, only files".into());
    }
    let name = local
        .file_name()
        .ok_or("Not a file")?
        .to_string_lossy()
        .into_owned();
    let mut file = tokio::fs::File::open(&local).await.map_err(err)?;
    let sftp = open(&sessions, id).await?;
    let mut remote = sftp.create(join(&dir, &name)).await.map_err(err)?;
    tokio::io::copy(&mut file, &mut remote).await.map_err(err)?;
    remote.shutdown().await.map_err(err)
}
