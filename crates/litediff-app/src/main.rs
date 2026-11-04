//! Process entry point: build the Tauri app, register state and commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use litediff_app::{commands, AppState};

fn main() {
    tauri::Builder::default()
        // Native file picker for "导入文件". The dialog plugin only chooses a
        // path; reading the file still goes through `load_file`, so the UI never
        // gains arbitrary filesystem access.
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::load_file,
            commands::set_side,
            commands::set_both,
            commands::rediff,
            commands::clear,
            commands::sync_session,
            // history
            commands::history_save,
            commands::history_list,
            commands::history_load,
            commands::history_delete,
            commands::history_clear,
            commands::history_prune,
            commands::save_file,
            commands::inspect_path,
            // git
            commands::git_status,
            commands::git_files,
            commands::git_log,
            commands::git_compare,
            commands::git_branches,
            commands::git_diff_files,
            commands::git_switch_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LiteDiff");
}
