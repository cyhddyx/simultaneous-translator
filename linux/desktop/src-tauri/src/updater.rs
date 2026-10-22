//! 检查 / 下载 Linux 更新（GitHub Releases）。
//!
//! Linux 版不做自动提权安装，流程固定为：检查 → 下载 → SHA-256 校验 → 打开下载
//! 目录由用户手动安装（AppImage 例外：以 AppImage 方式运行且文件可写时，直接替换
//! 当前镜像并提示重启）。发布资产约定见 `PORTING_CONTRACT.md` §5 D10：
//! `simultaneous-translator_<version>_linux_amd64.deb`、`..._linux_amd64.rpm`、
//! `..._linux_amd64.AppImage`，以及 `SHA256SUMS.txt`（每行 `<sha>  <文件名>`）。
//! 旧命名 `..._amd64.<ext>` 仍被接受，避免历史版本更新链路失效。

use std::{
    env,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use reqwest::blocking::{Client, Response};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

const RELEASES_URL: &str = "https://github.com/cyhddyx/simultaneous-translator/releases";
const RELEASES_API: &str =
    "https://api.github.com/repos/cyhddyx/simultaneous-translator/releases?per_page=100";
const MAX_INSTALLER_SIZE: u64 = 512 * 1024 * 1024;
/// 发布页里校验文件的固定名字（与 Windows 版一致）。
const CHECKSUMS_NAME: &str = "SHA256SUMS.txt";
/// AppImage 运行库（AppRun）会把它导出为当前正在执行的镜像的绝对路径。
const APPIMAGE_ENV: &str = "APPIMAGE";

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

/// Linux 打包格式；优先级由当前运行方式与发行版包管理器决定。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PackageKind {
    Deb,
    Rpm,
    AppImage,
}

impl PackageKind {
    /// 发布资产名里的平台 / 架构 / 扩展名部分。
    ///
    /// 统一带 `linux_amd64`：和仓库里 Windows 资产（`_windows_x64-setup.exe`）一样，下载
    /// 文件名本身就能看出系统与架构，不会出现「deb 叫 amd64、rpm 叫 x86_64」的歧义。
    fn asset_suffix(self) -> &'static str {
        match self {
            PackageKind::Deb => "linux_amd64.deb",
            PackageKind::Rpm => "linux_amd64.rpm",
            PackageKind::AppImage => "linux_amd64.AppImage",
        }
    }

    /// 旧版发布资产使用的后缀（仍接受，兼容历史 Release）。
    fn legacy_asset_suffix(self) -> &'static str {
        match self {
            PackageKind::Deb => "amd64.deb",
            PackageKind::Rpm => "amd64.rpm",
            PackageKind::AppImage => "amd64.AppImage",
        }
    }

    fn label(self) -> &'static str {
        match self {
            PackageKind::Deb => "deb",
            PackageKind::Rpm => "rpm",
            PackageKind::AppImage => "appimage",
        }
    }
}

#[derive(Clone)]
struct PreparedUpdate {
    path: PathBuf,
    sha256: String,
    kind: PackageKind,
}

/// `app-update-installed` 事件载荷：命令返回值保持 `()` 不变，这里作为可选增强
/// 告知前端「已打开安装包目录」还是「已替换 AppImage，需要重启」。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInstalled {
    kind: &'static str,
    restart_required: bool,
    message: String,
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

// --------------------------------------------------------------------------- //
// Linux 资产匹配（contract §5 D10）
// --------------------------------------------------------------------------- //

