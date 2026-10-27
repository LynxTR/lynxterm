//! First-run helpers: ~/.ssh/config hosts, sign-up page in browser. Also GitHub
//! newer-release check.

use std::{fs, process::Command};

use serde::{Deserialize, Serialize};

use crate::err;
use crate::ssh::expand_home;
use crate::sync::HTTP;

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    /// `Host` alias.
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// `~/.ssh/...` as written, or empty.
    pub identity_file: String,
}

/// Concrete `Host` entries in ~/.ssh/config (no wildcards), `Host *` defaults filled in.
/// Skips `Match` and `Include` blocks.
#[tauri::command]
pub fn ssh_config_hosts() -> Vec<ConfigHost> {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    fs::read_to_string(expand_home("~/.ssh/config"))
        .map(|text| parse(&text, &user))
        .unwrap_or_default()
}

pub(crate) fn parse(text: &str, default_user: &str) -> Vec<ConfigHost> {
    #[derive(Default, Clone)]
    struct Block {
        aliases: Vec<String>,
        wildcard: bool,
        host: String,
        port: Option<u16>,
        user: String,
        identity_file: String,
    }
    let mut blocks: Vec<Block> = vec![];
    let mut skipping = false; // inside Match block
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line
            .split_once(|c: char| c.is_whitespace() || c == '=')
            .map_or((line, ""), |(k, v)| {
                (k, v.trim_start_matches(['=', ' ', '\t']).trim())
            });
        let value = value.trim_matches('"');
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                skipping = false;
                let all: Vec<&str> = value.split_whitespace().collect();
                blocks.push(Block {
                    wildcard: all.contains(&"*"),
                    aliases: all
                        .into_iter()
                        .filter(|a| !a.contains(['*', '?', '!']))
                        .map(String::from)
                        .collect(),
                    ..Block::default()
                });
            }
            "match" => skipping = true,
            _ if skipping => {}
            key => {
                let Some(b) = blocks.last_mut() else { continue };
                // ssh: first value per option wins.
                match key {
                    "hostname" if b.host.is_empty() => b.host = value.into(),
                    "user" if b.user.is_empty() => b.user = value.into(),
                    "port" if b.port.is_none() => b.port = value.parse().ok(),
                    "identityfile" if b.identity_file.is_empty() => b.identity_file = value.into(),
                    _ => {}
                }
            }
        }
    }
    let defaults = blocks
        .iter()
        .find(|b| b.wildcard)
        .cloned()
        .unwrap_or_default();
    let or = |a: &str, b: &str| (if a.is_empty() { b } else { a }).to_string();
    blocks
        .iter()
        .filter(|b| !b.wildcard)
        .flat_map(|b| {
            b.aliases.iter().map(|alias| ConfigHost {
                name: alias.clone(),
                host: or(&b.host, alias),
                port: b.port.or(defaults.port).unwrap_or(22),
                user: or(&b.user, &or(&defaults.user, default_user)),
                identity_file: or(&b.identity_file, &defaults.identity_file),
            })
        })
        .collect()
}

const REPO: &str = "LynxTR/lynxterm";

#[derive(Serialize)]
pub struct UpdateCheck {
    system: String,
    latest: Option<Release>,
}

#[derive(Serialize)]
pub struct Release {
    version: String,
    url: String,
    /// Installer for this computer, if release has one.
    download: Option<Download>,
}

#[derive(Serialize)]
pub struct Download {
    name: String,
    url: String,
    /// "AppImage", ".deb package", "disk image", "installer"…
    kind: String,
}

/// "Linux, x86_64", "macOS, Apple silicon", "Windows, x86_64".
fn system() -> String {
    use std::env::consts::{ARCH, OS};
    let os = match OS {
        "linux" => "Linux",
        "macos" => "macOS",
        "windows" => "Windows",
        other => other,
    };
    let arch = match (OS, ARCH) {
        ("macos", "aarch64") => "Apple silicon",
        ("macos", "x86_64") => "Intel",
        (_, arch) => arch,
    };
    format!("{os}, {arch}")
}

/// Linux format to offer: AppImage if running from one, else system package format.
fn linux_format() -> &'static str {
    if std::env::var_os("APPIMAGE").is_some() {
        "appimage"
    } else if std::path::Path::new("/usr/bin/dpkg").exists() {
        "deb"
    } else if std::path::Path::new("/usr/bin/rpm").exists() {
        "rpm"
    } else {
        "appimage"
    }
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// Matching installer among release assets.
fn pick(assets: &[Asset], os: &str, arch: &str, linux: &str) -> Option<Download> {
    let arch_names: &[&str] = match arch {
        "aarch64" => &["aarch64", "arm64"],
        _ => &["x86_64", "amd64", "x64"],
    };
    let wanted: &[(&str, &str)] = match (os, linux) {
        ("macos", _) => &[(".dmg", "disk image")],
        ("windows", _) => &[("-setup.exe", "installer"), (".msi", "installer")],
        (_, "deb") => &[(".deb", ".deb package"), (".AppImage", "AppImage")],
        (_, "rpm") => &[(".rpm", ".rpm package"), (".AppImage", "AppImage")],
        _ => &[(".AppImage", "AppImage")],
    };
    wanted.iter().find_map(|(suffix, kind)| {
        assets
            .iter()
            .find(|a| a.name.ends_with(suffix) && arch_names.iter().any(|n| a.name.contains(n)))
            .map(|a| Download {
                name: a.name.clone(),
                url: a.browser_download_url.clone(),
                kind: kind.to_string(),
            })
    })
}

