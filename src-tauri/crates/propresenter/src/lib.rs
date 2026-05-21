//! rhema-propresenter — ProPresenter 7 WebSocket client
//!
//! Connects to ws://[ip]:[port]/remote, authenticates, and exposes
//! library browsing, slide loading, and slide triggering.
//!
//! ProPresenter 7 uses a JSON-over-WebSocket protocol (not REST).
//! All messages are JSON objects with an "action" field.

use std::sync::Arc;

use futures_util::{
    SinkExt,
    stream::{SplitSink, SplitStream, StreamExt},
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::Message,
};

// ── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum ProError {
    #[error("WebSocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Not connected")]
    NotConnected,
    #[error("Authentication failed: {0}")]
    AuthFailed(String),
    #[error("Timeout waiting for response")]
    Timeout,
    #[error("URL parse error: {0}")]
    Url(#[from] url::ParseError),
}

pub type ProResult<T> = Result<T, ProError>;

// ── Wire types (ProPresenter 7 JSON protocol) ─────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthRequest<'a> {
    action: &'static str,
    protocol: u32,
    password: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthResponse {
    authenticated: Option<u8>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionMessage<'a> {
    action: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    presentation_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    slide_index: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryResponse {
    library: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PresentationResponse {
    presentation: Option<RawPresentation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPresentation {
    presentation_slide_groups: Option<Vec<SlideGroup>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlideGroup {
    group_name: Option<String>,
    group_slides: Option<Vec<RawSlide>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSlide {
    slide_text: Option<String>,
}

// ── Public types ──────────────────────────────────────────────────────────────

/// A single entry from the ProPresenter song library.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryEntry {
    /// Full path as ProPresenter knows it (used for presentationRequest).
    pub path: String,
    /// Human-readable display name derived from the path.
    pub display_name: String,
}

/// A single slide/stanza extracted from a presentation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProSlide {
    /// Flat index across all slide groups (0-based, used for trigger_index).
    pub slide_index: i32,
    /// The group/section name (e.g. "Verse 1", "Chorus", "Bridge").
    pub group_name: String,
    /// The lyric text on this slide, whitespace-normalised.
    pub slide_text: String,
}

// ── Internal split-socket halves ──────────────────────────────────────────────

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type WsStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

// ── Client ────────────────────────────────────────────────────────────────────

/// Thread-safe ProPresenter 7 WebSocket client.
///
/// Stored in Tauri's managed state as `Mutex<ProPresenterClient>`.
/// The `Mutex` here is `tokio::sync::Mutex` so async commands can `.await`
/// inside the lock without blocking the executor.
pub struct ProPresenterClient {
    sink: Mutex<Option<WsSink>>,
    /// Inbound messages shared between the receive loop and request/response calls.
    inbox: Arc<Mutex<Vec<String>>>,
    /// Current connection target (for reconnect / debug logging).
    pub address: String,
}

impl ProPresenterClient {
    /// Create a disconnected client placeholder — call `connect()` later.
    #[must_use]
    pub fn disconnected() -> Self {
        Self {
            sink: Mutex::new(None),
            inbox: Arc::new(Mutex::new(Vec::new())),
            address: String::new(),
        }
    }

    /// Connect to `ws://[ip]:[port]/remote` and authenticate.
    ///
    /// `password` may be an empty string if ProPresenter has no password set.
    pub async fn connect(&mut self, ip: &str, port: u16, password: &str) -> ProResult<()> {
        let url = format!("ws://{ip}:{port}/remote");
        self.address = url.clone();

        log::info!("[PP] Connecting to {url}");
        let (ws, _) = connect_async(&url).await?;
        let (sink, mut stream) = ws.split();

        *self.sink.lock().await = Some(sink);

        // Send authentication
        let auth = AuthRequest {
            action: "authenticate",
            protocol: 701,
            password,
        };
        self.send_json(&auth).await?;

        // Wait for auth response (first message on the stream)
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stream.next(),
        )
        .await
        .map_err(|_| ProError::Timeout)?
        .ok_or(ProError::NotConnected)??
        .into_text()
        .map_err(ProError::WebSocket)?;

        let auth_resp: AuthResponse = serde_json::from_str(&response)?;
        if auth_resp.authenticated != Some(1) {
            return Err(ProError::AuthFailed(
                auth_resp.error.unwrap_or_else(|| "unknown".into()),
            ));
        }

        log::info!("[PP] Authenticated successfully");

        // Spawn background receive loop — fills inbox for request/response pairs.
        let inbox = self.inbox.clone();
        tokio::spawn(async move {
            Self::receive_loop(stream, inbox).await;
        });

        Ok(())
    }

    /// Disconnect gracefully.
    pub async fn disconnect(&mut self) {
        let mut lock = self.sink.lock().await;
        if let Some(mut s) = lock.take() {
            let _ = s.close().await;
        }
        log::info!("[PP] Disconnected from {}", self.address);
    }

    /// Returns `true` if the WebSocket sink is present (i.e. connected).
    pub async fn is_connected(&self) -> bool {
        self.sink.lock().await.is_some()
    }

    /// Fetch the full song library from ProPresenter.
    pub async fn get_library(&self) -> ProResult<Vec<LibraryEntry>> {
        self.send_json(&ActionMessage {
            action: "libraryRequest",
            presentation_path: None,
            slide_index: None,
        })
        .await?;

        let raw = self.wait_for_action("libraryRequest", 5).await?;
        let resp: LibraryResponse = serde_json::from_str(&raw)?;
        let paths = resp.library.unwrap_or_default();

        let entries = paths
            .into_iter()
            .map(|path| {
                let display_name = path
                    .split(['/', '\\'])
                    .last()
                    .unwrap_or(&path)
                    .trim_end_matches(".pro")
                    .to_string();
                LibraryEntry { path, display_name }
            })
            .collect();

        Ok(entries)
    }

    /// Fetch all slides for a presentation, flattened across all slide groups.
    pub async fn get_presentation(&self, presentation_path: &str) -> ProResult<Vec<ProSlide>> {
        self.send_json(&ActionMessage {
            action: "presentationRequest",
            presentation_path: Some(presentation_path),
            slide_index: None,
        })
        .await?;

        let raw = self.wait_for_action("presentationRequest", 8).await?;
        let resp: PresentationResponse = serde_json::from_str(&raw)?;

        let groups = resp
            .presentation
            .and_then(|p| p.presentation_slide_groups)
            .unwrap_or_default();

        let mut slides = Vec::new();
        let mut flat_index: i32 = 0;

        for group in groups {
            let group_name = group.group_name.unwrap_or_else(|| "Slide".into());
            for raw_slide in group.group_slides.unwrap_or_default() {
                let text = raw_slide
                    .slide_text
                    .unwrap_or_default()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");

                if !text.is_empty() {
                    slides.push(ProSlide {
                        slide_index: flat_index,
                        group_name: group_name.clone(),
                        slide_text: text,
                    });
                }
                flat_index += 1;
            }
        }

        Ok(slides)
    }

    /// Trigger the NEXT slide (ProPresenter advances its current presentation).
    pub async fn trigger_next(&self) -> ProResult<()> {
        self.send_json(&ActionMessage {
            action: "presentationTriggerNext",
            presentation_path: None,
            slide_index: None,
        })
        .await
    }

    /// Jump directly to a specific slide index within a presentation.
    pub async fn trigger_index(
        &self,
        presentation_path: &str,
        slide_index: i32,
    ) -> ProResult<()> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct TriggerMsg<'a> {
            action: &'static str,
            presentation_path: &'a str,
            slide_index: i32,
        }
        self.send_json(&TriggerMsg {
            action: "presentationTriggerIndex",
            presentation_path,
            slide_index,
        })
        .await
    }

    // ── Internals ────────────────────────────────────────────────────────────

    async fn send_json<T: Serialize>(&self, msg: &T) -> ProResult<()> {
        let json = serde_json::to_string(msg)?;
        let mut lock = self.sink.lock().await;
        let sink = lock.as_mut().ok_or(ProError::NotConnected)?;
        sink.send(Message::Text(json.into())).await?;
        Ok(())
    }

    /// Poll inbox for a message whose text contains `action`, up to `timeout_secs`.
    async fn wait_for_action(&self, action: &str, timeout_secs: u64) -> ProResult<String> {
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

        loop {
            {
                let mut inbox = self.inbox.lock().await;
                if let Some(pos) = inbox.iter().position(|m| m.contains(action)) {
                    return Ok(inbox.remove(pos));
                }
            }

            if std::time::Instant::now() >= deadline {
                return Err(ProError::Timeout);
            }

            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    async fn receive_loop(mut stream: WsStream, inbox: Arc<Mutex<Vec<String>>>) {
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    log::debug!("[PP] <-- {}", &text[..text.len().min(120)]);
                    let mut lock = inbox.lock().await;
                    // Cap at 64 to avoid unbounded growth
                    if lock.len() < 64 {
                        lock.push(text.to_string());
                    }
                }
                Ok(Message::Close(_)) => {
                    log::info!("[PP] WebSocket closed by server");
                    break;
                }
                Err(e) => {
                    log::warn!("[PP] Receive error: {e}");
                    break;
                }
                _ => {}
            }
        }
        log::info!("[PP] Receive loop exited");
    }
}
