# 音频设备测试向导实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置中的音频页面增加一个本地设备测试向导，支持播放测试音、麦克风测试和回环测试。

**Architecture:** React 向导通过 `translatorApi.runAudioTest` 调用 Rust `run_audio_test` 命令；Rust 使用 `ProbeManager.audio_gate` 启动一次性 Python sidecar；Python 处理 `audio_test` JSONL 请求并在 `livetranslate.py` 中执行一次性 soundcard 操作。信号指标计算使用纯函数，真实设备调用只负责采样和播放。

**Tech Stack:** React 19、TypeScript、Tauri 2/Rust、Python 3、soundcard、NumPy、Node test runner、unittest。

**Spec:** `docs/superpowers/specs/2026-10-08-audio-device-test-wizard-design.md`

## Global Constraints

- 测试不联网、不调用翻译模型、不需要 API Key，不保存录音，不修改音频设置。
- 每次只运行一个测试；Rust 复用 `ProbeManager.audio_gate` 串行化音频探测。
- 播放测试音使用约 1 秒、440 Hz、受限振幅的单声道正弦波。
- 麦克风测试使用 16 kHz 单声道、约 3 秒的内存录音。
- 回环测试使用所选扬声器对应的 WASAPI loopback 端点。
- 浏览器 mock 必须返回确定性结果；真实 Tauri 运行时使用 native command。
- 现有未跟踪的 `docs/qa/` 文件不加入本次提交。

---

### Task 1: Add Pure Audio Test Contracts and Signal Helpers

**Files:**
- Create: `scripts/audio_test_helpers.py`
- Create: `scripts/test_audio_device_tests.py`
- Create: `desktop/src/audioDeviceTest.ts`
- Create: `desktop/tests/audio-device-test.test.mjs`

**Interfaces:**
- Python `AUDIO_TEST_KINDS`, `AUDIO_TEST_SAMPLE_RATE`, `AUDIO_TEST_TONE_HZ`, `AUDIO_TEST_SIGNAL_THRESHOLD`.
- Python `validate_audio_test_request(kind, device_id) -> tuple[str, str]`.
- Python `audio_metrics(samples) -> tuple[float, float]` returning `(peak, rms)` for a NumPy-like array.
- Python `signal_detected(peak, threshold=AUDIO_TEST_SIGNAL_THRESHOLD) -> bool`.
- Python `build_test_tone(duration_seconds=1.0, sample_rate=AUDIO_TEST_SAMPLE_RATE) -> ndarray`.
- TypeScript `AudioTestKind`, `AudioTestRequest`, `AudioTestResult`, `AudioTestPhase`, `audioTestLabel`, `audioTestDeviceKind`, `classifyAudioTestResult`.

- [ ] **Step 1: Write the failing Python tests**

Add tests proving request validation accepts the three kinds and rejects unknown kinds/non-string IDs, tone generation has the expected sample count and bounded amplitude, and metrics/detection distinguish silence from a signal.

```python
def test_metrics_and_threshold_distinguish_silence_from_signal(self):
    silence = np.zeros(1600, dtype=np.float32)
    tone = np.full(1600, 0.25, dtype=np.float32)
    self.assertEqual(livetranslate.audio_metrics(silence), (0.0, 0.0))
    peak, rms = livetranslate.audio_metrics(tone)
    self.assertAlmostEqual(peak, 0.25, places=3)
    self.assertAlmostEqual(rms, 0.25, places=3)
    self.assertFalse(livetranslate.signal_detected(0.0))
    self.assertTrue(livetranslate.signal_detected(peak))
```

- [ ] **Step 2: Run the focused Python test and verify it fails**

Run: `.venv\Scripts\python.exe -m unittest scripts.test_audio_device_tests -v`

Expected: FAIL because the helper functions do not exist yet.

- [ ] **Step 3: Write the minimal Python helpers**

Implement validation, tone generation with `np.linspace`/`np.sin`, float32 conversion, absolute peak and RMS calculation, and a threshold comparison. Re-export or define the helpers in `scripts/livetranslate.py` so the bridge and tests have one production import path; keep the implementation independent of real devices.

- [ ] **Step 4: Add the failing TypeScript contract tests**

Assert that each kind maps to the correct device list, result classification returns `success`, `undetected`, or `error`, and unknown wire values are normalized to an error classification.

- [ ] **Step 5: Run the focused TypeScript test and verify it fails**

Run: `cd desktop; node --experimental-strip-types --test tests/audio-device-test.test.mjs`

Expected: FAIL because `src/audioDeviceTest.ts` does not exist.

- [ ] **Step 6: Implement the TypeScript contracts and pure helpers**

Use the project’s existing `.ts`-direct Node test pattern. Keep display labels and result classification independent of React so the wizard only coordinates state.

- [ ] **Step 7: Run both focused test files and verify they pass**

Run the two commands above again; both must pass before moving to native integration.

- [ ] **Step 8: Commit the helper and contract layer**

