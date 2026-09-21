import assert from "node:assert/strict";
import { test } from "node:test";
import { audioLanguageErrors, findTranslationLanguage, outputLanguageError, outputLanguages } from "../src/translationLanguages.ts";

const channel = (targetLanguage, playAudio, enabled = true) => ({ targetLanguage, playAudio, enabled });

test("speech and text expose the official 29 and 60 target languages", () => {
  assert.equal(outputLanguages(false).length, 60);
  assert.equal(new Set(outputLanguages(false).map(language => language.code)).size, 60);
  assert.deepEqual(outputLanguages(true).map(language => language.code).sort(),
    "zh en ar de fr es pt id it ko ru th vi ja tr hi ms nl ur nb sv da he fi pl is cs fil fa".split(" ").sort());
  assert(!outputLanguages(true).some(language => ["yue", "el"].includes(language.code)));
});

test("saved labels, aliases and codes resolve without changing settings", () => {
  for (const value of ["粤语", " CANTONESE ", "YUE"]) {
    assert.equal(findTranslationLanguage(value).code, "yue");
    assert.match(outputLanguageError(channel(value, true)), /仅支持文字/);
    assert.equal(outputLanguageError(channel(value, false)), null);
  }
  for (const value of ["Greek", "Ελληνικά", "希腊语", "el"])
    assert.match(outputLanguageError(channel(value, true)), /仅支持文字/);
  assert.equal(findTranslationLanguage("荷兰语").code, "nl");
  assert.equal(findTranslationLanguage("Filipino").code, "fil");
});

test("each enabled direction validates its own mode and target", () => {
  const audio = { listen: channel("粤语", false), speak: channel("English", true) };
  assert.deepEqual(audioLanguageErrors(audio), {});
  audio.listen.playAudio = true;
  const before = structuredClone(audio);
  assert.deepEqual(Object.keys(audioLanguageErrors(audio)), ["audio.listen.targetLanguage"]);
  assert.deepEqual(audio, before);
  audio.listen.enabled = false;
  assert.deepEqual(audioLanguageErrors(audio), {});
  audio.speak.targetLanguage = "el";
  assert.deepEqual(Object.keys(audioLanguageErrors(audio)), ["audio.speak.targetLanguage"]);
});

test("unknown and automatic targets never silently become English", () => {
  for (const target of ["", "auto", "自动检测", "unlisted-language"])
    assert.match(outputLanguageError(channel(target, false)), /不支持/);
});
