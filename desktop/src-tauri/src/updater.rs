use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::blocking::{Client, Response};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

const RELEASES_URL: &str = "https://github.com/cyhddyx/simultaneous-translator/releases";
const RELEASES_API: &str =
    "https://api.github.com/repos/cyhddyx/simultaneous-translator/releases?per_page=100";
const LATEST_API: &str =
    "https://api.github.com/repos/cyhddyx/simultaneous-translator/releases/latest";
const MAX_RELEASES_JSON: u64 = 4 * 1024 * 1024;
const MAX_INSTALLER_SIZE: u64 = 512 * 1024 * 1024;

#[derive(Clone, Deserialize)]
struct Asset {
    name: String,
    size: u64,
    browser_download_url: String,
}

#[derive(Clone, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    version: String,
    tag: String,
    title: String,
    notes: String,
    published_at: Option<String>,
    prerelease: bool,
    available: bool,
    download_available: bool,
    size: u64,
}

#[derive(Clone)]
struct PreparedUpdate {
    path: PathBuf,
    sha256: String,
}

#[derive(Default)]
struct UpdateData {
    release: Option<Release>,
    prepared: Option<PreparedUpdate>,
}

#[derive(Default)]
pub struct UpdateState(Arc<Mutex<UpdateData>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    tag: String,
    downloaded: u64,
    total: u64,
}

fn release_version(tag: &str) -> Option<Version> {
    let version = tag
        .strip_prefix("beta")
        .or_else(|| tag.strip_prefix('v'))
        .unwrap_or(tag);
    Version::parse(version).ok()
}

fn latest_release(releases: Vec<Release>) -> Option<Release> {
    releases
        .into_iter()
        .filter(|release| !release.draft)
        .filter_map(|release| release_version(&release.tag_name).map(|version| (version, release)))
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, release)| release)
}

/// Windows 安装包在发布页里的候选文件名。
///
/// 新命名带平台标记（`_windows_x64-setup.exe`），与 Linux 资产（`_linux_amd64.*`）一致，
/// 下载页一眼能看出系统；同时接受旧命名 `_x64-setup.exe`，兼容历史 Release 与旧版更新器。
fn installer_names(release: &Release) -> Vec<String> {
    let version = release_version(&release.tag_name).unwrap();
    vec![
        format!("simultaneous-translator_{version}_windows_x64-setup.exe"),
        format!("simultaneous-translator_{version}_x64-setup.exe"),
    ]
}

/// 实际可下载的 Windows 安装包：新命名优先，旧命名兜底。
fn installer_asset<'a>(release: &'a Release) -> Option<(&'a Asset, String)> {
    installer_names(release)
        .into_iter()
        .find_map(|name| release_asset(release, &name).map(|asset| (asset, name)))
}

fn release_asset<'a>(release: &'a Release, name: &str) -> Option<&'a Asset> {
    release.assets.iter().find(|asset| {
        asset.name == name
            && asset.size > 0
            && asset.size <= MAX_INSTALLER_SIZE
            && Url::parse(&asset.browser_download_url).is_ok_and(|url| {
                url.scheme() == "https"
                    && url.host_str() == Some("github.com")
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.port().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && url.path()
                        == format!(
                            "/cyhddyx/simultaneous-translator/releases/download/{}/{name}",
                            release.tag_name
                        )
            })
    })
}

fn update_info(release: &Release, current: &str) -> UpdateInfo {
    let version = release_version(&release.tag_name).unwrap();
    let installer = installer_asset(release).map(|(asset, _)| asset);
    UpdateInfo {
        current_version: current.into(),
        available: Version::parse(current).is_ok_and(|current| version > current),
        version: version.to_string(),
        tag: release.tag_name.clone(),
        title: release
            .name
            .clone()
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| release.tag_name.clone()),
        notes: release.body.clone().unwrap_or_default(),
        published_at: release.published_at.clone(),
        prerelease: release.prerelease,
        download_available: installer.is_some()
            && release_asset(release, "SHA256SUMS.txt").is_some(),
        size: installer.map_or(0, |asset| asset.size),
    }
}

fn client() -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!(
            "simultaneous-translator/",
            env!("CARGO_PKG_VERSION")
        ))
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|error| format!("无法连接 GitHub：{error}"))
}

fn request(client: &Client, url: &str, timeout: Duration) -> Result<Response, String> {
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .timeout(timeout)
        .send()
        .map_err(|error| format!("连接 GitHub 失败，请检查网络后重试：{error}"))?;
    match response.status().as_u16() {
        200 => Ok(response),
        403 | 429 => Err("GitHub 暂时限制了请求次数，请稍后重试。".into()),
        status => Err(format!("GitHub 请求失败（HTTP {status}），请稍后重试。")),
    }
}

