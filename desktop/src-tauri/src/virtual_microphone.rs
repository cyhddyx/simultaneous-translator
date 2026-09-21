#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct InstallerState(Arc<Mutex<()>>);

fn installer_command(script: &str) -> Command {
    let mut command = Command::new("powershell.exe");
    // PowerShell 7 module paths are incompatible with Windows PowerShell 5.1.
    // Let the child rebuild its own defaults, including Get-FileHash and Expand-Archive.
    command
        .env_remove("PSModulePath")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

#[tauri::command]
pub async fn install_virtual_microphone(
    state: tauri::State<'_, InstallerState>,
) -> Result<(), String> {
    let gate = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = gate
            .try_lock()
            .map_err(|_| "正在准备安装，请稍候。".to_string())?;
        let mut command = installer_command(include_str!("install_virtual_microphone.ps1"));
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法准备安装：{error}"))?;
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                result => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(match result {
                        Err(error) => format!("无法读取安装状态：{error}"),
                        _ => "准备安装超时；若已弹出管理员确认，请先处理该窗口，再重新检测设备。"
                            .into(),
                    });
                }
            }
        }
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "虚拟麦克风安装准备失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn installer_uses_windows_powershell_modules() {
        let mut command = installer_command(
            "$ErrorActionPreference = 'Stop'; Get-Command Get-FileHash, Expand-Archive, Get-AuthenticodeSignature | Out-Null",
        );
        assert!(command
            .get_envs()
            .any(|(name, value)| { name.eq_ignore_ascii_case("PSModulePath") && value.is_none() }));
        let output = command.output().expect("Windows PowerShell should launch");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    #[ignore = "downloads the official package; verifies it without installing a driver"]
    fn prepare_official_installer_without_installing() {
        let script = format!(
            "& {{\n{}\n}} -PrepareOnly",
            include_str!("install_virtual_microphone.ps1")
        );
        let output = installer_command(&script)
            .stdout(Stdio::piped())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("No installer was launched."));
    }
}

#[tauri::command]
pub fn open_virtual_microphone_link(kind: String) -> Result<(), String> {
    let url = match kind.as_str() {
        "product" => "https://vb-audio.com/Cable/",
        "license" => "https://vb-audio.com/Services/licensing.htm",
        "donate" => "https://shop.vb-audio.com/en/",
        _ => return Err("未知链接".into()),
    };
    let mut command = Command::new("rundll32.exe");
    command.args(["url.dll,FileProtocolHandler", url]);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .spawn()
        .map_err(|error| format!("无法打开浏览器：{error}"))?;
    Ok(())
}
