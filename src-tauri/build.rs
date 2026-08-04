fn main() {
    // tauri_build::build() only re-runs on its own trigger set (tauri.conf.json,
    // src, etc.) — it does not watch the icon files it embeds as the exe's
    // Windows resource, so regenerating icons/icon.ico alone (e.g. via
    // `npm run tauri icon`) silently leaves the *compiled* exe's embedded
    // icon stale even though Tauri's own runtime window-icon code (which
    // loads straight from the PNGs) picks up the change immediately — that
    // mismatch is exactly what made the title bar update but the taskbar/
    // Explorer icon not. Declaring these explicitly forces a rebuild.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.png");

    tauri_build::build()
}
