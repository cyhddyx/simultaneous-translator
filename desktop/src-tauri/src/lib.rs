use std::{
    collections::HashSet,
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "SimultaneousTranslator";
const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_SCHEMA_VERSION: u32 = 4;
const SECRET_ENVELOPE_VERSION: u32 = 2;
const LEGACY_SECRET_ENVELOPE_VERSION: u32 = 1;
const DEFAULT_TRANSLATION_PROVIDER_ID: &str = "gemini-default";
const LEGACY_GEMINI_ACCOUNT: &str = "gemini_api_key";
const RECOGNITION_ACCOUNT: &str = "dashscope_api_key";
const GEMINI_ENV_BINDING_ACCOUNT: &str = "environment_binding:gemini";
const RECOGNITION_ENV_BINDING_ACCOUNT: &str = "environment_binding:dashscope";
const DEFAULT_RECOGNITION_BASE_URL: &str = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com";
const MAX_TRANSLATION_PROVIDERS: usize = 20;
const MAX_MODELS_PER_PROVIDER: usize = 100;
const MAX_ENDPOINT_BYTES: usize = 2_048;
const MAX_MODEL_ID_BYTES: usize = 256;
const MAX_LANGUAGE_BYTES: usize = 80;
const MAX_API_KEY_BYTES: usize = 4_096;
const MAX_WINDOWS_CREDENTIAL_UTF16_BYTES: usize = 2_560;
// The bridge only ever talks over piped stdio. Now that this binary targets the
// Windows GUI subsystem, a console-mode child would allocate its own visible
// console on every session start and every service probe.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
// A bare kill abandons the DashScope recognition task, which the service then
// holds open until it times out on its own.
const ENGINE_SHUTDOWN_GRACE: Duration = Duration::from_millis(1_000);
const STDERR_HISTORY_LINES: usize = 20;
const MAX_STDERR_DETAIL_CHARS: usize = 400;
static SETTINGS_CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());