```powershell
git add scripts/livetranslate.py scripts/test_audio_device_tests.py desktop/src/audioDeviceTest.ts desktop/tests/audio-device-test.test.mjs
git commit -m "feat: add audio device test contracts"
```

### Task 2: Implement Python Sidecar Audio Tests

**Files:**
- Modify: `scripts/livetranslate.py`
- Modify: `scripts/tauri_bridge.py`
- Modify: `scripts/test_tauri_bridge.py`
- Modify: `scripts/test_audio_device_tests.py`

**Interfaces:**
- Python `run_audio_test(kind: str, device_id: str = "") -> dict[str, Any]`.
- Bridge `BridgeServer._audio_test(request_id, params)` dispatching `audio_test`.
- Error codes `invalid_audio_test_request` and `audio_test_failed`.

- [ ] **Step 1: Write failing fake-device tests for all three operations**

Create fake speaker/player and fake microphone/recorder objects. Test that playback opens the selected/default speaker and calls `player.play` with the generated tone; microphone records and returns metrics; loopback opens `include_loopback=True`, plays the tone, records, and returns `detected` according to metrics. Add a bridge test that sends `{"command": "audio_test"}` and returns the fake result.

- [ ] **Step 2: Run the focused tests and verify the expected failures**

Run: `.venv\Scripts\python.exe -m unittest scripts.test_audio_device_tests scripts.test_tauri_bridge -v`

Expected: new tests fail because `run_audio_test` and the `audio_test` command are missing; existing bridge tests must continue to run.

- [ ] **Step 3: Implement `livetranslate.run_audio_test`**

Use `_ensure_com_initialized()` and import `soundcard` inside the function. Resolve speakers with `sc.get_speaker(device_id)` or `sc.default_speaker()`, microphones with `sc.get_microphone(device_id)` or `sc.default_microphone()`, and loopback microphones with `sc.get_microphone(id=device_id, include_loopback=True)`. Use context managers for player/recorder and always release them. Return camelCase keys expected by Rust/frontend: `ok`, `kind`, `device_id`, `device_name`, `duration_ms`, `peak`, `rms`, `detected`, `detail`. Convert all device/open/record/play exceptions into bounded `RuntimeError` messages so the bridge can report one stable error.

- [ ] **Step 4: Implement bridge validation and dispatch**

Add `audio_test` to the module request documentation and ready command list. Read `kind` and optional `device_id` through the existing validation helpers, call `livetranslate.run_audio_test`, and return `invalid_audio_test_request` for malformed parameters or `audio_test_failed` for hardware errors. Do not expose secrets or tracebacks in the JSONL error message.

- [ ] **Step 5: Run focused tests and verify green**

Run the focused unittest command again. Then run `.venv\Scripts\python.exe -m unittest scripts.test_audio_isolation scripts.test_runtime_channels -v` to make sure the audio additions do not alter existing runtime contracts.

- [ ] **Step 6: Commit the Python sidecar implementation**

```powershell
git add scripts/livetranslate.py scripts/tauri_bridge.py scripts/test_tauri_bridge.py scripts/test_audio_device_tests.py
git commit -m "feat: add native audio device probes"
```

### Task 3: Expose the Tauri and Frontend API

