mod media;
mod volume;

use tauri::Manager;

// Commands are marked `(async)` so Tauri runs them on a worker thread instead
// of the main UI thread. This keeps the WinRT/COM blocking calls off the event
// loop and lets us initialize the COM apartment as multi-threaded.

#[tauri::command(async)]
fn get_now_playing() -> media::NowPlaying {
    media::now_playing().unwrap_or_default()
}

#[tauri::command(async)]
fn get_art() -> Option<String> {
    media::art().ok()
}

#[tauri::command(async)]
fn media_play_pause() -> Result<(), String> {
    media::play_pause().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn media_next() -> Result<(), String> {
    media::next().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn media_prev() -> Result<(), String> {
    media::prev().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn media_seek(position: f64) -> Result<(), String> {
    media::seek(position).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn get_volume() -> Result<volume::VolumeState, String> {
    volume::get_volume().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn set_volume(level: f32) -> Result<(), String> {
    volume::set_volume(level).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn toggle_mute() -> Result<(), String> {
    volume::toggle_mute().map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Apply native window effects on Windows: real acrylic blur + rounded corners.
#[cfg(target_os = "windows")]
fn apply_window_effects(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    // Acrílico: blur real del escritorio detrás de la ventana.
    let _ = window_vibrancy::apply_acrylic(window, Some((18, 18, 26, 125)));

    // Esquinas redondeadas (Win11) vía DWM, ya que la ventana es sin bordes.
    if let Ok(handle) = window.hwnd() {
        let pref = DWMWCP_ROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(
                HWND(handle.0),
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const core::ffi::c_void,
                std::mem::size_of_val(&pref) as u32,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_window_effects(_window: &tauri::WebviewWindow) {}

/// System tray icon with a menu to show/hide the widget and quit the app.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let toggle = MenuItem::with_id(app, "toggle", "Mostrar / Ocultar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("Barra")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                apply_window_effects(&window);
            }
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_now_playing,
            get_art,
            media_play_pause,
            media_next,
            media_prev,
            media_seek,
            get_volume,
            set_volume,
            toggle_mute,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
