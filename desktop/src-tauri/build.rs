//! Build script.
//!
//! `tauri_build::build()` compiles the Windows resource — icon, version info and
//! the Common-Controls v6 manifest — into `<OUT_DIR>/resource.lib` and links it
//! through `cargo:rustc-link-arg-bins`, i.e. into **binary** targets only.
//!
//! The library's unit-test harness is not a binary target, so it was left without
//! a manifest and then failed to load: without the v6 manifest the loader binds
//! `comctl32.dll` to the v5 shim in `System32`, which does not export
//! `TaskDialogIndirect`, and `muda` (pulled in by Tauri's `tray-icon` feature)
//! imports that symbol. Every `cargo test` run died with
//! `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)` before a single test could execute.
//!
//! The resource stays on the search path so `src/lib.rs` can attach it to the test
//! harness alone (`#[link(name = "resource", kind = "static")]` inside
//! `#[cfg(all(test, windows))]`); binary targets keep receiving it through the
//! `-bins` bucket and never see it twice, which the resource compiler rejects.

fn main() {
    tauri_build::build();

    #[cfg(windows)]
    {
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is always set for build scripts");
        if std::path::Path::new(&out_dir).join("resource.lib").exists() {
            println!("cargo:rustc-link-search=native={out_dir}");
        } else {
            println!(
                "cargo:warning=tauri-build did not produce resource.lib; the Windows unit-test \
                 harness may fail to load"
            );
        }
    }
}