/// Newest GitHub release (no drafts, no pre-releases), with installer for this computer.
/// UI compares versions.
#[tauri::command]
pub async fn latest_release() -> Result<UpdateCheck, String> {
    #[derive(Deserialize)]
    struct GitHub {
        tag_name: String,
        html_url: String,
        #[serde(default)]
        assets: Vec<Asset>,
    }
    let system = system();
    let res = HTTP
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases/latest"
        ))
        .header("User-Agent", "Lynxterm") // GitHub refuses requests without one
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(err)?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(UpdateCheck {
            system,
            latest: None,
        }); // nothing published yet
    }
    let release: GitHub = res
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    let download = pick(
        &release.assets,
        std::env::consts::OS,
        std::env::consts::ARCH,
        linux_format(),
    );
    Ok(UpdateCheck {
        system,
        latest: Some(Release {
            version: release.tag_name.trim_start_matches('v').to_string(),
            url: release.html_url,
            download,
        }),
    })
}

/// Opens allowlisted https pages only, in default browser; anything else refused.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    const ALLOWED: [&str; 3] = [
        "https://deploy.workers.cloudflare.com/",
        "https://dash.cloudflare.com/",
        "https://github.com/",
    ];
    if !ALLOWED.iter().any(|p| url.starts_with(p)) || url.contains(['"', '\n', ' ']) {
        return Err("Not a page Lynxterm opens".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = Command::new("xdg-open");
    cmd.arg(&url).spawn().map(drop).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::{Asset, ConfigHost, parse, pick};

    #[test]
    fn picks_the_installer_for_this_system() {
        let files: Vec<Asset> = [
            "Lynxterm_0.2.0_aarch64.dmg",
            "Lynxterm_0.2.0_x64.dmg",
            "Lynxterm_0.2.0_x64-setup.exe",
            "Lynxterm_0.2.0_x64_en-US.msi",
            "Lynxterm_0.2.0_amd64.deb",
            "Lynxterm-0.2.0-1.x86_64.rpm",
            "Lynxterm_0.2.0_amd64.AppImage",
            "Lynxterm_0.2.0_amd64.AppImage.tar.gz",
        ]
        .iter()
        .map(|n| Asset {
            name: n.to_string(),
            browser_download_url: format!("https://github.com/x/{n}"),
        })
        .collect();
        let name = |os, arch, linux| pick(&files, os, arch, linux).map(|d| d.name);
        assert_eq!(
            name("macos", "aarch64", "").as_deref(),
            Some("Lynxterm_0.2.0_aarch64.dmg")
        );
        assert_eq!(
            name("macos", "x86_64", "").as_deref(),
            Some("Lynxterm_0.2.0_x64.dmg")
        );
        assert_eq!(
            name("windows", "x86_64", "").as_deref(),
            Some("Lynxterm_0.2.0_x64-setup.exe")
        );
        assert_eq!(
            name("linux", "x86_64", "deb").as_deref(),
            Some("Lynxterm_0.2.0_amd64.deb")
        );
        assert_eq!(
            name("linux", "x86_64", "rpm").as_deref(),
            Some("Lynxterm-0.2.0-1.x86_64.rpm")
        );
        assert_eq!(
            name("linux", "x86_64", "appimage").as_deref(),
            Some("Lynxterm_0.2.0_amd64.AppImage")
        );
        // no arm64 Linux build: nothing, not wrong file
        assert_eq!(name("linux", "aarch64", "deb"), None);
    }

    #[test]
    fn reads_hosts_with_wildcard_defaults() {
        let hosts = parse(
            "# mine\n\
             Host web web-alias\n\
             \tHostName 10.0.4.21\n\
             \tUser deploy\n\
             \tIdentityFile ~/.ssh/deploy\n\
             Host db\n\
             \tHostName=10.0.4.30\n\
             \tPort 2222\n\
             Match host *.internal\n\
             \tUser nobody\n\
             Host bare\n\
             Host *.example *\n\
             \tUser ops\n\
             \tIdentityFile ~/.ssh/id_ed25519\n",
            "me",
        );
        let web = ConfigHost {
            name: "web".into(),
            host: "10.0.4.21".into(),
            port: 22,
            user: "deploy".into(),
            identity_file: "~/.ssh/deploy".into(),
        };
        assert_eq!(hosts[0], web);
        assert_eq!(hosts[1].name, "web-alias");
        assert_eq!(hosts[2].port, 2222);
        assert_eq!(hosts[2].user, "ops");
        assert_eq!(hosts[2].identity_file, "~/.ssh/id_ed25519");
        assert_eq!(hosts[3].host, "bare");
        assert_eq!(hosts.len(), 4);
    }
}
