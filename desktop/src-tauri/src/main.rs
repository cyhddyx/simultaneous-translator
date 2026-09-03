// Without this the release binary stays a console application, so launching the
// installed app pops up an extra command prompt next to the window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    simultaneous_translator_lib::run();
}
