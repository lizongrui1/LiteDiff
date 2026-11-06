//! Process entry point: build the Tauri app, register state and commands.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use litediff_app::{commands, AppState};
use tauri::{DragDropEvent, Manager, WindowEvent};

fn main() {
    tauri::Builder::default()
        // Native file picker for "导入文件". The dialog plugin only chooses a
        // path; the backend records that user choice and `load_file` checks it.
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .on_window_event(|window, event| {
            // Grant only paths from a native drag gesture. HTML drag events carry
            // paths supplied by the renderer and cannot establish this trust.
            if let WindowEvent::DragDrop(
                DragDropEvent::Enter { paths, .. } | DragDropEvent::Drop { paths, .. },
            ) = event
            {
                let state = window.state::<AppState>();
                for path in paths {
                    let _ = state.approve_path(path);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::pick_file,
            commands::pick_folder,
            commands::load_file,
            commands::set_side,
            commands::set_both,
            commands::set_drafts,
            commands::rediff,
            commands::clear,
            commands::load_into,
            commands::save_current,
            commands::drop_session,
            // history
            commands::history_save_session,
            commands::history_list,
            commands::history_load,
            commands::history_restore,
            commands::history_delete,
            commands::history_clear,
            commands::history_prune,
            commands::inspect_path,
            commands::expand_directory,
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
