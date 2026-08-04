// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![allow(linker_messages)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fjord_lib::run()
}
