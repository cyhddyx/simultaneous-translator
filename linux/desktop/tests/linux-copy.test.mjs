import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Guards the Linux port (PORTING_CONTRACT.md §5 D14): the front end is a Linux
// copy that must not carry Windows-only wording or the VB-CABLE installer flow.
// It also pins the package scripts to the shell entry points owned by the Linux
// engine scripts.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const read = (path) => readFileSync(path, "utf8");
const sources = readdirSync(srcDir)
  .filter((name) => /\.(ts|tsx|css)$/.test(name))
  .map((name) => ({ name, text: read(join(srcDir, name)) }));
const source = (name) => sources.find((entry) => entry.name === name)?.text ?? "";

const WINDOWS_ONLY = [
  ["Windows platform wording", /\bWindows\b/],
  ["VB-CABLE / VB-Cable", /VB-?CABLE/i],
  ["CABLE Input/Output device names", /CABLE (?:Input|Output)/],
  ["Windows credential manager", /凭据管理器/],
  ["official component installer copy", /安装官方组件/],
  ["PowerShell / npx", /PowerShell|powershell|\bnpx\b/],
];

test("front-end sources carry no Windows-only wording", () => {
  const offenders = [];
  for (const entry of sources) {
    for (const [label, pattern] of WINDOWS_ONLY) {
      const match = entry.text.match(pattern);
      if (match) offenders.push(`${entry.name}: ${label} (${match[0]})`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the virtual microphone copy replaces the VB-CABLE installer flow", () => {
  const section = source("VirtualMicrophoneSection.tsx");
  assert.match(section, /PulseAudio/);
  assert.match(section, /VIRTUAL_MICROPHONE_NAME/);
  assert.match(section, /无需下载驱动/);
  assert.match(section, /创建虚拟麦克风/);
  assert.doesNotMatch(section, /捐赠|授权条款|vb-audio/i);

  const routing = source("audioRouting.ts");
  assert.match(routing, /Translator Virtual Microphone/);
  assert.match(routing, /translator_mic/);
  assert.match(routing, /translator_mic_source/);
});

test("secrets, audio routing and updates are described with Linux semantics", () => {
  const settings = source("SettingsDialog.tsx");
  assert.match(settings, /系统密钥环/);
  assert.match(settings, /Secret Service/);
  assert.match(settings, /translator_mix/);
  assert.match(settings, /PulseAudio/);
  assert.doesNotMatch(settings, /Windows 凭据/);

  const update = source("AppUpdate.tsx");
  assert.match(update, /deb/);
  assert.match(update, /rpm/);
  assert.match(update, /AppImage/);
  assert.match(update, /打开下载目录/);
  assert.doesNotMatch(update, /退出并安装|安装向导|Windows 桌面版/);

  const wizard = source("AudioDeviceTestWizard.tsx");
  assert.match(wizard, /monitor/);
  assert.doesNotMatch(wizard, /WASAPI|Windows/);
});

test("package scripts use the Linux shell entry points", () => {
  const pkg = JSON.parse(read(join(root, "package.json")));
  assert.equal(pkg.scripts["desktop:dev"], "bash ../scripts/dev.sh");
  assert.equal(pkg.scripts["desktop:build"], "bash ../scripts/build.sh");
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /powershell|tauri\.ps1/i);
});