fn read_limited(mut response: Response, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取 GitHub 数据失败：{error}"))?;
    if bytes.len() as u64 > limit {
        return Err("GitHub 返回的数据超过大小限制。".into());
    }
    Ok(bytes)
}

fn fetch_releases(client: &Client) -> Result<Vec<Release>, String> {
    let bytes = read_limited(
        request(client, RELEASES_API, Duration::from_secs(30))?,
        MAX_RELEASES_JSON,
    )?;
    serde_json::from_slice(&bytes).map_err(|error| format!("无法解析 GitHub 版本信息：{error}"))
}

/// 单版本接口，作为列表接口的兜底。
///
/// 未认证请求在共享出口 IP 上容易命中限流和边缘缓存，列表接口会直接返回空数组；
/// 单版本接口命中同一份异常缓存时仍可能返回数据。404 表示仓库确实没有已发布的
/// 正式版本，按「没有可安装版本」处理。
fn fetch_latest(client: &Client) -> Result<Option<Release>, String> {
    let response = client
        .get(LATEST_API)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(30))
        .send()
        .map_err(|error| format!("连接 GitHub 失败，请检查网络后重试：{error}"))?;
    match response.status().as_u16() {
        200 => {}
        404 => return Ok(None),
        403 | 429 => return Err("GitHub 暂时限制了请求次数，请稍后重试。".into()),
        status => return Err(format!("GitHub 请求失败（HTTP {status}），请稍后重试。")),
    }
    let bytes = read_limited(response, MAX_RELEASES_JSON)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("无法解析 GitHub 版本信息：{error}"))
}

/// 选定最新版本：列表接口为空时重试一次，再退化到单版本接口。
///
/// 空列表不能直接当成「尚未发布」：GitHub 的未认证接口会被出口 IP 限流，边缘缓存
/// 也曾返回与仓库无关的空数组。只有在两个接口都拿不到版本时才报错，并把原因说清楚。
fn resolve_release(client: &Client) -> Result<Release, String> {
    for attempt in 0..2 {
        if let Some(release) = latest_release(fetch_releases(client)?) {
            return Ok(release);
        }
        if attempt == 0 {
            std::thread::sleep(Duration::from_millis(600));
        }
    }
    if let Some(release) = fetch_latest(client)? {
        return Ok(release);
    }
    Err("GitHub 返回了空的版本列表，暂时无法判断是否有更新，请稍后重试。".into())
}

fn checksum_for(text: &str, name: &str) -> Result<String, String> {
    let matches: Vec<_> = text
        .lines()
        .filter_map(|line| {
            let (hash, filename) = line.split_once(char::is_whitespace)?;
            (filename.trim().trim_start_matches('*') == name).then_some(hash)
        })
        .collect();
    if matches.len() != 1
        || matches[0].len() != 64
        || !matches[0].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("发布文件缺少有效的 SHA-256 校验值，无法安装。".into());
    }
    Ok(matches[0].to_ascii_lowercase())
}

