#![allow(linker_messages)]

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    fjord_app::builder()
        .run(tauri::generate_context!())
        .expect("error while running the Fjord application");
}
