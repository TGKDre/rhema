use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use rhema_bible::BibleDb;
use rhema_propresenter::ProPresenterClient;

pub struct AppState {
    pub bible_db: Option<BibleDb>,
    pub active_translation_id: i64,
    pub audio_active: Arc<AtomicBool>,
    pub stt_active: Arc<AtomicBool>,
    #[expect(dead_code, reason = "reserved for future Deepgram key injection")]
    pub deepgram_api_key: Option<String>,

    // ── ProPresenter 7 integration ────────────────────────────────────
    /// Live connection to the ProPresenter instance on the network.
    /// `None` when not connected.
    pub propresenter: Option<ProPresenterClient>,

    /// When `true`, `check_reading_mode` in `stt.rs` automatically calls
    /// `pp_trigger_next` on every lyric line match.
    /// When `false`, slide advances must be triggered manually.
    pub auto_advance_enabled: bool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            bible_db: None,
            active_translation_id: 1,
            audio_active: Arc::new(AtomicBool::new(false)),
            stt_active: Arc::new(AtomicBool::new(false)),
            deepgram_api_key: None,
            propresenter: None,
            auto_advance_enabled: false,
        }
    }
}
