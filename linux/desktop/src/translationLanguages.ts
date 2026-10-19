import catalog from "../../scripts/translation_languages.json" with { type: "json" };
import type { AudioChannelSettings, ChannelId, PublicSettings } from "./types";

export const TRANSLATION_LANGUAGES = catalog.languages;

export function findTranslationLanguage(value: string) {
  const normalized = value.trim().toLowerCase();
  return TRANSLATION_LANGUAGES.find((language) =>
    [language.code, language.label, ...language.aliases].some(
      (alias) => alias.toLowerCase() === normalized,
    ),
  );
}

export function outputLanguages(playAudio: boolean) {
  return TRANSLATION_LANGUAGES.filter((language) => !playAudio || language.audio);
}

export function outputLanguageError(channel: Pick<AudioChannelSettings, "targetLanguage" | "playAudio">) {
  const language = findTranslationLanguage(channel.targetLanguage);
  if (!language) return "当前模型不支持这个目标语言，请重新选择。";
  if (channel.playAudio && !language.audio)
    return `${language.label}仅支持文字输出，不能语音播报。请改为文字输出，或选择其他译文语言。`;
  return null;
}

export function audioLanguageErrors(audio: PublicSettings["audio"]) {
  const errors: Record<string, string> = {};
  for (const id of ["listen", "speak"] as ChannelId[]) {
    if (!audio[id].enabled) continue;
    const error = outputLanguageError(audio[id]);
    if (error) errors[`audio.${id}.targetLanguage`] = `${id === "listen" ? "收听" : "发言"}通道：${error}`;
  }
  return errors;
}
