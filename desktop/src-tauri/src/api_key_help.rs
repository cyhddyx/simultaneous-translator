#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::Command;

#[tauri::command]
pub fn open_api_key_help(kind: String) -> Result<(), String> {
    let url = match kind.as_str() {
        "console" => "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
        "guide" => "https://help.aliyun.com/zh/model-studio/get-api-key",
        _ => return Err("未知的密钥帮助链接".into()),
    };
    let mut command = Command::new("rundll32.exe");
    command.args(["url.dll,FileProtocolHandler", url]);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .spawn()
        .map_err(|error| format!("无法打开浏览器，请使用链接地址访问：{error}"))?;
    Ok(())
}