fn settings_schema_version() -> u32 {
    SETTINGS_SCHEMA_VERSION
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecognitionSettings {
    protocol: String,
    base_url: String,
    model: String,
}

impl Default for RecognitionSettings {
    fn default() -> Self {
        Self {
            protocol: "dashscope".into(),
            base_url: DEFAULT_RECOGNITION_BASE_URL.into(),
            model: "qwen-audio-3.0-asr-flash-streaming".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslationProvider {
    id: String,
    name: String,
    protocol: String,
    base_url: String,
    models: Vec<String>,
    selected_model: String,
}

impl Default for TranslationProvider {
    fn default() -> Self {
        Self {
            id: DEFAULT_TRANSLATION_PROVIDER_ID.into(),
            name: "Gemini".into(),
            protocol: "gemini".into(),
            base_url: DEFAULT_GEMINI_BASE_URL.into(),
            models: vec!["gemini-2.5-flash".into()],
            selected_model: "gemini-2.5-flash".into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicSettings {
    #[serde(default = "settings_schema_version")]
    schema_version: u32,
    source_language: String,
    target_language: String,
    recognition: RecognitionSettings,
    translation_providers: Vec<TranslationProvider>,
    active_translation_provider_id: String,
    keep_on_top: bool,
    caption_scale: String,
}

impl Default for PublicSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            source_language: "自动检测".into(),
            target_language: "简体中文".into(),
            recognition: RecognitionSettings::default(),
            translation_providers: vec![TranslationProvider::default()],
            active_translation_provider_id: DEFAULT_TRANSLATION_PROVIDER_ID.into(),
            keep_on_top: false,
            caption_scale: "medium".into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPublicSettings {
    dashscope_ws_url: String,
    gemini_base_url: String,
    gemini_model: String,
    source_language: String,
    target_language: String,
    keep_on_top: bool,
    caption_scale: String,
}

impl From<LegacyPublicSettings> for PublicSettings {
    fn from(legacy: LegacyPublicSettings) -> Self {
        let model = legacy.gemini_model;
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            source_language: legacy.source_language,
            target_language: legacy.target_language,
            recognition: RecognitionSettings {
                base_url: legacy.dashscope_ws_url,
                ..RecognitionSettings::default()
            },
            translation_providers: vec![TranslationProvider {
                base_url: legacy.gemini_base_url,
                models: vec![model.clone()],
                selected_model: model,
                ..TranslationProvider::default()
            }],
            active_translation_provider_id: DEFAULT_TRANSLATION_PROVIDER_ID.into(),
            keep_on_top: legacy.keep_on_top,
            caption_scale: legacy.caption_scale,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecognitionInput {
    protocol: String,
    base_url: String,
    model: String,
    api_key: Option<String>,
    clear_api_key: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationProviderInput {
    id: String,
    name: String,
    protocol: String,
    base_url: String,
    models: Vec<String>,
    selected_model: String,
    api_key: Option<String>,
    clear_api_key: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsInput {
    source_language: String,
    target_language: String,
    recognition: RecognitionInput,
    translation_providers: Vec<TranslationProviderInput>,
    active_translation_provider_id: String,
    keep_on_top: bool,
    caption_scale: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeProviderSpec {
    protocol: String,
    base_url: String,
    model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderProbeInput {
    provider_id: String,
    provider: ProbeProviderSpec,
    api_key: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum SecretSource {
    Environment,
    SecureStore,
    Missing,
    Unavailable,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretScope {
    protocol: String,
    endpoint_hash: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct LegacySecretScope {
    protocol: String,
    origin: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSecretEnvelope {
    version: u32,
    secret: String,
    scope: SecretScope,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyStoredSecretEnvelope {
    version: u32,
    secret: String,
    scope: LegacySecretScope,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentBinding {
    version: u32,
    scope: SecretScope,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyEnvironmentBinding {
    version: u32,
    scope: LegacySecretScope,
}

#[derive(Debug, PartialEq, Eq)]
enum ScopedSecret {
    Available(String),
    Missing,
    ScopeMismatch,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SecretUpgrade {
    Usable,
    Upgrade(String),
    Unusable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AccountMigrationState {
    Missing,
    UsableOrPlanned,
    Unusable,
}

fn legacy_alias_can_fill(state: AccountMigrationState) -> bool {
    matches!(state, AccountMigrationState::Missing)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecognitionSnapshot {
    #[serde(flatten)]
    settings: RecognitionSettings,
    api_key_status: SecretSource,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslationProviderSnapshot {
    #[serde(flatten)]
    provider: TranslationProvider,
    api_key_status: SecretSource,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSnapshot {
    schema_version: u32,
    source_language: String,
    target_language: String,
    recognition: RecognitionSnapshot,
    translation_providers: Vec<TranslationProviderSnapshot>,
    active_translation_provider_id: String,
    keep_on_top: bool,
    caption_scale: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartResult {
    session_id: String,
}

struct EngineProcess {
    child: Child,
    stdin: ChildStdin,
    session_id: String,
}

#[derive(Clone)]
struct EngineManager {
    process: Arc<Mutex<Option<EngineProcess>>>,
}

#[derive(Clone, Default)]
struct ProbeManager {
    gate: Arc<Mutex<()>>,
}

impl Default for EngineManager {
    fn default() -> Self {
        Self {
            process: Arc::new(Mutex::new(None)),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法定位应用配置目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建配置目录：{error}"))?;
    Ok(directory.join(SETTINGS_FILE))
}

fn load_public_settings(app: &AppHandle) -> Result<PublicSettings, String> {
    let _guard = lock_settings_credentials()?;
    load_public_settings_internal(app, false)
}

fn lock_settings_credentials() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    SETTINGS_CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "设置与凭据状态暂不可用，请重启应用后重试".to_string())
}

fn load_public_settings_internal(
    app: &AppHandle,
    tolerate_credential_migration_failure: bool,
) -> Result<PublicSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(PublicSettings::default());
    }

    let content = fs::read_to_string(&path).map_err(|error| format!("无法读取设置：{error}"))?;
    match decode_public_settings_versioned(&content) {
        Ok((settings, source_version)) if source_version < SETTINGS_SCHEMA_VERSION as u64 => {
            match migrate_previous_settings(app, &settings, source_version) {
                Ok(()) => Ok(settings),
                Err(error) if tolerate_credential_migration_failure => {
                    eprintln!("credential migration deferred: {error}");
                    Ok(settings)
                }
                Err(error) => Err(format!("旧版 API Key 尚未完成安全迁移：{error}")),
            }
        }
        Ok((settings, _)) => Ok(settings),
        Err(SettingsDecodeError::UnsupportedVersion(version)) => Err(format!(
            "设置文件来自更高版本（版本 {version}），当前版本不会修改它。请升级应用后重试。"
        )),
        Err(SettingsDecodeError::Invalid(error)) => {
            let backup = path.with_file_name(format!("settings.invalid-{}.json", Uuid::new_v4()));
            fs::rename(&path, &backup)
                .map_err(|rename_error| format!("设置文件格式无效且无法备份：{rename_error}"))?;
            eprintln!(
                "invalid settings file moved to {}: {error}",
                backup.display()
            );
            Ok(PublicSettings::default())
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SettingsDecodeError {
    Invalid(String),
    UnsupportedVersion(u64),
}

#[cfg(test)]
fn decode_public_settings(content: &str) -> Result<PublicSettings, SettingsDecodeError> {
    decode_public_settings_versioned(content).map(|(settings, _)| settings)
}

fn decode_public_settings_versioned(
    content: &str,
) -> Result<(PublicSettings, u64), SettingsDecodeError> {
    let value: Value = serde_json::from_str(content)
        .map_err(|error| SettingsDecodeError::Invalid(error.to_string()))?;
    let version = match value.get("schemaVersion") {
        None => 1,
        Some(Value::Number(version)) => version
            .as_u64()
            .ok_or_else(|| SettingsDecodeError::Invalid("schemaVersion 必须是正整数".into()))?,
        Some(_) => {
            return Err(SettingsDecodeError::Invalid(
                "schemaVersion 必须是正整数".into(),
            ))
        }
    };
    let settings = match version {
        1 => {
            let legacy = serde_json::from_value::<LegacyPublicSettings>(value)
                .map_err(|error| SettingsDecodeError::Invalid(error.to_string()))?;
            PublicSettings::from(legacy)
        }
        2 | 3 | 4 => {
            serde_json::from_value::<PublicSettings>(value)
                .map_err(|error| SettingsDecodeError::Invalid(error.to_string()))?
        }
        version => return Err(SettingsDecodeError::UnsupportedVersion(version)),
    };
    normalize_public_settings(settings)
        .map(|settings| (settings, version))
        .map_err(SettingsDecodeError::Invalid)
}

fn save_public_settings(app: &AppHandle, settings: &PublicSettings) -> Result<(), String> {
    let content = serde_json::to_string_pretty(settings).map_err(|error| format!("无法序列化设置：{error}"))?;
    let path = settings_path(app)?;
    let temporary = path.with_file_name(format!("settings.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, content).map_err(|error| format!("无法写入临时设置：{error}"))?;
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法替换设置文件：{error}"));
    }
    Ok(())
}

fn normalize_endpoint(
    value: &str,
    scheme: &str,
    label: &str,
    version_suffix: Option<&str>,
) -> Result<String, String> {
    let value = value.trim();
    if value.len() > MAX_ENDPOINT_BYTES {
        return Err(format!("{label} 地址过长"));
    }
    let mut url = Url::parse(value).map_err(|_| format!("{label} 地址无效"))?;
    if url.scheme() != scheme || url.host_str().is_none() {
        return Err(format!("{label} 必须使用 {scheme}:// 安全地址"));
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(format!("{label} 地址不能包含凭据、查询参数或片段"));
    }

    if let Some(version_suffix) = version_suffix {
        let path = url.path().trim_end_matches('/').to_string();
        let lower_path = path.to_ascii_lowercase();
        if lower_path.ends_with(version_suffix) {
            let prefix = &path[..path.len() - version_suffix.len()];
            url.set_path(if prefix.is_empty() { "/" } else { prefix });
        }
    }

    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn validate_provider_id(id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("服务商标识无效，请删除后重新添加".into());
    }
    Ok(id.to_string())
}

fn normalize_translation_provider(
    provider: TranslationProvider,
) -> Result<TranslationProvider, String> {
    let id = validate_provider_id(&provider.id)?;
    let name = provider.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err("服务商名称不能为空且不能超过 60 个字符".into());
    }
    let protocol = provider.protocol.trim().to_lowercase();
    let version_suffix = match protocol.as_str() {
        "gemini" => "/v1beta",
        "openai" => "/v1",
        _ => return Err(format!("服务商“{name}”使用了不支持的接口协议")),
    };
    let base_url = normalize_endpoint(
        &provider.base_url,
        "https",
        &format!("服务商“{name}”"),
        Some(version_suffix),
    )?;
    let selected_model = provider.selected_model.trim().to_string();
    if selected_model.is_empty() || selected_model.len() > MAX_MODEL_ID_BYTES {
        return Err(format!("请为服务商“{name}”选择有效且不过长的模型名称"));
    }

    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for model in provider.models {
        let model = model.trim().to_string();
        if model.len() > MAX_MODEL_ID_BYTES {
            return Err(format!("服务商“{name}”的模型名称过长"));
        }
        if !model.is_empty() && seen.insert(model.clone()) {
            models.push(model);
        }
    }
    if seen.insert(selected_model.clone()) {
        models.push(selected_model.clone());
    }
    if models.len() > MAX_MODELS_PER_PROVIDER {
        return Err(format!(
            "服务商“{name}”最多可保存 {MAX_MODELS_PER_PROVIDER} 个模型"
        ));
    }

    Ok(TranslationProvider {
        id,
        name,
        protocol,
        base_url,
        models,
        selected_model,
    })
}

fn normalize_public_settings(settings: PublicSettings) -> Result<PublicSettings, String> {
    let source_language = settings.source_language.trim().to_string();
    let target_language = settings.target_language.trim().to_string();
    if source_language.is_empty()
        || target_language.is_empty()
        || source_language.len() > MAX_LANGUAGE_BYTES
        || target_language.len() > MAX_LANGUAGE_BYTES
    {
        return Err("源语言和目标语言不能为空且不能过长".into());
    }
    if !matches!(settings.caption_scale.as_str(), "small" | "medium" | "large") {
        return Err("字幕大小无效".into());
    }

    let recognition_protocol = settings.recognition.protocol.trim().to_lowercase();
    if recognition_protocol != "dashscope" {
        return Err("当前版本的实时语音识别仅支持 DashScope 协议".into());
    }
    let recognition_model = settings.recognition.model.trim().to_string();
    if recognition_model.is_empty() || recognition_model.len() > MAX_MODEL_ID_BYTES {
        return Err("语音识别模型不能为空且不能过长".into());
    }
    let recognition = RecognitionSettings {
        protocol: recognition_protocol,
        base_url: normalize_endpoint(
            &settings.recognition.base_url,
            "wss",
            "DashScope WebSocket",
            None,
        )?,
        model: recognition_model,
    };

    if settings.translation_providers.is_empty() {
        return Err("请至少添加一个翻译服务商".into());
    }
    if settings.translation_providers.len() > MAX_TRANSLATION_PROVIDERS {
        return Err(format!(
            "最多可保存 {MAX_TRANSLATION_PROVIDERS} 个翻译服务商"
        ));
    }
    let mut provider_ids = HashSet::new();
    let mut translation_providers = Vec::with_capacity(settings.translation_providers.len());
    for provider in settings.translation_providers {
        let provider = normalize_translation_provider(provider)?;
        if !provider_ids.insert(provider.id.clone()) {
            return Err("服务商标识重复，请删除后重新添加".into());
        }
        translation_providers.push(provider);
    }
    let active_translation_provider_id =
        validate_provider_id(&settings.active_translation_provider_id)?;
    if !provider_ids.contains(&active_translation_provider_id) {
        return Err("当前翻译服务商不存在".into());
    }

    Ok(PublicSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        source_language,
        target_language,
        recognition,
        translation_providers,
        active_translation_provider_id,
        keep_on_top: settings.keep_on_top,
        caption_scale: settings.caption_scale,
    })
}

fn normalize_settings(input: &SettingsInput) -> Result<PublicSettings, String> {
    normalize_public_settings(PublicSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        source_language: input.source_language.clone(),
        target_language: input.target_language.clone(),
        recognition: RecognitionSettings {
            protocol: input.recognition.protocol.clone(),
            base_url: input.recognition.base_url.clone(),
            model: input.recognition.model.clone(),
        },
        translation_providers: input
            .translation_providers
            .iter()
            .map(|provider| TranslationProvider {
                id: provider.id.clone(),
                name: provider.name.clone(),
                protocol: provider.protocol.clone(),
                base_url: provider.base_url.clone(),
                models: provider.models.clone(),
                selected_model: provider.selected_model.clone(),
            })
            .collect(),
        active_translation_provider_id: input.active_translation_provider_id.clone(),
        keep_on_top: input.keep_on_top,
        caption_scale: input.caption_scale.clone(),
    })
}

fn credential_entry(account: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, account).map_err(|error| format!("无法访问 Windows 凭据管理器：{error}"))
}

fn read_secret(account: &str) -> Result<Option<String>, String> {
    match credential_entry(account)?.get_password() {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "无法读取 Windows 凭据管理器中的 {account}：{error}"
        )),
    }
}

fn provider_account(provider_id: &str) -> String {
    format!("translation_provider:{provider_id}")
}

fn is_legacy_gemini_provider(provider: &TranslationProvider) -> bool {
    provider.id == DEFAULT_TRANSLATION_PROVIDER_ID && provider.protocol == "gemini"
}

fn secret_binding_account(account: &str) -> String {
    format!("{account}:scope")
}

fn provider_environment(provider: &TranslationProvider) -> Result<Option<&'static str>, String> {
    if provider.id != DEFAULT_TRANSLATION_PROVIDER_ID
        || provider.protocol != "gemini"
        || environment_secret(Some("GEMINI_API_KEY")).is_none()
    {
        return Ok(None);
    }
    if provider.base_url == DEFAULT_GEMINI_BASE_URL
        || environment_binding_matches(
            GEMINI_ENV_BINDING_ACCOUNT,
            &secret_scope(&provider.protocol, &provider.base_url)?,
        )?
    {
        Ok(Some("GEMINI_API_KEY"))
    } else {
        Ok(None)
    }
}

fn recognition_environment(
    recognition: &RecognitionSettings,
) -> Result<Option<&'static str>, String> {
    if recognition.protocol != "dashscope" {
        return Ok(None);
    }
    if environment_secret(Some("DASHSCOPE_API_KEY")).is_none() {
        return Ok(None);
    }
    if recognition.base_url == DEFAULT_RECOGNITION_BASE_URL
        || environment_binding_matches(
            RECOGNITION_ENV_BINDING_ACCOUNT,
            &secret_scope(&recognition.protocol, &recognition.base_url)?,
        )?
    {
        Ok(Some("DASHSCOPE_API_KEY"))
    } else {
        Ok(None)
    }
}

fn environment_secret(name: Option<&str>) -> Option<String> {
    name.and_then(|name| env::var(name).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn secret_scope(protocol: &str, base_url: &str) -> Result<SecretScope, String> {
    Url::parse(base_url).map_err(|_| "无法为 API Key 绑定服务地址".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(protocol.as_bytes());
    hasher.update([0]);
    hasher.update(base_url.as_bytes());
    let endpoint_hash = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(SecretScope {
        protocol: protocol.to_string(),
        endpoint_hash,
    })
}

fn legacy_secret_scope(protocol: &str, base_url: &str) -> Result<LegacySecretScope, String> {
    let url = Url::parse(base_url).map_err(|_| "无法为旧版 API Key 校验服务地址".to_string())?;
    Ok(LegacySecretScope {
        protocol: protocol.to_string(),
        origin: url.origin().ascii_serialization(),
    })
}

fn inspect_secret_for_upgrade(
    stored: &str,
    stored_binding: Option<&str>,
    current_scope: &SecretScope,
    legacy_scope: &LegacySecretScope,
    source_settings_version: u64,
) -> SecretUpgrade {
    if let Ok(envelope) = serde_json::from_str::<StoredSecretEnvelope>(stored) {
        return if envelope.version == SECRET_ENVELOPE_VERSION
            && envelope.scope == *current_scope
            && !envelope.secret.trim().is_empty()
        {
            SecretUpgrade::Usable
        } else {
            SecretUpgrade::Unusable
        };
    }
    if let Ok(envelope) = serde_json::from_str::<LegacyStoredSecretEnvelope>(stored) {
        return if envelope.version == LEGACY_SECRET_ENVELOPE_VERSION
            && envelope.scope == *legacy_scope
        {
            let secret = envelope.secret.trim().to_string();
            if secret.is_empty() {
                SecretUpgrade::Unusable
            } else {
                SecretUpgrade::Upgrade(secret)
            }
        } else {
            SecretUpgrade::Unusable
        };
    }

    if let Some(binding) = stored_binding {
        if serde_json::from_str::<EnvironmentBinding>(binding).is_ok_and(|binding| {
            binding.version == SECRET_ENVELOPE_VERSION && binding.scope == *current_scope
        }) {
            return if stored.trim().is_empty() {
                SecretUpgrade::Unusable
            } else {
                SecretUpgrade::Usable
            };
        }
        let secret = serde_json::from_str::<LegacyEnvironmentBinding>(binding)
            .ok()
            .filter(|binding| {
                binding.version == LEGACY_SECRET_ENVELOPE_VERSION
                    && binding.scope == *legacy_scope
            })
            .map(|_| stored.trim().to_string())
            .filter(|secret| !secret.is_empty());
        return secret
            .map(SecretUpgrade::Upgrade)
            .unwrap_or(SecretUpgrade::Unusable);
    }

    let secret = stored.trim().to_string();
    if source_settings_version <= 2 && !secret.is_empty() {
        SecretUpgrade::Upgrade(secret)
    } else {
        SecretUpgrade::Unusable
    }
}

fn environment_binding_needs_upgrade(
    stored_binding: Option<&str>,
    current_scope: &SecretScope,
    legacy_scope: &LegacySecretScope,
) -> bool {
    match stored_binding {
        Some(binding)
            if serde_json::from_str::<EnvironmentBinding>(binding).is_ok_and(|binding| {
                binding.version == SECRET_ENVELOPE_VERSION && binding.scope == *current_scope
            }) =>
        {
            false
        }
        Some(binding) => serde_json::from_str::<LegacyEnvironmentBinding>(binding).is_ok_and(
            |binding| {
                binding.version == LEGACY_SECRET_ENVELOPE_VERSION
                    && binding.scope == *legacy_scope
            },
        ),
        None => false,
    }
}

fn environment_binding_matches(account: &str, scope: &SecretScope) -> Result<bool, String> {
    let Some(stored) = read_secret(account)? else {
        return Ok(false);
    };
    Ok(serde_json::from_str::<EnvironmentBinding>(&stored).is_ok_and(|binding| {
        binding.version == SECRET_ENVELOPE_VERSION && binding.scope == *scope
    }))
}

fn encode_environment_binding(scope: SecretScope) -> Result<String, String> {
    let encoded = serde_json::to_string(&EnvironmentBinding {
        version: SECRET_ENVELOPE_VERSION,
        scope,
    })
    .map_err(|error| format!("无法准备环境变量地址绑定：{error}"))?;
    validate_credential_value_size(&encoded, "环境变量地址绑定")?;
    Ok(encoded)
}

fn read_scoped_secret(
    account: &str,
    scope: &SecretScope,
) -> Result<ScopedSecret, String> {
    let Some(stored) = read_secret(account)? else {
        return Ok(ScopedSecret::Missing);
    };
    let decoded = decode_scoped_secret(stored.clone(), scope);
    if matches!(&decoded, ScopedSecret::ScopeMismatch)
        && serde_json::from_str::<StoredSecretEnvelope>(&stored).is_err()
        && environment_binding_matches(&secret_binding_account(account), scope)?
    {
        return Ok(ScopedSecret::Available(stored));
    }
    Ok(decoded)
}

fn decode_scoped_secret(stored: String, scope: &SecretScope) -> ScopedSecret {
    if let Ok(envelope) = serde_json::from_str::<StoredSecretEnvelope>(&stored) {
        if envelope.version == SECRET_ENVELOPE_VERSION && envelope.scope == *scope {
            let secret = envelope.secret.trim().to_string();
            return if secret.is_empty() {
                ScopedSecret::Missing
            } else {
                ScopedSecret::Available(secret)
            };
        }
        return ScopedSecret::ScopeMismatch;
    }
    ScopedSecret::ScopeMismatch
}

fn scoped_secret_source(secret: ScopedSecret) -> SecretSource {
    match secret {
        ScopedSecret::Available(_) => SecretSource::SecureStore,
        ScopedSecret::Missing | ScopedSecret::ScopeMismatch => SecretSource::Missing,
    }
}

fn recognition_secret_source(recognition: &RecognitionSettings) -> Result<SecretSource, String> {
    if environment_secret(recognition_environment(recognition)?).is_some() {
        return Ok(SecretSource::Environment);
    }
    let scope = secret_scope(&recognition.protocol, &recognition.base_url)?;
    Ok(scoped_secret_source(read_scoped_secret(
        RECOGNITION_ACCOUNT,
        &scope,
    )?))
}

fn provider_secret_source(provider: &TranslationProvider) -> Result<SecretSource, String> {
    if environment_secret(provider_environment(provider)?).is_some() {
        return Ok(SecretSource::Environment);
    }
    let account = provider_account(&provider.id);
    let scope = secret_scope(&provider.protocol, &provider.base_url)?;
    match read_scoped_secret(&account, &scope)? {
        ScopedSecret::Available(_) => Ok(SecretSource::SecureStore),
        secret => Ok(scoped_secret_source(secret)),
    }
}

fn resolve_recognition_secret(recognition: &RecognitionSettings) -> Result<String, String> {
    if let Some(value) = environment_secret(recognition_environment(recognition)?) {
        return Ok(value);
    }
    let scope = secret_scope(&recognition.protocol, &recognition.base_url)?;
    match read_scoped_secret(
        RECOGNITION_ACCOUNT,
        &scope,
    )? {
        ScopedSecret::Available(value) => Ok(value),
        ScopedSecret::ScopeMismatch => {
            Err("语音识别服务地址已更改，请重新输入并保存 API Key".into())
        }
        ScopedSecret::Missing => Err("缺少语音识别 API Key，请在设置中配置".into()),
    }
}

fn resolve_provider_secret(provider: &TranslationProvider) -> Result<String, String> {
    if let Some(value) = environment_secret(provider_environment(provider)?) {
        return Ok(value);
    }
    let account = provider_account(&provider.id);
    let scope = secret_scope(&provider.protocol, &provider.base_url)?;
    match read_scoped_secret(&account, &scope)? {
        ScopedSecret::Available(value) => Ok(value),
        ScopedSecret::ScopeMismatch => Err(format!(
            "服务商“{}”的协议或地址已更改，请重新输入并保存 API Key",
            provider.name
        )),
        ScopedSecret::Missing => Err(format!(
            "缺少服务商“{}”的 API Key，请在设置中配置",
            provider.name
        )),
    }
}

fn encode_scoped_secret(secret: &str, scope: SecretScope) -> Result<String, String> {
    let encoded = serde_json::to_string(&StoredSecretEnvelope {
        version: SECRET_ENVELOPE_VERSION,
        secret: secret.to_string(),
        scope,
    })
    .map_err(|error| format!("无法准备 API Key：{error}"))?;
    validate_credential_value_size(&encoded, "API Key")?;
    Ok(encoded)
}

fn validate_credential_value_size(value: &str, label: &str) -> Result<(), String> {
    let utf16_bytes = value.encode_utf16().count().saturating_mul(2);
    if utf16_bytes > MAX_WINDOWS_CREDENTIAL_UTF16_BYTES {
        return Err(format!(
            "{label} 与服务地址合计过长，超出 Windows 凭据管理器限制"
        ));
    }
    Ok(())
}

fn plan_scoped_secret_storage(
    planned_secrets: &mut Vec<(String, Option<String>)>,
    account: String,
    secret: &str,
    scope: SecretScope,
) -> Result<(), String> {
    match encode_scoped_secret(secret, scope.clone()) {
        Ok(encoded) => {
            planned_secrets.push((account.clone(), Some(encoded)));
            planned_secrets.push((secret_binding_account(&account), None));
        }
        Err(envelope_error) => {
            validate_credential_value_size(secret, "旧版 API Key").map_err(|_| envelope_error)?;
            planned_secrets.push((
                secret_binding_account(&account),
                Some(encode_environment_binding(scope)?),
            ));
            planned_secrets.push((account, Some(secret.to_string())));
        }
    }
    Ok(())
}

fn requested_secret_change(
    value: Option<&str>,
    clear: bool,
    label: &str,
) -> Result<Option<Option<String>>, String> {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    if clear && value.is_some() {
        return Err(format!("{label} 不能同时替换和删除"));
    }
    if let Some(value) = value {
        if value.len() > MAX_API_KEY_BYTES {
            return Err(format!("{label} 过长"));
        }
        return Ok(Some(Some(value.to_string())));
    }
    Ok(clear.then_some(None))
}

fn write_secret_value(account: &str, value: Option<&str>) -> Result<(), String> {
    let entry = credential_entry(account)?;
    match value {
        Some(value) => entry
            .set_password(value)
            .map_err(|error| format!("无法保存 {account}：{error}"))?,
        None => match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => {}
            Err(error) => return Err(format!("无法删除 {account}：{error}")),
        },
    }
    let verified = read_secret(account)?;
    if verified.as_deref() != value {
        return Err(format!("{account} 的保存校验失败，请重试"));
    }
    Ok(())
}

fn commit_settings_and_secrets(
    app: &AppHandle,
    settings: &PublicSettings,
    planned_secrets: &[(String, Option<String>)],
) -> Result<(), String> {
    let previous_secrets = planned_secrets
        .iter()
        .map(|(account, _)| Ok((account.clone(), read_secret(account)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let mut attempted_secrets = 0;
    let commit_result = (|| {
        for (account, value) in planned_secrets {
            attempted_secrets += 1;
            write_secret_value(account, value.as_deref())?;
        }
        save_public_settings(app, settings)
    })();
    if let Err(error) = commit_result {
        let rollback_errors = previous_secrets[..attempted_secrets]
            .iter()
            .rev()
            .filter_map(|(account, value)| {
                write_secret_value(account, value.as_deref())
                    .err()
                    .map(|rollback_error| format!("{account}: {rollback_error}"))
            })
            .collect::<Vec<_>>();
        return if rollback_errors.is_empty() {
            Err(error)
        } else {
            Err(format!(
                "{error}；恢复原有密钥时仍有错误：{}",
                rollback_errors.join("；")
            ))
        };
    }
    Ok(())
}

fn plan_account_scope_upgrade(
    planned_secrets: &mut Vec<(String, Option<String>)>,
    account: &str,
    current_scope: &SecretScope,
    legacy_scope: &LegacySecretScope,
    source_settings_version: u64,
) -> Result<AccountMigrationState, String> {
    let Some(stored) = read_secret(account)? else {
        return Ok(AccountMigrationState::Missing);
    };
    let binding_account = secret_binding_account(account);
    let stored_binding = read_secret(&binding_account)?;
    match inspect_secret_for_upgrade(
        &stored,
        stored_binding.as_deref(),
        current_scope,
        legacy_scope,
        source_settings_version,
    ) {
        SecretUpgrade::Usable => Ok(AccountMigrationState::UsableOrPlanned),
        SecretUpgrade::Upgrade(secret) => {
            plan_scoped_secret_storage(
                planned_secrets,
                account.to_string(),
                &secret,
                current_scope.clone(),
            )?;
            Ok(AccountMigrationState::UsableOrPlanned)
        }
        SecretUpgrade::Unusable => Ok(AccountMigrationState::Unusable),
    }
}

fn migrate_previous_settings(
    app: &AppHandle,
    settings: &PublicSettings,
    source_settings_version: u64,
) -> Result<(), String> {
    let mut planned_secrets = Vec::new();
    let recognition_scope = secret_scope(
        &settings.recognition.protocol,
        &settings.recognition.base_url,
    )?;
    let legacy_recognition_scope = legacy_secret_scope(
        &settings.recognition.protocol,
        &settings.recognition.base_url,
    )?;
    plan_account_scope_upgrade(
        &mut planned_secrets,
        RECOGNITION_ACCOUNT,
        &recognition_scope,
        &legacy_recognition_scope,
        source_settings_version,
    )?;
    if settings.recognition.base_url != DEFAULT_RECOGNITION_BASE_URL
        && environment_binding_needs_upgrade(
            read_secret(RECOGNITION_ENV_BINDING_ACCOUNT)?.as_deref(),
            &recognition_scope,
            &legacy_recognition_scope,
        )
    {
        planned_secrets.push((
            RECOGNITION_ENV_BINDING_ACCOUNT.into(),
            Some(encode_environment_binding(recognition_scope)?),
        ));
    }

    let legacy_secret = read_secret(LEGACY_GEMINI_ACCOUNT)?;
    let mut legacy_alias_consumed = false;
    for provider in &settings.translation_providers {
        let provider_scope = secret_scope(&provider.protocol, &provider.base_url)?;
        let legacy_provider_scope = legacy_secret_scope(&provider.protocol, &provider.base_url)?;
        let provider_account = provider_account(&provider.id);
        let provider_secret_state = plan_account_scope_upgrade(
            &mut planned_secrets,
            &provider_account,
            &provider_scope,
            &legacy_provider_scope,
            source_settings_version,
        )?;
        let is_legacy_gemini = is_legacy_gemini_provider(provider);
        if is_legacy_gemini {
            match (provider_secret_state, legacy_secret.as_deref()) {
                (state, Some(legacy_secret)) if legacy_alias_can_fill(state) => {
                    plan_scoped_secret_storage(
                        &mut planned_secrets,
                        provider_account.clone(),
                        legacy_secret,
                        provider_scope.clone(),
                    )?;
                    legacy_alias_consumed = true;
                }
                (AccountMigrationState::UsableOrPlanned, Some(_)) => {
                    legacy_alias_consumed = true;
                }
                _ => {}
            }
        }
        if is_legacy_gemini
            && provider.base_url != DEFAULT_GEMINI_BASE_URL
            && environment_binding_needs_upgrade(
                read_secret(GEMINI_ENV_BINDING_ACCOUNT)?.as_deref(),
                &provider_scope,
                &legacy_provider_scope,
            )
        {
            planned_secrets.push((
                GEMINI_ENV_BINDING_ACCOUNT.into(),
                Some(encode_environment_binding(provider_scope)?),
            ));
        }
    }
    if legacy_alias_consumed {
        planned_secrets.push((LEGACY_GEMINI_ACCOUNT.into(), None));
        planned_secrets.push((secret_binding_account(LEGACY_GEMINI_ACCOUNT), None));
    }
    commit_settings_and_secrets(app, settings, &planned_secrets)
}

fn snapshot(app: &AppHandle) -> Result<SettingsSnapshot, String> {
    let _guard = lock_settings_credentials()?;
    let settings = load_public_settings_internal(app, true)?;
    Ok(snapshot_from_settings(settings))
}

fn snapshot_from_settings(settings: PublicSettings) -> SettingsSnapshot {
    let recognition_status = recognition_secret_source(&settings.recognition)
        .unwrap_or(SecretSource::Unavailable);
    let translation_providers = settings
        .translation_providers
        .iter()
        .cloned()
        .map(|provider| {
            let api_key_status = provider_secret_source(&provider)
                .unwrap_or(SecretSource::Unavailable);
            TranslationProviderSnapshot {
                provider,
                api_key_status,
            }
        })
        .collect::<Vec<_>>();
    SettingsSnapshot {
        schema_version: settings.schema_version,
        source_language: settings.source_language,
        target_language: settings.target_language,
        recognition: RecognitionSnapshot {
            settings: settings.recognition,
            api_key_status: recognition_status,
        },
        translation_providers,
        active_translation_provider_id: settings.active_translation_provider_id,
        keep_on_top: settings.keep_on_top,
        caption_scale: settings.caption_scale,
    }
}

fn write_json_line(stdin: &mut ChildStdin, payload: Value) -> Result<(), String> {
    let line = serde_json::to_string(&payload).map_err(|error| format!("无法编码引擎指令：{error}"))?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("无法向翻译引擎发送指令：{error}"))
}

fn start_stdout_reader(stdout: ChildStdout) -> mpsc::Receiver<Value> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(line) => line,
                // A single mis-encoded line used to end the reader silently, so
                // the session died with no diagnostic at all.
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                    eprintln!("translator sidecar emitted a non-UTF-8 line");
                    continue;
                }
                Err(_) => break,
            };
            let Ok(payload) = serde_json::from_str::<Value>(&line) else {
                eprintln!("translator sidecar emitted invalid JSON");
                continue;
            };
            if sender.send(payload).is_err() {
                break;
            }
        }
    });
    receiver
}

fn forward_engine_payload(app: &AppHandle, payload: Value) {
    if payload.get("type").and_then(Value::as_str) == Some("event") {
        let _ = app.emit("translator-event", payload);
    }
}

fn is_stopped_state(payload: &Value, session_id: &str) -> bool {
    payload.get("type").and_then(Value::as_str) == Some("event")
        && payload.get("event").and_then(Value::as_str) == Some("state")
        && payload.get("session_id").and_then(Value::as_str) == Some(session_id)
        && payload
            .pointer("/data/state")
            .and_then(Value::as_str)
            == Some("stopped")
}

fn clear_matching_engine(manager: &EngineManager, session_id: &str) -> bool {
    match manager.process.lock() {
        Ok(mut process) => {
            let belongs_to_session = process
                .as_ref()
                .is_some_and(|engine| engine.session_id == session_id);
            if belongs_to_session {
                if let Some(mut engine) = process.take() {
                    let _ = engine.child.kill();
                    let _ = engine.child.wait();
                }
            }
            belongs_to_session
        }
        Err(_) => false,
    }
}

fn start_stdout_forwarder(
    app: AppHandle,
    receiver: mpsc::Receiver<Value>,
    manager: EngineManager,
    session_id: String,
) {
    thread::spawn(move || {
        for payload in receiver {
            let stopped = is_stopped_state(&payload, &session_id);
            forward_engine_payload(&app, payload);
            if stopped {
                clear_matching_engine(&manager, &session_id);
                return;
            }
        }

        let should_report_exit = clear_matching_engine(&manager, &session_id);

        if should_report_exit {
            let _ = app.emit(
                "translator-event",
                json!({
                    "type": "event",
                    "event": "error",
                    "session_id": session_id.clone(),
                    "data": {
                        "scope": "system",
                        "code": "sidecar_exited",
                        "message": "翻译引擎已意外停止，请重新开始会话。",
                        "recoverable": true
                    }
                }),
            );
            let _ = app.emit(
                "translator-event",
                json!({
                    "type": "event",
                    "event": "state",
                    "session_id": session_id,
                    "data": {"state": "stopped"}
                }),
            );
        }
    });
}

fn wait_for_start_response(
    app: &AppHandle,
    receiver: &mpsc::Receiver<Value>,
    request_id: &str,
    expected_session_id: &str,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("翻译引擎启动超时".into());
        }
        match receiver.recv_timeout(remaining) {
            Ok(payload) => {
                if payload.get("type").and_then(Value::as_str) == Some("response")
                    && payload.get("id").and_then(Value::as_str) == Some(request_id)
                {
                    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
                        let acknowledged_session_id = payload
                            .pointer("/result/session_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if acknowledged_session_id != expected_session_id {
                            return Err("翻译引擎返回了不匹配的会话 ID".into());
                        }
                        return Ok(());
                    }
                    let message = payload
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("翻译引擎拒绝启动请求");
                    return Err(format!("翻译引擎无法启动：{message}"));
                }
                forward_engine_payload(app, payload);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => return Err("翻译引擎启动超时".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("翻译引擎在启动确认前退出".into())
            }
        }
    }
}

/// A rolling tail of the sidecar's stderr.
///
/// A GUI-subsystem build has nowhere to print it, so without keeping the last
/// lines around a Python traceback is invisible and every failure looks like the
/// bare "翻译引擎在启动确认前退出".
#[derive(Clone, Default)]
struct StderrLog {
    lines: Arc<Mutex<Vec<String>>>,
}

impl StderrLog {
    fn push(&self, line: String) {
        if let Ok(mut lines) = self.lines.lock() {
            if lines.len() >= STDERR_HISTORY_LINES {
                lines.remove(0);
            }
            lines.push(line);
        }
    }

    fn tail(&self) -> String {
        let Ok(lines) = self.lines.lock() else {
            return String::new();
        };
        let joined = lines
            .iter()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" | ");
        if joined.chars().count() <= MAX_STDERR_DETAIL_CHARS {
            joined
        } else {
            joined
                .chars()
                .skip(joined.chars().count() - MAX_STDERR_DETAIL_CHARS)
                .collect()
        }
    }
}

fn with_engine_detail(error: String, stderr_log: &StderrLog) -> String {
    let detail = stderr_log.tail();
    if detail.is_empty() {
        error
    } else {
        format!("{error}（引擎输出：{detail}）")
    }
}

fn start_stderr_forwarder(stderr: ChildStderr) -> StderrLog {
    let log = StderrLog::default();
    let sink = log.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("translator sidecar: {line}");
            sink.push(line);
        }
    });
    log
}

fn desktop_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("src-tauri must be nested under desktop")
        .to_path_buf()
}

fn launch_engine() -> Result<Child, String> {
    let mut command = if cfg!(debug_assertions) {
        let root = desktop_root();
        let python = root.join(".venv").join("Scripts").join("python.exe");
        let bridge = root.join("scripts").join("tauri_bridge.py");
        if !python.exists() || !bridge.exists() {
            return Err("未找到开发用 Python 引擎。请先运行 scripts\\install.ps1。".into());
        }
        let mut command = Command::new(python);
        command.arg("-u").arg(bridge);
        command
    } else {
        // Tauri's `externalBin` build step copies the target-suffixed file to
        // the application executable directory and strips the target suffix.
        let executable_dir = env::current_exe()
            .map_err(|error| format!("无法定位应用程序目录：{error}"))?
            .parent()
            .map(Path::to_path_buf)
            .ok_or("无法定位已打包的翻译引擎目录")?;
        let executable = executable_dir.join("translator-bridge.exe");
        if !executable.exists() {
            return Err("已打包的翻译引擎缺失。请重新安装应用。".into());
        }
        Command::new(executable)
    };

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("无法启动翻译引擎：{error}"))
}

fn run_probe_request(command: &str, params: Value) -> Result<Value, String> {
    let mut child = launch_engine()?;
    let mut stderr_log = StderrLog::default();
    let result = (|| {
        let mut stdin = child.stdin.take().ok_or("翻译引擎未提供标准输入")?;
        let stdout = child.stdout.take().ok_or("翻译引擎未提供标准输出")?;
        let stderr = child.stderr.take().ok_or("翻译引擎未提供错误输出")?;
        let receiver = start_stdout_reader(stdout);
        stderr_log = start_stderr_forwarder(stderr);
        let request_id = Uuid::new_v4().to_string();
        write_json_line(
            &mut stdin,
            json!({
                "type": "request",
                "id": request_id,
                "command": command,
                "params": params
            }),
        )?;

        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("服务检测超时".into());
            }
            match receiver.recv_timeout(remaining) {
                Ok(payload)
                    if payload.get("type").and_then(Value::as_str) == Some("response")
                        && payload.get("id").and_then(Value::as_str)
                            == Some(request_id.as_str()) =>
                {
                    if payload.get("ok").and_then(Value::as_bool) == Some(true) {
                        return Ok(payload.get("result").cloned().unwrap_or_else(|| json!({})));
                    }
                    let message = payload
                        .pointer("/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("服务检测失败");
                    return Err(message.to_string());
                }
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => return Err("服务检测超时".into()),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("翻译引擎在服务检测完成前退出".into())
                }
            }
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    result.map_err(|error| with_engine_detail(error, &stderr_log))
}

fn normalize_probe_provider(input: &ProviderProbeInput) -> Result<TranslationProvider, String> {
    let selected_model = if input.provider.model.trim().is_empty() {
        "model-list-probe".to_string()
    } else {
        input.provider.model.trim().to_string()
    };
    normalize_translation_provider(TranslationProvider {
        id: input.provider_id.clone(),
        name: "待检测服务商".into(),
        protocol: input.provider.protocol.clone(),
        base_url: input.provider.base_url.clone(),
        models: vec![selected_model.clone()],
        selected_model,
    })
}

fn resolve_probe_key(
    app: &AppHandle,
    input: &ProviderProbeInput,
    normalized: &TranslationProvider,
) -> Result<String, String> {
    if let Some(api_key) = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if api_key.len() > MAX_API_KEY_BYTES {
            return Err("API Key 过长".into());
        }
        return Ok(api_key.to_string());
    }
    let _guard = lock_settings_credentials()?;
    let settings = load_public_settings_internal(app, false)?;
    let stored = settings
        .translation_providers
        .iter()
        .find(|provider| provider.id == normalized.id)
        .ok_or_else(|| "请先填写 API Key，或保存服务商后再检测".to_string())?;
    if stored.protocol != normalized.protocol || stored.base_url != normalized.base_url {
        return Err("服务商协议或地址已更改；为保护已保存密钥，请重新输入 API Key 后再检测".into());
    }
    resolve_provider_secret(stored)
}

fn probe_params(provider: &TranslationProvider, api_key: &str) -> Value {
    json!({
        "kind": "translation",
        "provider": {
            "protocol": provider.protocol,
            "base_url": provider.base_url,
            "model": provider.selected_model
        },
        "secrets": {"api_key": api_key}
    })
}

fn wait_for_engine_exit(child: &mut Child, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return false,
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn stop_locked(process: &mut Option<EngineProcess>) {
    if let Some(mut engine) = process.take() {
        // Ask the sidecar to close its recognition stream first, and only fall
        // back to killing the process when it does not exit within the grace
        // period. Killing straight away leaves the ASR task dangling.
        let requested_shutdown = write_json_line(
            &mut engine.stdin,
            json!({"type": "request", "id": Uuid::new_v4().to_string(), "command": "shutdown", "params": {}}),
        )
        .is_ok();
        if !requested_shutdown || !wait_for_engine_exit(&mut engine.child, ENGINE_SHUTDOWN_GRACE) {
            let _ = engine.child.kill();
        }
        let _ = engine.child.wait();
    }
}

/// Every command in this file touches the credential store, the settings file
/// or the sidecar process. A synchronous Tauri command runs on the main thread,
/// which stops the window from repainting for as long as it blocks, so each one
/// hands its work to the runtime's blocking pool instead.
async fn spawn_command<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("后台任务异常结束：{error}"))?
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<SettingsSnapshot, String> {
    spawn_command(move || snapshot(&app)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveSessionSnapshot {
    session_id: Option<String>,
}

fn active_session_blocking(manager: &EngineManager) -> Result<ActiveSessionSnapshot, String> {
    let mut process = manager.process.lock().map_err(|_| "翻译引擎状态不可用".to_string())?;
    let has_exited = if let Some(engine) = process.as_mut() {
        engine
            .child
            .try_wait()
            .map_err(|error| format!("无法检查翻译引擎状态：{error}"))?
            .is_some()
    } else {
        false
    };
    if has_exited {
        process.take();
    }
    Ok(ActiveSessionSnapshot {
        session_id: process.as_ref().map(|engine| engine.session_id.clone()),
    })
}

#[tauri::command]
async fn get_active_session(
    manager: State<'_, EngineManager>,
) -> Result<ActiveSessionSnapshot, String> {
    let manager = manager.inner().clone();
    spawn_command(move || active_session_blocking(&manager)).await
}

fn fetch_provider_models_blocking(app: AppHandle, input: ProviderProbeInput) -> Result<Value, String> {
    let provider = normalize_probe_provider(&input)?;
    let api_key = resolve_probe_key(&app, &input, &provider)?;
    let result = run_probe_request("probe.models", probe_params(&provider, &api_key))?;
    // Deduplicate before truncating, otherwise a list padded with repeats hides
    // models the service actually offers.
    let mut models = result
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "服务返回了无效的模型列表".to_string())?
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty() && model.len() <= MAX_MODEL_ID_BYTES)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    models.sort_unstable();
    models.truncate(MAX_MODELS_PER_PROVIDER);
    Ok(json!({
        "models": models,
        "supported": result.get("supported").and_then(Value::as_bool).unwrap_or(true)
    }))
}

fn test_provider_connection_blocking(app: AppHandle, input: ProviderProbeInput) -> Result<Value, String> {
    if input.provider.model.trim().is_empty() {
        return Err("请先添加并选择一个模型".into());
    }
    let provider = normalize_probe_provider(&input)?;
    let api_key = resolve_probe_key(&app, &input, &provider)?;
    let result = run_probe_request("probe.connect", probe_params(&provider, &api_key))?;
    Ok(json!({
        "ok": result.get("ok").and_then(Value::as_bool).unwrap_or(true),
        "latencyMs": result.get("latency_ms").and_then(Value::as_u64).unwrap_or(0),
        "detail": result.get("detail").and_then(Value::as_str).unwrap_or("模型响应正常")
    }))
}

async fn run_probe_blocking<T, F>(gate: Arc<Mutex<()>>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    spawn_command(move || {
        let _guard = gate
            .try_lock()
            .map_err(|_| "已有服务检测正在进行，请等待完成".to_string())?;
        operation()
    })
    .await
}

#[tauri::command]
async fn fetch_provider_models(
    app: AppHandle,
    manager: State<'_, ProbeManager>,
    input: ProviderProbeInput,
) -> Result<Value, String> {
    let gate = manager.gate.clone();
    run_probe_blocking(gate, move || fetch_provider_models_blocking(app, input)).await
}

#[tauri::command]
async fn test_provider_connection(
    app: AppHandle,
    manager: State<'_, ProbeManager>,
    input: ProviderProbeInput,
) -> Result<Value, String> {
    let gate = manager.gate.clone();
    run_probe_blocking(gate, move || test_provider_connection_blocking(app, input)).await
}

#[tauri::command]
async fn save_settings(app: AppHandle, input: SettingsInput) -> Result<SettingsSnapshot, String> {
    spawn_command(move || save_settings_blocking(&app, input)).await
}

fn save_settings_blocking(app: &AppHandle, input: SettingsInput) -> Result<SettingsSnapshot, String> {
    let _guard = lock_settings_credentials()?;
    let previous = load_public_settings_internal(app, false)?;
    let normalized = normalize_settings(&input)?;
    let recognition_change = requested_secret_change(
        input.recognition.api_key.as_deref(),
        input.recognition.clear_api_key.unwrap_or(false),
        "语音识别 API Key",
    )?;
    let recognition_target_changed = previous.recognition.protocol != normalized.recognition.protocol
        || previous.recognition.base_url != normalized.recognition.base_url;
    if recognition_target_changed
        && recognition_change.is_none()
        && !matches!(
            recognition_secret_source(&previous.recognition)?,
            SecretSource::Missing
        )
    {
        return Err("语音识别服务地址已更改，请重新输入 API Key 或明确删除旧密钥".into());
    }
    let reset_recognition_environment_binding = input.recognition.clear_api_key.unwrap_or(false)
        || recognition_target_changed;

    let mut provider_changes = Vec::with_capacity(input.translation_providers.len());
    for (provider_input, provider) in input
        .translation_providers
        .iter()
        .zip(normalized.translation_providers.iter())
    {
        let change = requested_secret_change(
            provider_input.api_key.as_deref(),
            provider_input.clear_api_key.unwrap_or(false),
            &format!("服务商“{}”的 API Key", provider.name),
        )?;
        if let Some(stored) = previous
            .translation_providers
            .iter()
            .find(|stored| stored.id == provider.id)
        {
            if (stored.protocol != provider.protocol || stored.base_url != provider.base_url)
                && change.is_none()
                && !matches!(provider_secret_source(stored)?, SecretSource::Missing)
            {
                return Err(format!(
                    "服务商“{}”的协议或地址已更改，请重新输入 API Key 或明确删除旧密钥",
                    provider.name
                ));
            }
        }
        provider_changes.push(change);
    }

    let mut planned_secrets: Vec<(String, Option<String>)> = Vec::new();
    let mut plan_secret = |account: String, value: Option<String>| {
        if let Some(existing) = planned_secrets
            .iter_mut()
            .find(|(existing_account, _)| *existing_account == account)
        {
            existing.1 = value;
        } else {
            planned_secrets.push((account, value));
        }
    };
    if let Some(change) = recognition_change {
        match change {
            Some(secret) => {
                let mut storage = Vec::new();
                plan_scoped_secret_storage(
                    &mut storage,
                    RECOGNITION_ACCOUNT.into(),
                    &secret,
                    secret_scope(
                        &normalized.recognition.protocol,
                        &normalized.recognition.base_url,
                    )?,
                )?;
                for (account, value) in storage {
                    plan_secret(account, value);
                }
            }
            None => {
                plan_secret(RECOGNITION_ACCOUNT.into(), None);
                plan_secret(secret_binding_account(RECOGNITION_ACCOUNT), None);
            }
        }
    }
    if reset_recognition_environment_binding {
        plan_secret(RECOGNITION_ENV_BINDING_ACCOUNT.into(), None);
    }
    for ((provider_input, provider), change) in input
        .translation_providers
        .iter()
        .zip(normalized.translation_providers.iter())
        .zip(provider_changes)
    {
        if let Some(change) = change {
            let account = provider_account(&provider.id);
            match change {
                Some(secret) => {
                    let mut storage = Vec::new();
                    plan_scoped_secret_storage(
                        &mut storage,
                        account,
                        &secret,
                        secret_scope(&provider.protocol, &provider.base_url)?,
                    )?;
                    for (account, value) in storage {
                        plan_secret(account, value);
                    }
                }
                None => {
                    plan_secret(account.clone(), None);
                    plan_secret(secret_binding_account(&account), None);
                }
            }
        }
        if provider_input.clear_api_key.unwrap_or(false)
            && provider.id == DEFAULT_TRANSLATION_PROVIDER_ID
        {
            plan_secret(LEGACY_GEMINI_ACCOUNT.into(), None);
            plan_secret(secret_binding_account(LEGACY_GEMINI_ACCOUNT), None);
        }
        if provider.id == DEFAULT_TRANSLATION_PROVIDER_ID {
            let target_changed = previous
                .translation_providers
                .iter()
                .find(|stored| stored.id == provider.id)
                .is_some_and(|stored| {
                    stored.protocol != provider.protocol || stored.base_url != provider.base_url
                });
            if provider_input.clear_api_key.unwrap_or(false) || target_changed {
                plan_secret(GEMINI_ENV_BINDING_ACCOUNT.into(), None);
            }
        }
    }

    let retained_ids = normalized
        .translation_providers
        .iter()
        .map(|provider| provider.id.as_str())
        .collect::<HashSet<_>>();
    for removed in previous
        .translation_providers
        .iter()
        .filter(|provider| !retained_ids.contains(provider.id.as_str()))
    {
        let account = provider_account(&removed.id);
        plan_secret(account.clone(), None);
        plan_secret(secret_binding_account(&account), None);
        if removed.id == DEFAULT_TRANSLATION_PROVIDER_ID {
            plan_secret(LEGACY_GEMINI_ACCOUNT.into(), None);
            plan_secret(GEMINI_ENV_BINDING_ACCOUNT.into(), None);
        }
    }

    commit_settings_and_secrets(app, &normalized, &planned_secrets)?;

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(normalized.keep_on_top);
    }
    Ok(snapshot_from_settings(normalized))
}

fn active_translation_provider(settings: &PublicSettings) -> Result<&TranslationProvider, String> {
    settings
        .translation_providers
        .iter()
        .find(|provider| provider.id == settings.active_translation_provider_id)
        .ok_or_else(|| "当前翻译服务商不存在，请重新保存设置".into())
}

fn build_start_request(
    request_id: &str,
    session_id: &str,
    settings: &PublicSettings,
    recognition_key: &str,
    translation_key: &str,
) -> Result<Value, String> {
    let provider = active_translation_provider(settings)?;
    Ok(json!({
        "type": "request",
        "id": request_id,
        "command": "start",
        "params": {
            "session_id": session_id,
            "config": {
                "sourceLanguage": settings.source_language,
                "targetLanguage": settings.target_language,
                "recognition": {
                    "protocol": settings.recognition.protocol,
                    "baseUrl": settings.recognition.base_url,
                    "model": settings.recognition.model
                },
                "translation": {
                    "protocol": provider.protocol,
                    "baseUrl": provider.base_url,
                    "model": provider.selected_model
                }
            },
            "secrets": {
                "recognition_api_key": recognition_key,
                "translation_api_key": translation_key
            }
        }
    }))
}

#[tauri::command]
async fn start_translation(
    app: AppHandle,
    manager: State<'_, EngineManager>,
) -> Result<StartResult, String> {
    let manager = manager.inner().clone();
    spawn_command(move || start_translation_blocking(app, &manager)).await
}

fn start_translation_blocking(app: AppHandle, manager: &EngineManager) -> Result<StartResult, String> {
    let settings_guard = lock_settings_credentials()?;
    let settings = load_public_settings_internal(&app, false)?;
    let recognition_key = resolve_recognition_secret(&settings.recognition)?;
    let translation_key = resolve_provider_secret(active_translation_provider(&settings)?)?;
    drop(settings_guard);
    let session_id = Uuid::new_v4().to_string();

    let mut process = manager.process.lock().map_err(|_| "翻译引擎状态不可用".to_string())?;
    stop_locked(&mut process);

    let mut child = launch_engine()?;
    let mut stdin = child.stdin.take().ok_or("翻译引擎未提供标准输入")?;
    let stdout = child.stdout.take().ok_or("翻译引擎未提供标准输出")?;
    let stderr = child.stderr.take().ok_or("翻译引擎未提供错误输出")?;
    let stdout_receiver = start_stdout_reader(stdout);
    let stderr_log = start_stderr_forwarder(stderr);

    let request_id = Uuid::new_v4().to_string();
    let request = build_start_request(
        &request_id,
        &session_id,
        &settings,
        &recognition_key,
        &translation_key,
    )?;
    if let Err(error) = write_json_line(&mut stdin, request) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(with_engine_detail(error, &stderr_log));
    }
    if let Err(error) = wait_for_start_response(&app, &stdout_receiver, &request_id, &session_id) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(with_engine_detail(error, &stderr_log));
    }
    *process = Some(EngineProcess { child, stdin, session_id: session_id.clone() });
    start_stdout_forwarder(
        app.clone(),
        stdout_receiver,
        manager.clone(),
        session_id.clone(),
    );
    Ok(StartResult { session_id })
}

#[tauri::command]
async fn stop_translation(
    manager: State<'_, EngineManager>,
    session_id: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    spawn_command(move || stop_translation_blocking(&manager, &session_id)).await
}

fn stop_translation_blocking(manager: &EngineManager, session_id: &str) -> Result<(), String> {
    let mut process = manager.process.lock().map_err(|_| "翻译引擎状态不可用".to_string())?;
    if process
        .as_ref()
        .is_some_and(|engine| engine.session_id == session_id)
    {
        stop_locked(&mut process);
    }
    Ok(())
}

fn cleanup_engine(manager: &EngineManager) {
    if let Ok(mut process) = manager.process.lock() {
        stop_locked(&mut process);
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(EngineManager::default())
        .manage(ProbeManager::default())
        .setup(|app| {
            if let Ok(settings) = load_public_settings(&app.handle()) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_always_on_top(settings.keep_on_top);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            get_active_session,
            fetch_provider_models,
            test_provider_connection,
            save_settings,
            start_translation,
            stop_translation
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                cleanup_engine(window.state::<EngineManager>().inner());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the simultaneous translator desktop app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_legacy_settings_without_losing_provider_values() {
        let migrated = decode_public_settings(
            r#"{
                "dashscopeWsUrl":"wss://dashscope.example/ws",
                "geminiBaseUrl":"https://relay.example/gemini/v1beta",
                "geminiModel":"custom-gemini-model",
                "sourceLanguage":"English",
                "targetLanguage":"简体中文",
                "keepOnTop":true,
                "captionScale":"large"
            }"#,
        )
        .expect("legacy settings should migrate");

        assert_eq!(migrated.schema_version, SETTINGS_SCHEMA_VERSION);
        assert_eq!(migrated.recognition.base_url, "wss://dashscope.example/ws");
        assert_eq!(migrated.translation_providers.len(), 1);
        let provider = &migrated.translation_providers[0];
        assert_eq!(provider.id, DEFAULT_TRANSLATION_PROVIDER_ID);
        assert_eq!(provider.base_url, "https://relay.example/gemini");
        assert_eq!(provider.selected_model, "custom-gemini-model");
        assert_eq!(provider.models, vec!["custom-gemini-model"]);
        assert!(migrated.keep_on_top);
        assert_eq!(migrated.caption_scale, "large");
    }

    #[test]
    fn normalizes_models_and_rejects_duplicate_provider_ids() {
        let mut settings = PublicSettings::default();
        settings.translation_providers[0].models = vec![
            " gemini-2.5-flash ".into(),
            "gemini-2.5-flash".into(),
        ];
        settings.translation_providers[0].selected_model = "custom-model".into();
        let normalized = normalize_public_settings(settings.clone()).expect("settings are valid");
        assert_eq!(
            normalized.translation_providers[0].models,
            vec!["gemini-2.5-flash", "custom-model"]
        );

        settings.translation_providers.push(settings.translation_providers[0].clone());
        assert!(normalize_public_settings(settings)
            .expect_err("duplicate IDs must fail")
            .contains("重复"));
    }

    #[test]
    fn rejects_unsupported_future_settings_version() {
        let error = decode_public_settings(
            r#"{"schemaVersion":5,"translationProviders":[]}"#,
        )
        .expect_err("future settings must not be interpreted as v2");
        assert_eq!(error, SettingsDecodeError::UnsupportedVersion(5));
    }

    #[test]
    fn version_two_settings_are_marked_for_credential_migration() {
        let mut value = serde_json::to_value(PublicSettings::default())
            .expect("default settings should serialize");
        value["schemaVersion"] = json!(2);
        let (settings, source_version) = decode_public_settings_versioned(
            &serde_json::to_string(&value).expect("v2 fixture should serialize"),
        )
        .expect("v2 settings should remain readable");
        assert_eq!(source_version, 2);
        assert_eq!(settings.schema_version, SETTINGS_SCHEMA_VERSION);
    }

    #[test]
    fn legacy_gemini_alias_never_targets_an_openai_provider() {
        let mut provider = TranslationProvider::default();
        provider.protocol = "openai".into();
        provider.base_url = "https://api.openai.com".into();
        assert!(!is_legacy_gemini_provider(&provider));

        provider.protocol = "gemini".into();
        provider.id = "custom-gemini".into();
        assert!(!is_legacy_gemini_provider(&provider));
    }

    #[test]
    fn legacy_alias_never_overwrites_an_unusable_scoped_account() {
        assert!(legacy_alias_can_fill(AccountMigrationState::Missing));
        assert!(!legacy_alias_can_fill(
            AccountMigrationState::UsableOrPlanned
        ));
        assert!(!legacy_alias_can_fill(AccountMigrationState::Unusable));
    }

    #[test]
    fn stored_secret_is_bound_to_its_protocol_and_full_endpoint() {
        let scope = SecretScope {
            protocol: "openai".into(),
            endpoint_hash: "relay-hash".into(),
        };
        let encoded = encode_scoped_secret("secret-value", scope.clone())
            .expect("secret envelope should serialize");
        assert_eq!(
            decode_scoped_secret(encoded.clone(), &scope),
            ScopedSecret::Available("secret-value".into())
        );
        assert_eq!(
            decode_scoped_secret(
                encoded,
                &SecretScope {
                    protocol: "openai".into(),
                    endpoint_hash: "other-hash".into(),
                },
            ),
            ScopedSecret::ScopeMismatch
        );
    }

    #[test]
    fn endpoint_scope_distinguishes_paths_on_the_same_origin() {
        let first = secret_scope("openai", "https://relay.example/tenant-a")
            .expect("first endpoint scope should be created");
        let second = secret_scope("openai", "https://relay.example/tenant-b")
            .expect("second endpoint scope should be created");
        assert_ne!(first.endpoint_hash, second.endpoint_hash);
    }

    #[test]
    fn schema_three_origin_envelope_upgrades_only_for_its_matching_origin() {
        let mut settings_value = serde_json::to_value(PublicSettings::default())
            .expect("default settings should serialize");
        settings_value["schemaVersion"] = json!(3);
        let (_, source_version) = decode_public_settings_versioned(
            &serde_json::to_string(&settings_value).expect("v3 fixture should serialize"),
        )
        .expect("v3 settings should remain readable");
        assert_eq!(source_version, 3);

        let base_url = "https://relay.example/tenant-a";
        let current_scope = secret_scope("openai", base_url)
            .expect("current endpoint scope should be created");
        let legacy_scope = legacy_secret_scope("openai", base_url)
            .expect("legacy endpoint scope should be created");
        let stored = json!({
            "version": 1,
            "secret": "existing-key",
            "scope": {
                "protocol": "openai",
                "origin": "https://relay.example"
            }
        })
        .to_string();
        assert_eq!(
            inspect_secret_for_upgrade(
                &stored,
                None,
                &current_scope,
                &legacy_scope,
                source_version,
            ),
            SecretUpgrade::Upgrade("existing-key".into())
        );

        let other_origin = legacy_secret_scope("openai", "https://other.example/tenant-a")
            .expect("comparison endpoint scope should be created");
        assert_eq!(
            inspect_secret_for_upgrade(
                &stored,
                None,
                &current_scope,
                &other_origin,
                source_version,
            ),
            SecretUpgrade::Unusable
        );
    }

    #[test]
    fn only_an_existing_legacy_environment_binding_can_be_upgraded() {
        let base_url = "https://relay.example/tenant-a";
        let current_scope = secret_scope("gemini", base_url)
            .expect("current endpoint scope should be created");
        let legacy_scope = legacy_secret_scope("gemini", base_url)
            .expect("legacy endpoint scope should be created");
        let stored_binding = json!({
            "version": 1,
            "scope": {
                "protocol": "gemini",
                "origin": "https://relay.example"
            }
        })
        .to_string();

        assert!(environment_binding_needs_upgrade(
            Some(&stored_binding),
            &current_scope,
            &legacy_scope,
        ));
        assert!(!environment_binding_needs_upgrade(
            None,
            &current_scope,
            &legacy_scope,
        ));
    }

    #[test]
    fn rejects_conflicting_secret_mutation() {
        let error = requested_secret_change(Some("replacement"), true, "API Key")
            .expect_err("set and clear must be mutually exclusive");
        assert!(error.contains("同时替换和删除"));
    }

    #[test]
    fn rejects_secret_envelopes_larger_than_windows_supports() {
        let error = encode_scoped_secret(
            &"a".repeat(2_000),
            SecretScope {
                protocol: "openai".into(),
                endpoint_hash: "relay-hash".into(),
            },
        )
        .expect_err("oversized Windows credential blobs must fail before mutation");
        assert!(error.contains("Windows 凭据管理器限制"));
    }

    #[test]
    fn stores_near_limit_secret_with_a_separate_scope_binding() {
        let account = "translation_provider:legacy".to_string();
        let mut plan = Vec::new();
        plan_scoped_secret_storage(
            &mut plan,
            account.clone(),
            &"a".repeat(1_250),
            SecretScope {
                protocol: "openai".into(),
                endpoint_hash: "relay-hash".into(),
            },
        )
        .expect("an existing credential that fits Windows should remain migratable");
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].0, secret_binding_account(&account));
        assert!(plan[0].1.is_some());
        assert_eq!(plan[1], (account, Some("a".repeat(1_250))));
    }

    #[test]
    fn start_request_uses_only_the_selected_provider_contract() {
        let mut settings = PublicSettings::default();
        settings.translation_providers.push(TranslationProvider {
            id: "openai-custom".into(),
            name: "Custom OpenAI".into(),
            protocol: "openai".into(),
            base_url: "https://relay.example".into(),
            models: vec!["chat-model".into()],
            selected_model: "chat-model".into(),
        });
        settings.active_translation_provider_id = "openai-custom".into();
        let request = build_start_request(
            "request-id",
            "session-id",
            &settings,
            "recognition-secret",
            "translation-secret",
        )
        .expect("request should serialize");

        assert_eq!(
            request.pointer("/params/config/translation/protocol"),
            Some(&json!("openai"))
        );
        assert_eq!(
            request.pointer("/params/config/translation/baseUrl"),
            Some(&json!("https://relay.example"))
        );
        assert_eq!(
            request.pointer("/params/config/translation/model"),
            Some(&json!("chat-model"))
        );
        assert_eq!(
            request.pointer("/params/secrets/translation_api_key"),
            Some(&json!("translation-secret"))
        );
        assert_eq!(
            request.pointer("/params/secrets/recognition_api_key"),
            Some(&json!("recognition-secret"))
        );
        assert!(request.pointer("/params/config/geminiModel").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_keyring_backend_is_persistent() {
        use keyring::credential::CredentialPersistence;

        assert!(matches!(
            keyring::default::default_credential_builder().persistence(),
            CredentialPersistence::UntilDelete
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_keyring_round_trip_survives_a_new_entry_handle() {
        struct Cleanup(String);

        impl Drop for Cleanup {
            fn drop(&mut self) {
                if let Ok(entry) = credential_entry(&self.0) {
                    let _ = entry.delete_credential();
                }
            }
        }

        let account = format!("test-round-trip:{}", Uuid::new_v4());
        let _cleanup = Cleanup(account.clone());
        write_secret_value(&account, Some("test-secret"))
            .expect("Windows Credential Manager should accept the test secret");
        let reopened = credential_entry(&account)
            .expect("a new credential handle should open")
            .get_password()
            .expect("the test secret should still be present");
        assert_eq!(reopened, "test-secret");
    }
}
