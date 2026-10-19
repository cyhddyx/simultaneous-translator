/// 「API Key 帮助」链接：Linux 下用 xdg-open 交给默认浏览器。
///
/// 命令名与参数（`open_api_key_help`, `kind`）保持 Windows 版契约不变。
#[tauri::command]
pub fn open_api_key_help(kind: String) -> Result<(), String> {
    let url = match kind.as_str() {
        "console" => "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
        "guide" => "https://help.aliyun.com/zh/model-studio/get-api-key",
        _ => return Err("未知的密钥帮助链接".into()),
    };
    crate::open_with_default_app(url)
        .map_err(|error| format!("无法打开浏览器，请使用链接地址 {url} 访问：{error}"))
}
