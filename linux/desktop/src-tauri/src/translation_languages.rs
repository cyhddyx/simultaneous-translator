use crate::AudioSettings;
use serde::Deserialize;

#[derive(Deserialize)]
struct Language {
    code: String,
    label: String,
    audio: bool,
    aliases: Vec<String>,
}

#[derive(Deserialize)]
struct Catalog {
    languages: Vec<Language>,
}

pub(super) fn validate_audio_languages(audio: &AudioSettings) -> Result<(), String> {
    let catalog: Catalog =
        serde_json::from_str(include_str!("../../../scripts/translation_languages.json"))
            .map_err(|_| "无法读取模型语言列表".to_string())?;
    for (label, channel) in [("收听", &audio.listen), ("发言", &audio.speak)] {
        if !channel.enabled {
            continue;
        }
        let value = channel.target_language.trim().to_lowercase();
        let language = catalog
            .languages
            .iter()
            .find(|language| {
                [&language.code, &language.label]
                    .into_iter()
                    .chain(language.aliases.iter())
                    .any(|alias| alias.to_lowercase() == value)
            })
            .ok_or_else(|| format!("{label}通道的目标语言不受当前模型支持，请重新选择。"))?;
        if channel.play_audio && !language.audio {
            return Err(format!(
                "{label}通道：{}仅支持文字输出，不能语音播报。请改为文字输出，或选择其他译文语言。",
                language.label
            ));
        }
    }
    Ok(())
}