fn verify_file(path: &PathBuf, expected: &str) -> Result<(), String> {
    let mut file = File::open(path).map_err(|error| format!("无法读取安装包：{error}"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|error| format!("读取安装包失败：{error}"))?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err("安装包 SHA-256 校验失败，请重新下载。".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateInfo, String> {
    let data = Arc::clone(&state.0);
    let current = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut data = data
            .try_lock()
            .map_err(|_| "更新任务正在进行，请稍候。".to_string())?;
        let release = resolve_release(&client()?)?;
        let info = update_info(&release, &current);
        if data.release.as_ref().map(|release| &release.tag_name) != Some(&release.tag_name) {
            data.prepared = None;
        }
        data.release = Some(release);
        Ok(info)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn download_app_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    let data = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let mut data = data
            .try_lock()
            .map_err(|_| "更新任务正在进行，请稍候。".to_string())?;
        data.prepared = None;
        let release = data.release.as_ref().ok_or("请先检查更新。")?;
        if !update_info(release, &app.package_info().version.to_string()).available {
            return Err("当前已是最新版本。".into());
        }
        let (asset, name) = installer_asset(release).ok_or("此版本尚未提供 Windows 安装包。")?;
        let sums = release_asset(release, "SHA256SUMS.txt").ok_or("此版本缺少校验文件。")?;
        let client = client()?;
        let bytes = read_limited(
            request(&client, &sums.browser_download_url, Duration::from_secs(30))?,
            64 * 1024,
        )?;
        let sha256 = checksum_for(
            std::str::from_utf8(&bytes).map_err(|_| "校验文件编码无效。")?,
            &name,
        )?;
        let directory = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?
            .join("updates");
        fs::create_dir_all(&directory).map_err(|error| format!("无法创建下载目录：{error}"))?;
        let path = directory.join(&name);
        let partial = directory.join(format!("{name}.part"));
        let result = (|| -> Result<(), String> {
            let mut response = request(
                &client,
                &asset.browser_download_url,
                Duration::from_secs(600),
            )?;
            let mut file =
                File::create(&partial).map_err(|error| format!("无法保存安装包：{error}"))?;
            let mut downloaded = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            let mut last_progress = Instant::now();
            let mut hash = Sha256::new();
            loop {
                let size = response
                    .read(&mut buffer)
                    .map_err(|error| format!("下载中断，请重试：{error}"))?;
                if size == 0 {
                    break;
                }
                downloaded += size as u64;
                if downloaded > asset.size {
                    return Err("安装包大小与发布信息不符。".into());
                }
                file.write_all(&buffer[..size])
                    .map_err(|error| format!("保存安装包失败：{error}"))?;
                hash.update(&buffer[..size]);
                if last_progress.elapsed() >= Duration::from_millis(200) || downloaded == asset.size
                {
                    let _ = app.emit_to(
                        "main",
                        "app-update-progress",
                        DownloadProgress {
                            tag: release.tag_name.clone(),
                            downloaded,
                            total: asset.size,
                        },
                    );
                    last_progress = Instant::now();
                }
            }
            if downloaded != asset.size || format!("{:x}", hash.finalize()) != sha256 {
                return Err("安装包 SHA-256 校验失败，请重新下载。".into());
            }
            file.sync_all()
                .map_err(|error| format!("保存安装包失败：{error}"))?;
            drop(file);
            if path.exists() {
                fs::remove_file(&path).map_err(|error| error.to_string())?;
            }
            fs::rename(&partial, &path).map_err(|error| error.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&partial);
        }
        result?;
        data.prepared = Some(PreparedUpdate { path, sha256 });
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

// Wait for the native quit path to finish before NSIS replaces the running binaries.
fn install_script(path: &std::path::Path, pid: u32) -> String {
    let path = path.to_string_lossy().replace('\'', "''");
    format!("$ErrorActionPreference = 'Stop'; Wait-Process -Id {pid} -Timeout 30 -ErrorAction SilentlyContinue; if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }}; Start-Process -FilePath '{path}'")
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    let data = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let data = data
            .try_lock()
            .map_err(|_| "更新任务正在进行，请稍候。".to_string())?;
        let prepared = data.prepared.as_ref().ok_or("请先下载更新。")?;
        verify_file(&prepared.path, &prepared.sha256)?;
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &install_script(&prepared.path, std::process::id()),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command
            .spawn()
            .map_err(|error| format!("无法启动安装程序：{error}"))?;
        Ok::<_, String>(())
    })
    .await
    .map_err(|error| error.to_string())??;
    crate::tray::dispatch_native_action(app, crate::tray::RuntimeAction::QuitApplication).await?;
    Ok(())
}

#[tauri::command]
pub fn open_app_releases() -> Result<(), String> {
    let mut command = Command::new("rundll32.exe");
    command.args(["url.dll,FileProtocolHandler", RELEASES_URL]);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .spawn()
        .map_err(|error| format!("无法打开 GitHub：{error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str) -> Release {
        Release {
            tag_name: tag.into(),
            name: None,
            body: None,
            published_at: None,
            draft: false,
            prerelease: true,
            assets: vec![],
        }
    }

    #[test]
    fn compares_beta_tags_numerically_and_never_downgrades() {
        let selected = latest_release(vec![
            release("beta0.5.9"),
            release("beta0.5.10"),
            release("v0.5.2"),
        ])
        .unwrap();
        assert_eq!(selected.tag_name, "beta0.5.10");
        assert!(update_info(&selected, "0.5.2").available);
        assert!(!update_info(&release("beta0.5.2"), "0.5.2").available);
        assert!(!update_info(&release("beta0.5.1"), "0.5.2").available);
        assert!(!update_info(&release("v0.6.0-rc.1"), "0.6.0").available);
    }

    #[test]
    fn ignores_drafts_and_invalid_tags_but_includes_prereleases() {
        let mut draft = release("beta9.0.0");
        draft.draft = true;
        assert_eq!(
            latest_release(vec![draft, release("nightly"), release("beta0.5.2")])
                .unwrap()
                .tag_name,
            "beta0.5.2"
        );
        assert!(latest_release(vec![release("../0.5.2"), release("nightly")]).is_none());
    }

    #[test]
    fn limits_installers_to_the_release_in_the_configured_repository() {
        let mut selected = release("beta0.5.3");
        let name = installer_names(&selected).remove(0);
        selected.assets.push(Asset {
            name: name.clone(),
            size: 10,
            browser_download_url: format!("{RELEASES_URL}/download/beta0.5.3/{name}"),
        });
        assert!(release_asset(&selected, &name).is_some());
        selected.assets[0].browser_download_url = format!("https://example.com/{name}");
        assert!(release_asset(&selected, &name).is_none());
        selected.assets[0].browser_download_url =
            format!("{RELEASES_URL}/download/beta0.5.2/{name}");
        assert!(release_asset(&selected, &name).is_none());
    }

    #[test]
    fn accepts_legacy_unlabeled_installer_names() {
        let mut selected = release("v1.0.2");
        selected.assets.push(Asset {
            name: "simultaneous-translator_1.0.2_x64-setup.exe".into(),
            size: 10,
            browser_download_url:
                "https://github.com/cyhddyx/simultaneous-translator/releases/download/v1.0.2/simultaneous-translator_1.0.2_x64-setup.exe".into(),
        });
        selected.assets.push(Asset {
            name: "SHA256SUMS.txt".into(),
            size: 10,
            browser_download_url:
                "https://github.com/cyhddyx/simultaneous-translator/releases/download/v1.0.2/SHA256SUMS.txt".into(),
        });
        let (_, name) = installer_asset(&selected).expect("legacy installer name should match");
        assert_eq!(name, "simultaneous-translator_1.0.2_x64-setup.exe");
        assert!(update_info(&selected, "1.0.1").download_available);
    }

    #[test]
    fn validates_exact_checksum_filename_and_rejects_ambiguity() {
        let hash = "ab".repeat(32);
        assert_eq!(
            checksum_for(&format!("{hash}  setup.exe\r\n"), "setup.exe").unwrap(),
            hash
        );
        assert_eq!(
            checksum_for(&format!("{hash} *setup.exe\n"), "setup.exe").unwrap(),
            hash
        );
        assert!(checksum_for(&format!("{hash}  other.exe"), "setup.exe").is_err());
        assert!(checksum_for("invalid  setup.exe", "setup.exe").is_err());
        assert!(checksum_for(
            &format!("{hash}  setup.exe\n{hash}  setup.exe"),
            "setup.exe"
        )
        .is_err());
    }

    #[test]
    fn detects_modified_installer_and_quotes_paths_for_powershell() {
        let path =
            std::env::temp_dir().join(format!("translator-update-test-{}", uuid::Uuid::new_v4()));
        fs::write(&path, b"verified package").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"verified package"));
        assert!(verify_file(&path, &hash).is_ok());
        fs::write(&path, b"modified package").unwrap();
        assert!(verify_file(&path, &hash).is_err());
        fs::remove_file(&path).unwrap();
        let script = install_script(std::path::Path::new("C:/Users/O'Brien/setup.exe"), 123);
        assert!(script.contains("Wait-Process -Id 123"));
        assert!(script.contains("'C:/Users/O''Brien/setup.exe'"));
    }

    #[test]
    #[ignore = "queries the public GitHub releases API"]
    fn checks_real_github_releases() {
        let bytes = read_limited(
            request(&client().unwrap(), RELEASES_API, Duration::from_secs(30)).unwrap(),
            4 * 1024 * 1024,
        )
        .unwrap();
        let selected = latest_release(serde_json::from_slice(&bytes).unwrap()).unwrap();
        assert!(update_info(&selected, "0.0.0").download_available);
        let sums = release_asset(&selected, "SHA256SUMS.txt").unwrap();
        let bytes = read_limited(
            request(
                &client().unwrap(),
                &sums.browser_download_url,
                Duration::from_secs(30),
            )
            .unwrap(),
            64 * 1024,
        )
        .unwrap();
        let (_, installer_name) = installer_asset(&selected).unwrap();
        assert!(checksum_for(
            std::str::from_utf8(&bytes).unwrap(),
            &installer_name
        )
        .is_ok());
    }
}
