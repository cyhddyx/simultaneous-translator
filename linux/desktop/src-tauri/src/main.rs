// The Windows GUI-subsystem switch is irrelevant on Linux (no console window is
// allocated for a desktop app), but it is kept behind a Windows-only cfg so the
// crate attributes stay valid if this target is ever built for Windows.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    simultaneous_translator_lib::run();
}
