use keyring::Entry;
use std::collections::HashMap;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, Runtime};

use tauri_plugin_dialog::{
    DialogExt, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

const KEYRING_SERVICE: &str = "NotepadAI";
const KEYRING_ACCOUNT: &str = "api_key";

#[derive(serde::Deserialize)]
struct AiRequest {
    endpoint: String,
    headers: HashMap<String, String>,
    body: serde_json::Value,
}

#[derive(serde::Serialize)]
struct AiResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[tauri::command]
fn set_api_key(key: String) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|err| err.to_string())?;
    entry.set_password(&key).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_api_key() -> Result<Option<String>, String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|err| err.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
fn delete_api_key() -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|err| err.to_string())?;
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
async fn ai_request(request: AiRequest) -> Result<AiResponse, String> {
    let mut header_map = reqwest::header::HeaderMap::new();
    for (name, value) in request.headers {
        let header_name =
            reqwest::header::HeaderName::from_bytes(name.as_bytes()).map_err(|err| err.to_string())?;
        let header_value =
            reqwest::header::HeaderValue::from_str(&value).map_err(|err| err.to_string())?;
        header_map.insert(header_name, header_value);
    }

    let response = reqwest::Client::new()
        .post(&request.endpoint)
        .headers(header_map)
        .json(&request.body)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    let status = response.status().as_u16();
    let mut headers = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(value_str) = value.to_str() {
            headers.insert(name.to_string(), value_str.to_string());
        }
    }
    let body = response.text().await.map_err(|err| err.to_string())?;

    Ok(AiResponse {
        status,
        headers,
        body,
    })
}

#[tauri::command]
fn confirm_unsaved_changes<R: Runtime>(
    window: tauri::Window<R>,
    filename: String,
) -> Result<String, String> {
    let title = "NotepadAI".to_string();
    let message = format!("Save changes to \"{}\"?", filename);

    let response = MessageDialogBuilder::new(window.dialog().clone(), title, message)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancel)
        .blocking_show_with_result();

    match response {
        MessageDialogResult::Yes => Ok("save".to_string()),
        MessageDialogResult::No => Ok("dont_save".to_string()),
        MessageDialogResult::Cancel => Ok("cancel".to_string()),
        _ => Ok("cancel".to_string()),
    }
}

fn build_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_item = MenuItem::with_id(app, "file_new", "New", true, Some("Ctrl+N"))?;
    let open_item = MenuItem::with_id(app, "file_open", "Open", true, Some("Ctrl+O"))?;
    let save_item = MenuItem::with_id(app, "file_save", "Save", true, Some("Ctrl+S"))?;
    let save_as_item =
        MenuItem::with_id(app, "file_save_as", "Save As", true, Some("Ctrl+Shift+S"))?;
    let exit_item = MenuItem::with_id(app, "file_exit", "Exit", true, Some("Alt+F4"))?;

    let undo_item = MenuItem::with_id(app, "edit_undo", "Undo", true, None::<&str>)?;
    let undo_ai_item =
        MenuItem::with_id(app, "edit_undo_ai", "Undo AI", true, Some("Ctrl+Alt+Z"))?;
    let cut_item = MenuItem::with_id(app, "edit_cut", "Cut", true, None::<&str>)?;
    let copy_item = MenuItem::with_id(app, "edit_copy", "Copy", true, None::<&str>)?;
    let paste_item = MenuItem::with_id(app, "edit_paste", "Paste", true, None::<&str>)?;
    let select_all_item =
        MenuItem::with_id(app, "edit_select_all", "Select All", true, Some("Ctrl+A"))?;

    let word_wrap_item =
        MenuItem::with_id(app, "format_word_wrap", "Word Wrap", true, None::<&str>)?;
    let status_bar_item =
        MenuItem::with_id(app, "view_status_bar", "Status Bar", true, None::<&str>)?;

    let about_item = MenuItem::with_id(app, "help_about", "About", true, None::<&str>)?;

    let ai_rewrite_item = MenuItem::with_id(app, "ai_rewrite", "Rewrite", true, Some("Ctrl+R"))?;
    let ai_improve_item = MenuItem::with_id(app, "ai_improve", "Improve", true, None::<&str>)?;
    let ai_shorten_item = MenuItem::with_id(app, "ai_shorten", "Shorten", true, None::<&str>)?;
    let ai_expand_item = MenuItem::with_id(app, "ai_expand", "Expand", true, None::<&str>)?;
    let ai_simplify_item = MenuItem::with_id(app, "ai_simplify", "Simplify", true, None::<&str>)?;
    let ai_fix_grammar_item =
        MenuItem::with_id(app, "ai_fix_grammar", "Fix Grammar", true, None::<&str>)?;
    let ai_settings_item = MenuItem::with_id(app, "ai_settings", "Settings", true, None::<&str>)?;

    let use_case_proposal_item =
        MenuItem::with_id(app, "use_case_proposal", "Write Proposal", true, None::<&str>)?;
    let use_case_task_plan_item =
        MenuItem::with_id(app, "use_case_task_plan", "Create Task Plan", true, None::<&str>)?;
    let use_case_email_item =
        MenuItem::with_id(app, "use_case_email", "Write Email", true, None::<&str>)?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_item,
            &open_item,
            &save_item,
            &save_as_item,
            &PredefinedMenuItem::separator(app)?,
            &exit_item,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo_item,
            &undo_ai_item,
            &PredefinedMenuItem::separator(app)?,
            &cut_item,
            &copy_item,
            &paste_item,
            &PredefinedMenuItem::separator(app)?,
            &select_all_item,
        ],
    )?;

    let format_menu = Submenu::with_items(app, "Format", true, &[&word_wrap_item])?;

    let view_menu = Submenu::with_items(app, "View", true, &[&status_bar_item])?;

    let help_menu = Submenu::with_items(app, "Help", true, &[&about_item])?;

    let ai_menu = Submenu::with_items(
        app,
        "AI",
        true,
        &[
            &ai_rewrite_item,
            &ai_improve_item,
            &ai_shorten_item,
            &ai_expand_item,
            &ai_simplify_item,
            &ai_fix_grammar_item,
            &PredefinedMenuItem::separator(app)?,
            &ai_settings_item,
        ],
    )?;

    let use_case_menu = Submenu::with_items(
        app,
        "Use Case",
        true,
        &[
            &use_case_proposal_item,
            &use_case_task_plan_item,
            &use_case_email_item,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &file_menu,
            &edit_menu,
            &format_menu,
            &view_menu,
            &help_menu,
            &ai_menu,
            &use_case_menu,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            println!("menu-event: {}", id);
            if let Err(err) = app.emit("menu-event", id.clone()) {
                println!("menu-event emit error: {}", err);
            }
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = window.emit("menu-event", id) {
                    println!("menu-event window emit error: {}", err);
                }
            } else {
                println!("menu-event: main window not found");
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_api_key,
            get_api_key,
            delete_api_key,
            ai_request,
            confirm_unsaved_changes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