**Files:**
- Modify: `desktop/src/types.ts`
- Modify: `desktop/src/tauri.ts`
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src-tauri/src/lib.rs` tests if command input coverage belongs there

**Interfaces:**
- Rust `run_audio_test(manager: State<'_, ProbeManager>, input: AudioTestInput) -> Result<Value, String>`.
- Rust `AudioTestInput { kind: String, device_id: String }` with camelCase serde mapping.
- TypeScript `translatorApi.runAudioTest(request: AudioTestRequest): Promise<AudioTestResult>`.

- [ ] **Step 1: Write the failing TypeScript API tests**

Extend `desktop/tests/audio-device-test.test.mjs` with a mock-free test for request/result normalization helpers. Keep the invoke boundary thin; the test should assert browser mode returns the deterministic mock result and does not require Tauri globals.

- [ ] **Step 2: Run the focused test and verify the new API is missing**

Run: `cd desktop; node --experimental-strip-types --test tests/audio-device-test.test.mjs`

Expected: FAIL because `translatorApi.runAudioTest` is not present.

- [ ] **Step 3: Add the Rust input struct, command and registration**

Add `AudioTestInput` near the existing provider probe inputs. Implement the command with `manager.audio_gate.lock()` (or the same blocking guard style used by `list_audio_devices`) and call `run_probe_request("audio_test", json!({"kind": input.kind, "device_id": input.device_id}))`. Register `run_audio_test` in `tauri::generate_handler!`.

- [ ] **Step 4: Add the TypeScript API and browser mock**

Import the new types, serialize `kind` and `deviceId` to the Tauri command input, normalize the returned snake_case device fields if needed, and return a short deterministic result in browser mode after a small timeout. Preserve the existing `isTauriRuntime()` split.

- [ ] **Step 5: Add Rust command/input tests if the local test module exposes the existing probe patterns**

Cover camelCase serialization and the three allowed kinds using the same serde/value assertions already present in `lib.rs`; do not start a real sidecar in Rust unit tests.

- [ ] **Step 6: Run frontend build and Rust tests**

Run: `cd desktop; npm run build`

Run: `cd desktop/src-tauri; cargo test`

Expected: both pass before the UI component is added.

- [ ] **Step 7: Commit the native/frontend API layer**

```powershell
git add desktop/src/types.ts desktop/src/tauri.ts desktop/src-tauri/src/lib.rs desktop/tests/audio-device-test.test.mjs
git commit -m "feat: expose audio device test command"
```

### Task 4: Build and Integrate the React Test Wizard

**Files:**
- Create: `desktop/src/AudioDeviceTestWizard.tsx`
- Modify: `desktop/src/SettingsDialog.tsx`
- Modify: `desktop/src/styles.css`

**Interfaces:**
- Component props: `devices: AudioDeviceList | null`, `busy: boolean`, `error: string | null`, `sessionActive: boolean`, `onClose: () => void`.
- The component calls `translatorApi.runAudioTest` and uses `audioDeviceTest.ts` for labels/classification.

- [ ] **Step 1: Write the failing pure state tests**

Add tests for initial idle state, starting one test disables the other choices, stale request results being ignored after a new run, and `success`/`undetected`/`error` result copy. Keep React rendering out of Node tests because the repository has no DOM test dependency.

- [ ] **Step 2: Run the focused UI state test and verify it fails**

Run: `cd desktop; node --experimental-strip-types --test tests/audio-device-test.test.mjs`

Expected: FAIL for the missing wizard state helpers.

- [ ] **Step 3: Implement the wizard component**

Use the existing modal backdrop and settings button classes. Render three test cards/buttons with `Volume2`, `Mic`, and `AudioLines`/`Radio` icons from `lucide-react`; show the relevant device select, start button, progress state, result metrics and retry/back controls. Disable the start controls when `sessionActive`, `busy`, no matching device exists, or another test is running. Ignore stale promises using a monotonically increasing request ref. Close should invalidate the active request token.

- [ ] **Step 4: Add the entry point to the audio settings section**

Track `deviceTestOpen` in `SettingsDialog`. Place a compact secondary button below `VirtualMicrophoneSection` and above channel cards. Pass `devicesBusy`, `devicesError`, and the current live session state from the existing snapshot/runtime props available to `SettingsDialog`; if the dialog currently lacks runtime state, add a narrow boolean prop at the call site rather than reading global state inside the wizard.

- [ ] **Step 5: Add focused styles and responsive behavior**

Add namespaced `.audio-test-*` rules near the existing settings/modal styles. Preserve the current light/dark theme overrides, keep buttons and selects within the modal width, and make the three test choices stack at the existing mobile breakpoint. Use existing border/radius/color variables and do not introduce a new palette.

- [ ] **Step 6: Run build and all frontend tests**

Run: `cd desktop; npm run build`

Run: `cd desktop; npm run test:audio; npm run test:languages; npm run test:runtime; npm run test:subtitle; node --experimental-strip-types --test tests/audio-device-test.test.mjs`

- [ ] **Step 7: Commit the React wizard**

```powershell
git add desktop/src/AudioDeviceTestWizard.tsx desktop/src/SettingsDialog.tsx desktop/src/styles.css desktop/src/audioDeviceTest.ts desktop/tests/audio-device-test.test.mjs
git commit -m "feat: add audio device test wizard"
```

### Task 5: Full Verification and Documentation

**Files:**
- Modify: `README.md` only if the development/testing section needs a short note about the wizard.
- Modify: `docs/superpowers/plans/2026-10-08-audio-device-test-wizard.md` to check completed steps during execution.

- [ ] **Step 1: Run Python regression suites**

Run:

```powershell
.venv\Scripts\python.exe -m unittest scripts.test_audio_device_tests scripts.test_tauri_bridge scripts.test_audio_isolation scripts.test_runtime_channels scripts.test_runtime_integration -v
```

- [ ] **Step 2: Run Rust and frontend verification**

Run:

```powershell
cd desktop\src-tauri
cargo test
cd ..
npm run build
npm run test:audio
npm run test:languages
npm run test:runtime
npm run test:subtitle
node --experimental-strip-types --test tests/audio-device-test.test.mjs
```

- [ ] **Step 3: Run static diff checks**

Run: `git diff --check HEAD~5..HEAD` and `git status --short --branch`. Confirm only feature commits and the pre-existing untracked `docs/qa/` directory are present.

- [ ] **Step 4: Perform Windows manual checks when audio hardware is available**

Open the audio settings, refresh devices, run each of the three tests, verify the selected device name and result status, mute the microphone to check `undetected`, unplug/reconnect a device to check the error path, and confirm the wizard blocks while a live translation session is running.

- [ ] **Step 5: Update the plan checkboxes and report evidence**

Record exact commands and pass/fail counts in the final response. Do not claim hardware verification unless it was actually run on Windows with devices.