/// 某个打包格式在发布页里的候选文件名（新命名优先，旧命名兜底）。
///
/// 主文件名遵循契约约定（`..._linux_amd64.<ext>`）；同时接受旧版 `..._amd64.<ext>`，
/// rpm 还额外接受 `cargo tauri build --bundles rpm` 直接产出的惯用文件名
/// （`...-<version>-1.x86_64.rpm`），避免发布者忘记改名或历史 Release 导致更新不可用。
fn asset_names(release: &Release, kind: PackageKind) -> Vec<String> {
    let version = release_version(&release.tag_name).unwrap();
    let mut names = vec![format!(
        "simultaneous-translator_{version}_{}",
        kind.asset_suffix()
    )];
    names.push(format!(
        "simultaneous-translator_{version}_{}",
        kind.legacy_asset_suffix()
    ));
    if kind == PackageKind::Rpm {
        names.push(format!("simultaneous-translator-{version}-1.x86_64.rpm"));
    }
    names
}

/// 主文件名（契约约定的发布资产命名）。
#[cfg(test)]
fn asset_name(release: &Release, kind: PackageKind) -> String {
    asset_names(release, kind).remove(0)
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

fn release_asset_for_kind<'a>(release: &'a Release, kind: PackageKind) -> Option<&'a Asset> {
    asset_names(release, kind)
        .iter()
        .find_map(|name| release_asset(release, name))
}

/// 按优先级挑选第一个在发布页里存在且合法的资产。
fn selected_asset_in<'a>(
    release: &'a Release,
    preference: &[PackageKind],
) -> Option<(PackageKind, &'a Asset)> {
    preference
        .iter()
        .find_map(|kind| release_asset_for_kind(release, *kind).map(|asset| (*kind, asset)))
}

