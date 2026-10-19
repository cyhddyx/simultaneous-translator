import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIRTUAL_MICROPHONE_NAME,
  connectVirtualMicrophone,
  findVirtualMicrophone,
} from "../src/audioRouting.ts";

const device = (id, name, isDefault = false) => ({ id, name, channels: 2, isDefault });
// PulseAudio objects created by `install_virtual_microphone`
// (docs/linux-audio-routing.md §4): `id` is the PA object name and `name` is
// the device.description reported by the engine.
const virtualSink = device("translator_mic", "Translator Virtual Microphone Sink");
const virtualSource = device("translator_mic_source", "Translator Virtual Microphone");
const hardware = { speakers: [device("headset", "Headset", true)], microphones: [device("mic", "Microphone", true)] };
const devices = { speakers: [...hardware.speakers, virtualSink], microphones: [...hardware.microphones, virtualSource] };
const channel = { enabled: false, input: "microphone", inputDevice: "", targetLanguage: "English", outputDevice: "", playAudio: false };
const audio = () => ({ listen: { ...channel, enabled: true, input: "loopback" }, speak: { ...channel } });

test("requires the complete PulseAudio virtual microphone pair", () => {
  assert.equal(findVirtualMicrophone(null), null);
  assert.equal(findVirtualMicrophone(hardware), null);
  assert.equal(findVirtualMicrophone({ ...devices, microphones: [] }), null);
  assert.equal(findVirtualMicrophone({ speakers: [device("speakers", "Speakers")], microphones: [virtualSource] }), null);
  assert.equal(findVirtualMicrophone(devices).playback.id, "translator_mic");
  assert.equal(findVirtualMicrophone(devices).recording.id, "translator_mic_source");
  assert.equal(VIRTUAL_MICROPHONE_NAME, "Translator Virtual Microphone");
});

test("matches the PulseAudio object names or their device descriptions", () => {
  // A renamed engine id still matches through device.description.
  const renamed = {
    speakers: [device("alsa_output.demo", "Translator Virtual Microphone Sink")],
    microphones: [device("alsa_input.demo", "Translator Virtual Microphone")],
  };
  assert.equal(findVirtualMicrophone(renamed).playback.id, "alsa_output.demo");
  assert.equal(findVirtualMicrophone(renamed).recording.id, "alsa_input.demo");

  // The sink alone is not enough: both halves are required.
  assert.equal(findVirtualMicrophone({ speakers: renamed.speakers, microphones: hardware.microphones }), null);
});

test("connects only outgoing speech, retains language and does not mutate settings", () => {
  const original = audio();
  const result = connectVirtualMicrophone(original, devices);
  assert.deepEqual(result.speak, { ...channel, enabled: true, playAudio: true, inputDevice: "mic", outputDevice: "translator_mic" });
  assert.deepEqual(result.listen, original.listen);
  assert.equal(original.speak.enabled, false);
});

test("retains an explicitly selected microphone", () => {
  const original = audio();
  original.speak.inputDevice = "usb";
  const result = connectVirtualMicrophone(original, { ...devices, microphones: [...devices.microphones, device("usb", "USB microphone")] });
  assert.equal(result.speak.inputDevice, "usb");
});

test("replaces the virtual microphone source and prevents default loopback / listening playback feedback", () => {
  const original = audio();
  original.speak.inputDevice = "translator_mic_source";
  original.listen.playAudio = true;
  const result = connectVirtualMicrophone(original, {
    speakers: [{ ...hardware.speakers[0], isDefault: false }, { ...virtualSink, isDefault: true }],
    microphones: [{ ...virtualSource, isDefault: true }, hardware.microphones[0]],
  });
  assert.equal(result.speak.inputDevice, "mic");
  assert.equal(result.listen.input, "system");
  assert.equal(result.listen.inputDevice, "");
  assert.equal(result.listen.outputDevice, "headset");
});

test("rejects missing hardware and recording-channel feedback", () => {
  assert.throws(() => connectVirtualMicrophone(audio(), hardware));
  assert.throws(() => connectVirtualMicrophone(audio(), { ...devices, microphones: [virtualSource] }));
  const original = audio();
  original.listen.inputDevice = "translator_mic";
  assert.equal(connectVirtualMicrophone(original, { ...devices, speakers: [virtualSink] }).listen.input, "system");
  original.listen.input = "microphone";
  original.listen.inputDevice = "translator_mic_source";
  assert.throws(() => connectVirtualMicrophone(original, devices));
});
