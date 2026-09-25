fn main() {
    // Surface the host target triple (e.g. `aarch64-apple-darwin`) so we
    // can reconstruct the bundled k6 sidecar's on-disk filename at runtime.
    println!(
        "cargo:rustc-env=PERFPILOT_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("TARGET is set by Cargo")
    );
    tauri_build::build()
}