#![expect(clippy::needless_pass_by_value, reason = "Tauri command extractors require pass-by-value")]

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use rhema_propresenter::{LibraryEntry, PresentationInfo};

use crate::state::AppState;

// ── Connection ─────────────────────────────────────────────────────

/// Connect to a ProPresenter 7 instance on the local network.
///
/// `password` is optional — pass `None` or an empty string if no password
/// is configured in ProPresenter's Network preferences (the default).
#[tauri::command]
pub async fn pp_connect(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    ip: String,
    port: u16,
    password: Option<String>,
) -> Result<(), String> {
    let pw = password.unwrap_or_default();

    let client = rhema_propresenter::ProPresenterClient::connect(&ip, port, &pw)
        .await
        .map_err(|e| format!("[PP7] Connect failed: {e}"))?;

    log::info!("[PP7] Connected to {ip}:{port}");

    {
        let mut app_state = state.lock().map_err(|e| e.to_string())?;
        app_state.propresenter = Some(client);
    }

    let _ = app.emit("pp_connected", serde_json::json!({ "ip": ip, "port": port }));
    Ok(())
}

/// Disconnect from ProPresenter.
#[tauri::command]
pub async fn pp_disconnect(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let client = {
        let mut app_state = state.lock().map_err(|e| e.to_string())?;
        app_state.propresenter.take()
    };

    if let Some(c) = client {
        c.disconnect()
            .await
            .map_err(|e| format!("[PP7] Disconnect error: {e}"))?;
        log::info!("[PP7] Disconnected");
        let _ = app.emit("pp_disconnected", ());
    }

    Ok(())
}

/// Returns whether a ProPresenter client is currently connected.
#[tauri::command]
pub fn pp_is_connected(
    state: State<'_, Mutex<AppState>>,
) -> Result<bool, String> {
    let app_state = state.lock().map_err(|e| e.to_string())?;
    Ok(app_state.propresenter.is_some())
}

// ── Library ───────────────────────────────────────────────────────

/// Fetch the full song/presentation library from ProPresenter.
#[tauri::command]
pub async fn pp_get_library(
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<LibraryEntry>, String> {
    let app_state = state.lock().map_err(|e| e.to_string())?;
    let client = app_state
        .propresenter
        .as_ref()
        .ok_or_else(|| "Not connected to ProPresenter".to_string())?;

    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(client.get_library())
    })
    .map_err(|e| format!("[PP7] get_library failed: {e}"))
}

// ── Song loading ─────────────────────────────────────────────────

/// Load a song from ProPresenter into ReadingMode.
///
/// This fetches the slides for `presentation_path`, parses lyric text from
/// each slide, loads them into `ReadingMode`, and triggers slide 0 on
/// ProPresenter so it immediately shows the first stanza.
#[tauri::command]
pub async fn pp_load_song(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    presentation_path: String,
) -> Result<PresentationInfo, String> {
    // ── 1. Fetch slides from ProPresenter ──────────────────────────────
    let info = {
        let app_state = state.lock().map_err(|e| e.to_string())?;
        let client = app_state
            .propresenter
            .as_ref()
            .ok_or_else(|| "Not connected to ProPresenter".to_string())?;

        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(client.get_presentation(&presentation_path))
        })
        .map_err(|e| format!("[PP7] get_presentation failed: {e}"))?
    };

    log::info!(
        "[PP7] Loaded '{}': {} slides",
        info.title,
        info.slides.len()
    );

    // ── 2. Load slides into ReadingMode ──────────────────────────────
    {
        use rhema_detection::ReadingMode;
        let rm_managed: &Mutex<ReadingMode> = app.state::<Mutex<ReadingMode>>().inner();
        if let Ok(mut rm) = rm_managed.lock() {
            let lines: Vec<(i32, String)> = info
                .slides
                .iter()
                .map(|s| {
                    #[expect(clippy::cast_possible_truncation, reason = "slide index < i32::MAX")]
                    (s.slide_index as i32, s.slide_text.clone())
                })
                .collect();

            let first_group = info
                .slides
                .first()
                .map(|s| s.group_name.clone())
                .unwrap_or_else(|| "Intro".into());

            rm.start(
                0,                    // book_number = 0 → lyric mode sentinel
                &info.title,          // book_name = song title
                1,                    // chapter = 1 (unused in lyric mode)
                0,                    // verse_start = first slide index
                lines,
            );

            log::info!(
                "[READING] Loaded '{}' / '{}' into ReadingMode",
                info.title,
                first_group
            );
        }
    }

    // ── 3. Trigger slide 0 on ProPresenter ───────────────────────────
    if !info.slides.is_empty() {
        let first_index = info.slides[0].slide_index;
        let app_state = state.lock().map_err(|e| e.to_string())?;
        if let Some(client) = &app_state.propresenter {
            let _ = tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current()
                    .block_on(client.trigger_index(&presentation_path, first_index))
            });
        }
    }

    // ── 4. Notify frontend ─────────────────────────────────────────────
    let _ = app.emit("pp_song_loaded", &info);

    Ok(info)
}

// ── Slide control ──────────────────────────────────────────────────────

/// Manually advance to the next slide in ProPresenter.
#[tauri::command]
pub async fn pp_trigger_next(
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let app_state = state.lock().map_err(|e| e.to_string())?;
    let client = app_state
        .propresenter
        .as_ref()
        .ok_or_else(|| "Not connected to ProPresenter".to_string())?;

    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(client.trigger_next())
    })
    .map_err(|e| format!("[PP7] trigger_next failed: {e}"))
}

/// Jump to a specific slide index.
#[tauri::command]
pub async fn pp_trigger_index(
    state: State<'_, Mutex<AppState>>,
    presentation_path: String,
    slide_index: usize,
) -> Result<(), String> {
    let app_state = state.lock().map_err(|e| e.to_string())?;
    let client = app_state
        .propresenter
        .as_ref()
        .ok_or_else(|| "Not connected to ProPresenter".to_string())?;

    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current()
            .block_on(client.trigger_index(&presentation_path, slide_index))
    })
    .map_err(|e| format!("[PP7] trigger_index failed: {e}"))
}

// ── Auto-advance toggle ──────────────────────────────────────────────

/// Enable or disable STT-driven automatic slide advance.
#[tauri::command]
pub fn pp_set_auto_advance(
    app: AppHandle,
    state: State<'_, Mutex<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    let mut app_state = state.lock().map_err(|e| e.to_string())?;
    app_state.auto_advance_enabled = enabled;
    log::info!("[PP7] Auto-advance: {}", if enabled { "ON" } else { "OFF" });
    let _ = app.emit("pp_auto_advance_changed", enabled);
    Ok(())
}

/// Return the current value of the auto-advance flag.
#[tauri::command]
pub fn pp_get_auto_advance(
    state: State<'_, Mutex<AppState>>,
) -> Result<bool, String> {
    let app_state = state.lock().map_err(|e| e.to_string())?;
    Ok(app_state.auto_advance_enabled)
}
