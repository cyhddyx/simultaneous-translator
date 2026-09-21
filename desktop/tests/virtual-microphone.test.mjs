import assert from "node:assert/strict";
import { test } from "node:test";
import { connectVirtualMicrophone, findVirtualMicrophone } from "../src/audioRouting.ts";

const device = (id, name, isDefault = false) => ({ id, name, channels: 2, isDefault });
const cableIn = device("cable-in", "CABLE Input (VB-Audio Virtual Cable)");
const cableOut = device("cable-out", "CABLE Output (VB-Audio Virtual Cable)");
const hardware = { speakers: [device("headset", "Headset", true)], microphones: [device("mic", "Microphone", true)] };
const devices = { speakers: [...hardware.speakers, cableIn], microphones: [...hardware.microphones, cableOut] };
const channel = { enabled: false, input: "microphone", inputDevice: "", targetLanguage: "English", outputDevice: "", playAudio: false };
const audio = () => ({ listen: { ...channel, enabled: true, input: "loopback" }, speak: { ...channel } });

test("requires the complete standard pair; does not match paid A+B devices", () => {
  assert.equal(findVirtualMicrophone(null), null);
  assert.equal(findVirtualMicrophone(hardware), null);
  assert.equal(findVirtualMicrophone({ ...devices, microphones: [] }), null);
  assert.equal(findVirtualMicrophone({ speakers: [device("a", "CABLE-A Input (VB-Audio Cable A)")], microphones: [device("b", "CABLE-A Output (VB-Audio Cable A)")] }), null);
  assert.equal(findVirtualMicrophone(devices).recording.id, "cable-out");
});
test("connects only outgoing speech, retains language and does not mutate settings", () => {
  const original = audio();
  const result = connectVirtualMicrophone(original, devices);
  assert.deepEqual(result.speak, { ...channel, enabled: true, playAudio: true, inputDevice: "mic", outputDevice: "cable-in" });
  assert.deepEqual(result.listen, original.listen);
  assert.equal(original.speak.enabled, false);
});
test("retains an explicitly selected microphone", () => {
  const original = audio();
  original.speak.inputDevice = "usb";
  const result = connectVirtualMicrophone(original, { ...devices, microphones: [...devices.microphones, device("usb", "USB microphone")] });
  assert.equal(result.speak.inputDevice, "usb");
});
test("replaces cable microphone and prevents default loopback / listening playback feedback", () => {
  const original = audio();
  original.speak.inputDevice = "cable-out";
  original.listen.playAudio = true;
  const result = connectVirtualMicrophone(original, { speakers: [{ ...hardware.speakers[0], isDefault: false }, { ...cableIn, isDefault: true }], microphones: [{ ...cableOut, isDefault: true }, hardware.microphones[0]] });
  assert.equal(result.speak.inputDevice, "mic");
  assert.equal(result.listen.input, "system");
  assert.equal(result.listen.inputDevice, "");
  assert.equal(result.listen.outputDevice, "headset");
});
test("rejects missing hardware and recording-channel feedback", () => {
  assert.throws(() => connectVirtualMicrophone(audio(), hardware));
  assert.throws(() => connectVirtualMicrophone(audio(), { ...devices, microphones: [cableOut] }));
  const original = audio();
  original.listen.inputDevice = "cable-in";
  assert.equal(connectVirtualMicrophone(original, { ...devices, speakers: [cableIn] }).listen.input, "system");
  original.listen.input = "microphone";
  original.listen.inputDevice = "cable-out";
  assert.throws(() => connectVirtualMicrophone(original, devices));
});