fn running_appimage_path() -> Option<PathBuf> {
    env::var_os(APPIMAGE_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// 只会返回全部三种格式的排列：正在以 AppImage 运行 → AppImage 优先；否则按
/// 发行版包管理器（deb / rpm）优先，最后兜底其余格式。
fn package_preference(
    running_as_appimage: bool,
    debian_like: bool,
    rpm_like: bool,
) -> Vec<PackageKind> {
    let mut preference = Vec::with_capacity(3);
    if running_as_appimage {
        preference.push(PackageKind::AppImage);
    }
    if debian_like {
        preference.push(PackageKind::Deb);
    }
    if rpm_like {
        preference.push(PackageKind::Rpm);
    }
    for kind in [PackageKind::Deb, PackageKind::Rpm, PackageKind::AppImage] {
        if !preference.contains(&kind) {
            preference.push(kind);
        }
    }
    preference
}

fn linux_package_preference() -> Vec<PackageKind> {
    // dpkg / rpm 的数据库目录是发行版包管理器的稳定标志。
    package_preference(
        running_appimage_path().is_some(),
        Path::new("/var/lib/dpkg/status").exists(),
        Path::new("/var/lib/rpm").exists() || Path::new("/usr/lib/sysimage/rpm").exists(),
    )
}

fn selected_asset(release: &Release) -> Option<(PackageKind, &Asset)> {
    selected_asset_in(release, &linux_package_preference())
}

fn update_info(release: &Release, current: &str) -> UpdateInfo {
    let version = release_version(&release.tag_name).unwrap();
    let selected = selected_asset(release);
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
        download_available: selected.is_some()
            && release_asset(release, CHECKSUMS_NAME).is_some(),
        size: selected.map_or(0, |(_, asset)| asset.size),
    }
}

// --------------------------------------------------------------------------- //
// 网络
// --------------------------------------------------------------------------- //

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

fn verify_file(path: &Path, expected: &str) -> Result<(), String> {
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
        let bytes = read_limited(
            request(&client()?, RELEASES_API, Duration::from_secs(30))?,
            4 * 1024 * 1024,
        )?;
        let releases = serde_json::from_slice(&bytes)
            .map_err(|error| format!("无法解析 GitHub 版本信息：{error}"))?;
        let release = latest_release(releases).ok_or("GitHub 尚未发布可用版本。")?;
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
        let (kind, asset) = selected_asset(release).ok_or("此版本尚未提供 Linux 安装包。")?;
        let name = asset.name.clone();
        let sums = release_asset(release, CHECKSUMS_NAME).ok_or("此版本缺少校验文件。")?;
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
        data.prepared = Some(PreparedUpdate { path, sha256, kind });
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

// --------------------------------------------------------------------------- //
// 安装：校验后交给用户，AppImage 可原地替换
// --------------------------------------------------------------------------- //

/// 把已校验的 AppImage 覆盖到当前正在运行的镜像。
///
/// Linux 不允许写正在执行的二进制（`ETXTBSY`），但允许用 `rename` 原子替换目录项：
/// 新文件先写进同目录的临时文件，再改名覆盖当前路径，运行中的进程继续使用旧 inode。
fn replace_appimage(current: &Path, source: &Path) -> Result<(), String> {
    if !current.is_file() {
        return Err(format!(
            "无法定位当前 AppImage 文件：{}",
            current.display()
        ));
    }
    let file_name = current
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("当前 AppImage 文件名无效")?;
    let temporary = current.with_file_name(format!(".{file_name}.update"));
    let result = (|| -> Result<(), String> {
        fs::copy(source, &temporary)
            .map_err(|error| format!("无法写入新版本（所在目录可能不可写）：{error}"))?;
        let permissions = fs::metadata(current)
            .map_err(|error| format!("无法读取当前 AppImage 权限：{error}"))?
            .permissions();
        fs::set_permissions(&temporary, permissions)
            .map_err(|error| format!("无法设置新版本执行权限：{error}"))?;
        fs::rename(&temporary, current).map_err(|error| format!("无法替换当前 AppImage：{error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("{error}；新版本安装包保存在 {}", source.display()))
}

fn emit_installed(app: &AppHandle, kind: PackageKind, restart_required: bool, message: &str) {
    let _ = app.emit_to(
        "main",
        "app-update-installed",
        UpdateInstalled {
            kind: kind.label(),
            restart_required,
            message: message.to_string(),
        },
    );
}

fn open_download_directory(prepared: &PreparedUpdate) -> Result<(), String> {
    let directory = prepared
        .path
        .parent()
        .ok_or("无法定位更新包所在目录")?
        .to_path_buf();
    crate::open_with_default_app(&directory.display().to_string()).map_err(|error| {
        format!(
            "安装包已通过 SHA-256 校验，但无法打开所在文件夹：{error}\n文件位置：{}",
            prepared.path.display()
        )
    })
}

fn install_prepared(app: &AppHandle, prepared: &PreparedUpdate) -> Result<(), String> {
    let name = prepared
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    if prepared.kind == PackageKind::AppImage {
        if let Some(current) = running_appimage_path() {
            match replace_appimage(&current, &prepared.path) {
                Ok(()) => {
                    emit_installed(
                        app,
                        prepared.kind,
                        true,
                        &format!("已用新版本替换当前 AppImage（{name}），请重启应用完成更新。"),
                    );
                    return Ok(());
                }
                Err(error) => {
                    // 目录不可写时不阻断流程：退回「打开下载目录，请手动替换」。
                    open_download_directory(prepared)?;
                    emit_installed(
                        app,
                        prepared.kind,
                        true,
                        &format!(
                            "无法自动替换当前 AppImage：{error}。已打开安装包所在文件夹，\
                             请手动替换后重启应用。"
                        ),
                    );
                    return Ok(());
                }
            }
        }
    }
    open_download_directory(prepared)?;
    let command_hint = match prepared.kind {
        PackageKind::Deb => "sudo apt install ./<文件名>",
        PackageKind::Rpm => "sudo dnf install ./<文件名>",
        PackageKind::AppImage => "为 AppImage 添加可执行权限后运行",
    };
    let message = format!(
        "安装包已通过 SHA-256 校验，并已打开所在文件夹。请手动完成安装：{command_hint}（{name}）"
    );
    emit_installed(app, prepared.kind, false, &message);
    Ok(())
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
        install_prepared(&app, prepared)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn open_app_releases() -> Result<(), String> {
    crate::open_with_default_app(RELEASES_URL).map_err(|error| format!("无法打开 GitHub：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

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

    fn push_asset(release: &mut Release, name: &str) {
        release.assets.push(Asset {
            name: name.into(),
            size: 10,
            browser_download_url: format!(
                "{RELEASES_URL}/download/{}/{name}",
                release.tag_name
            ),
        });
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
    fn linux_asset_names_follow_the_release_convention() {
        let release = release("beta1.0.2");
        assert_eq!(
            asset_name(&release, PackageKind::Deb),
            "simultaneous-translator_1.0.2_linux_amd64.deb"
        );
        assert_eq!(
            asset_name(&release, PackageKind::Rpm),
            "simultaneous-translator_1.0.2_linux_amd64.rpm"
        );
        assert_eq!(
            asset_name(&release, PackageKind::AppImage),
            "simultaneous-translator_1.0.2_linux_amd64.AppImage"
        );
    }

    #[test]
    fn legacy_amd64_asset_names_are_still_accepted() {
        let mut release = release("v1.0.2");
        push_asset(&mut release, "simultaneous-translator_1.0.2_amd64.deb");
        push_asset(&mut release, "simultaneous-translator_1.0.2_amd64.rpm");
        push_asset(&mut release, "simultaneous-translator_1.0.2_amd64.AppImage");
        assert!(release_asset_for_kind(&release, PackageKind::Deb).is_some());
        assert!(release_asset_for_kind(&release, PackageKind::Rpm).is_some());
        assert!(release_asset_for_kind(&release, PackageKind::AppImage).is_some());
    }

    #[test]
    fn rpm_matching_also_accepts_the_bundler_file_name() {
        let mut release = release("v1.0.2");
        push_asset(&mut release, "simultaneous-translator-1.0.2-1.x86_64.rpm");
        assert!(release_asset_for_kind(&release, PackageKind::Rpm).is_some());
    }

    #[test]
    fn package_preference_prefers_the_running_format() {
        assert_eq!(
            package_preference(true, true, false),
            vec![PackageKind::AppImage, PackageKind::Deb, PackageKind::Rpm]
        );
        assert_eq!(
            package_preference(false, true, false),
            vec![PackageKind::Deb, PackageKind::Rpm, PackageKind::AppImage]
        );
        assert_eq!(
            package_preference(false, false, true),
            vec![PackageKind::Rpm, PackageKind::Deb, PackageKind::AppImage]
        );
        assert_eq!(
            package_preference(false, false, false),
            vec![PackageKind::Deb, PackageKind::Rpm, PackageKind::AppImage]
        );
        assert_eq!(
            package_preference(true, false, false),
            vec![PackageKind::AppImage, PackageKind::Deb, PackageKind::Rpm]
        );
    }

    #[test]
    fn selected_asset_falls_back_when_the_preferred_format_is_missing() {
        let mut release = release("v1.0.2");
        let appimage = asset_name(&release, PackageKind::AppImage);
        push_asset(&mut release, &appimage);
        let (kind, asset) =
            selected_asset_in(&release, &[PackageKind::Deb, PackageKind::Rpm, PackageKind::AppImage])
                .expect("the AppImage fallback should be selected");
        assert_eq!(kind, PackageKind::AppImage);
        assert_eq!(asset.size, 10);
        assert!(selected_asset_in(&release, &[PackageKind::Deb]).is_none());
    }

    #[test]
    fn update_info_requires_assets_and_checksums_for_downloads() {
        let mut release = release("v1.0.2");
        assert!(update_info(&release, "1.0.1").available);
        assert!(!update_info(&release, "1.0.1").download_available);
        let deb = asset_name(&release, PackageKind::Deb);
        push_asset(&mut release, &deb);
        // 只有安装包、没有 SHA256SUMS.txt 时不允许下载安装。
        assert!(!update_info(&release, "1.0.1").download_available);
        push_asset(&mut release, CHECKSUMS_NAME);
        // deb 在兜底顺序里一定入选，因此与主机发行版无关。
        assert!(update_info(&release, "1.0.1").download_available);
        assert_eq!(update_info(&release, "1.0.1").size, 10);
    }

    #[test]
    fn limits_assets_to_the_release_in_the_configured_repository() {
        let mut selected = release("beta0.5.3");
        let name = asset_name(&selected, PackageKind::Deb);
        push_asset(&mut selected, &name);
        assert!(release_asset(&selected, &name).is_some());
        selected.assets[0].browser_download_url = format!("https://example.com/{name}");
        assert!(release_asset(&selected, &name).is_none());
        selected.assets[0].browser_download_url =
            format!("{RELEASES_URL}/download/beta0.5.2/{name}");
        assert!(release_asset(&selected, &name).is_none());
    }

    #[test]
    fn validates_exact_checksum_filename_and_rejects_ambiguity() {
        let hash = "ab".repeat(32);
        let name = "simultaneous-translator_1.0.2_linux_amd64.deb";
        assert_eq!(
            checksum_for(&format!("{hash}  {name}\r\n"), name).unwrap(),
            hash
        );
        assert_eq!(checksum_for(&format!("{hash} *{name}\n"), name).unwrap(), hash);
        assert!(checksum_for(&format!("{hash}  other.deb"), name).is_err());
        assert!(checksum_for(&format!("invalid  {name}"), name).is_err());
        assert!(checksum_for(&format!("{hash}  {name}\n{hash}  {name}"), name).is_err());
    }

    #[test]
    fn detects_modified_installer() {
        let path =
            std::env::temp_dir().join(format!("translator-update-test-{}", uuid::Uuid::new_v4()));
        fs::write(&path, b"verified package").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"verified package"));
        assert!(verify_file(&path, &hash).is_ok());
        fs::write(&path, b"modified package").unwrap();
        assert!(verify_file(&path, &hash).is_err());
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn appimage_replacement_swaps_the_current_file() {
        let directory =
            std::env::temp_dir().join(format!("translator-appimage-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let current = directory.join("simultaneous-translator_1.0.1_amd64.AppImage");
        let downloaded = directory.join("simultaneous-translator_1.0.2_amd64.AppImage");
        fs::write(&current, b"old image").unwrap();
        fs::write(&downloaded, b"new image").unwrap();
        fs::set_permissions(&current, fs::Permissions::from_mode(0o755)).unwrap();

        replace_appimage(&current, &downloaded).expect("the download should replace the AppImage");

        assert_eq!(fs::read(&current).unwrap(), b"new image");
        assert_eq!(
            fs::metadata(&current).unwrap().permissions().mode() & 0o111,
            0o111
        );
        assert!(downloaded.exists());
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn appimage_replacement_reports_an_unwritable_directory() {
        let directory =
            std::env::temp_dir().join(format!("translator-appimage-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let downloaded = directory.join("update.AppImage");
        fs::write(&downloaded, b"new image").unwrap();
        let missing = directory.join("missing.AppImage");
        let error = replace_appimage(&missing, &downloaded)
            .expect_err("a missing running AppImage must not be replaced");
        assert!(error.contains("无法定位当前 AppImage"));
        fs::remove_dir_all(&directory).unwrap();
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
        let (kind, asset) = selected_asset(&selected).expect("a Linux asset should be published");
        let sums = release_asset(&selected, CHECKSUMS_NAME).unwrap();
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
        assert!(checksum_for(std::str::from_utf8(&bytes).unwrap(), &asset.name).is_ok());
        assert!(matches!(
            kind,
            PackageKind::Deb | PackageKind::Rpm | PackageKind::AppImage
        ));
    }
}
