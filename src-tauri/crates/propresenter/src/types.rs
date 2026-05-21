use serde::{Deserialize, Serialize};

// ── Outbound action messages ───────────────────────────────────────────────

#[derive(Serialize, Debug)]
pub struct AuthMessage<'a> {
    pub action: &'static str,
    pub protocol: u32,
    pub password: &'a str,
}

#[derive(Serialize, Debug)]
pub struct ActionMessage {
    pub action: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PresentationRequestMessage {
    pub action: String,
    pub presentation_path: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TriggerIndexMessage {
    pub action: String,
    pub presentation_path: String,
    pub slide_index: usize,
    pub presentation_destination: u32,
}

// ── Inbound response shapes ────────────────────────────────────────────────

/// A single slide entry as returned by Grace's internal API surface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProSlide {
    /// 0-based index within the full presentation.
    pub slide_index: usize,
    /// The stanza/group label from ProPresenter (e.g. "Verse 1", "Chorus").
    pub group_name: String,
    /// 0-based index within the group.
    pub group_slide_index: usize,
    /// The raw lyric text of the slide.
    pub slide_text: String,
}

/// Minimal metadata returned by `pp_get_library`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub presentation_path: String,
    /// Basename without extension — the display title.
    pub title: String,
}

/// All slides for a presentation, returned by `pp_load_song`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationInfo {
    pub presentation_path: String,
    pub title: String,
    pub slides: Vec<ProSlide>,
}

// ── Raw ProPresenter 7 protocol shapes (for deserialization only) ──────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawLibraryResponse {
    pub library: Option<Vec<String>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawPresentationResponse {
    pub presentation: Option<RawPresentation>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawPresentation {
    pub presentation_name: Option<String>,
    pub presentation_slide_groups: Option<Vec<RawSlideGroup>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawSlideGroup {
    pub group_name: Option<String>,
    pub group_slides: Option<Vec<RawSlide>>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawSlide {
    pub slide_text: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RawSlideIndexResponse {
    pub presentation_path: Option<String>,
    pub slide_index: Option<usize>,
}
