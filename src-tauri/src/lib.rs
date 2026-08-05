#![allow(linker_messages)]

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Setup failures already showed an error dialog (fjord-app, P4-02);
    // exit with a non-zero code instead of panicking on top of it.
    if let Err(error) = fjord_app::builder().run(tauri::generate_context!()) {
        eprintln!("error while running the Fjord application: {error}");
        std::process::exit(1);
    }
}
