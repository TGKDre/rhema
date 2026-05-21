//! Async ProPresenter 7 WebSocket client.
//!
//! One `ProPresenterClient` per Grace session. The connection is kept alive
//! for the lifetime of the app (or until `disconnect` is called). All sends
//! go through a `tokio::sync::mpsc` channel so the caller never needs `&mut`.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::types::{
    ActionMessage, AuthMessage, PresentationRequestMessage, RawLibraryResponse,
    RawPresentationResponse, RawSlideIndexResponse, TriggerIndexMessage,
};
use crate::types::{LibraryEntry, PresentationInfo, ProSlide};

/// Commands sent to the internal WebSocket actor.
enum WsCommand {
    Send {
        payload: String,
        reply: Option<oneshot::Sender<Result<Value>>>,
    },
    Disconnect,
}

/// A connected, authenticated ProPresenter 7 client.
///
/// Internally this spawns two tokio tasks:
/// - **writer task** — receives `WsCommand` from a channel and writes to the socket.
/// - **reader task** — reads responses, matches them to pending replies.
///
/// Neither task is exposed publicly; all interaction goes through the
/// `send_*` helper methods.
pub struct ProPresenterClient {
    cmd_tx: mpsc::Sender<WsCommand>,
    pub ip: String,
    pub port: u16,
}

impl std::fmt::Debug for ProPresenterClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ProPresenterClient({}:{})", self.ip, self.port)
    }
}

impl ProPresenterClient {
    /// Connect to ProPresenter 7 and authenticate.
    ///
    /// `password` should be an empty string if no password is configured
    /// (the default for most installations).
    pub async fn connect(ip: &str, port: u16, password: &str) -> Result<Self> {
        let url = format!("ws://{ip}:{port}/remote");
        log::info!("[PP7] Connecting to {url}");

        let (ws_stream, _) = connect_async(&url)
            .await
            .with_context(|| format!("Failed to connect to ProPresenter at {url}"))?;

        log::info!("[PP7] WebSocket connected");

        let (mut write, mut read) = ws_stream.split();

        // ── Authenticate synchronously before returning ────────────────
        let auth = AuthMessage {
            action: "authenticate",
            protocol: 701,
            password,
        };
        let auth_json = serde_json::to_string(&auth)?;
        write
            .send(Message::Text(auth_json.into()))
            .await
            .context("Failed to send authenticate")?;

        // Wait for the auth response (with timeout)
        let auth_resp = tokio::time::timeout(Duration::from_secs(5), read.next())
            .await
            .context("Timed out waiting for ProPresenter authenticate response")?
            .ok_or_else(|| anyhow!("WebSocket closed before authenticate response"))??
        ;

        if let Message::Text(text) = auth_resp {
            let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let authenticated = v.get("authenticated").and_then(Value::as_u64).unwrap_or(0);
            if authenticated != 1 {
                return Err(anyhow!("ProPresenter authentication failed: {text}"));
            }
            log::info!("[PP7] Authenticated successfully");
        } else {
            return Err(anyhow!("Unexpected non-text message during auth"));
        }

        // ── Spawn internal actor tasks ─────────────────────────────────
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<WsCommand>(32);

        // Pending reply slots: keyed by the "action" field of the request.
        // ProPresenter echoes the action name back in the response, so we
        // match on that. Only one outstanding request per action at a time.
        let pending: std::sync::Arc<
            tokio::sync::Mutex<
                std::collections::HashMap<String, oneshot::Sender<Result<Value>>>,
            >,
        > = Default::default();
        let pending_writer = pending.clone();
        let pending_reader = pending.clone();

        // Writer task — serialises WsCommands onto the socket.
        tokio::spawn(async move {
            while let Some(cmd) = cmd_rx.recv().await {
                match cmd {
                    WsCommand::Send { payload, reply } => {
                        // Extract action name so we can register the reply slot.
                        let action_name: Option<String> = serde_json::from_str::<Value>(&payload)
                            .ok()
                            .and_then(|v| v.get("action")?.as_str().map(String::from));

                        if let (Some(name), Some(reply_tx)) = (action_name, reply) {
                            pending_writer.lock().await.insert(name, reply_tx);
                        }

                        if let Err(e) = write.send(Message::Text(payload.into())).await {
                            log::error!("[PP7] Write error: {e}");
                            break;
                        }
                    }
                    WsCommand::Disconnect => {
                        let _ = write.close().await;
                        break;
                    }
                }
            }
            log::info!("[PP7] Writer task exited");
        });

        // Reader task — routes incoming messages to pending reply slots.
        tokio::spawn(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        let v: Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                log::warn!("[PP7] Non-JSON message: {e} — {text}");
                                continue;
                            }
                        };

                        // Match to pending reply by action name.
                        if let Some(action) = v.get("action").and_then(Value::as_str) {
                            let mut p = pending_reader.lock().await;
                            if let Some(tx) = p.remove(action) {
                                let _ = tx.send(Ok(v.clone()));
                            }
                        }

                        // Log unsolicited slide-change notifications.
                        if let Some(action) = v.get("action").and_then(Value::as_str) {
                            if action == "presentationTriggerIndex" {
                                let idx = v
                                    .get("slideIndex")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(0);
                                log::info!("[PP7] Slide changed externally → index {idx}");
                            }
                        }
                    }
                    Ok(Message::Close(_)) => {
                        log::warn!("[PP7] Connection closed by ProPresenter");
                        break;
                    }
                    Err(e) => {
                        log::error!("[PP7] Read error: {e}");
                        break;
                    }
                    _ => {}
                }
            }
            log::info!("[PP7] Reader task exited");
        });

        Ok(Self {
            cmd_tx,
            ip: ip.to_string(),
            port,
        })
    }

    /// Send a fire-and-forget action (no response needed).
    async fn fire(&self, payload: String) -> Result<()> {
        self.cmd_tx
            .send(WsCommand::Send { payload, reply: None })
            .await
            .map_err(|_| anyhow!("[PP7] Command channel closed"))
    }

    /// Send an action and wait for the matching response.
    async fn request(&self, payload: String) -> Result<Value> {
        let (tx, rx) = oneshot::channel();
        self.cmd_tx
            .send(WsCommand::Send {
                payload,
                reply: Some(tx),
            })
            .await
            .map_err(|_| anyhow!("[PP7] Command channel closed"))?;

        tokio::time::timeout(Duration::from_secs(10), rx)
            .await
            .context("Timed out waiting for ProPresenter response")?
            .map_err(|_| anyhow!("Reply sender dropped"))?
    }

    // ── Public API ─────────────────────────────────────────────────────────

    /// Fetch the list of presentations from ProPresenter's library.
    pub async fn get_library(&self) -> Result<Vec<LibraryEntry>> {
        let msg = serde_json::to_string(&ActionMessage {
            action: "libraryRequest".into(),
        })?;
        let resp = self.request(msg).await?;
        let raw: RawLibraryResponse = serde_json::from_value(resp)
            .context("Failed to parse libraryRequest response")?;

        let entries = raw
            .library
            .unwrap_or_default()
            .into_iter()
            .map(|path| {
                let title = std::path::Path::new(&path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&path)
                    .to_string();
                LibraryEntry {
                    presentation_path: path,
                    title,
                }
            })
            .collect();

        Ok(entries)
    }

    /// Fetch all slides for a presentation path.
    pub async fn get_presentation(&self, presentation_path: &str) -> Result<PresentationInfo> {
        let msg = serde_json::to_string(&PresentationRequestMessage {
            action: "presentationRequest".into(),
            presentation_path: presentation_path.to_string(),
        })?;

        let resp = self.request(msg).await?;
        let raw: RawPresentationResponse = serde_json::from_value(resp)
            .context("Failed to parse presentationRequest response")?;

        let pres = raw
            .presentation
            .ok_or_else(|| anyhow!("No presentation in response"))?;

        let title = pres
            .presentation_name
            .unwrap_or_else(|| "Unknown".into());

        let mut slides: Vec<ProSlide> = Vec::new();
        let mut global_index: usize = 0;

        for group in pres.presentation_slide_groups.unwrap_or_default() {
            let group_name = group.group_name.unwrap_or_else(|| "Slide".into());
            for (group_slide_index, raw_slide) in
                group.group_slides.unwrap_or_default().into_iter().enumerate()
            {
                let slide_text = raw_slide.slide_text.unwrap_or_default();
                // Skip blank slides (separators, black slides, etc.)
                if slide_text.trim().is_empty() {
                    global_index += 1;
                    continue;
                }
                slides.push(ProSlide {
                    slide_index: global_index,
                    group_name: group_name.clone(),
                    group_slide_index,
                    slide_text,
                });
                global_index += 1;
            }
        }

        Ok(PresentationInfo {
            presentation_path: presentation_path.to_string(),
            title,
            slides,
        })
    }

    /// Advance to the next slide (fire-and-forget).
    pub async fn trigger_next(&self) -> Result<()> {
        let msg = serde_json::to_string(&ActionMessage {
            action: "presentationTriggerNext".into(),
        })?;
        self.fire(msg).await
    }

    /// Jump to a specific slide by index.
    pub async fn trigger_index(&self, presentation_path: &str, slide_index: usize) -> Result<()> {
        let msg = serde_json::to_string(&TriggerIndexMessage {
            action: "presentationTriggerIndex".into(),
            presentation_path: presentation_path.to_string(),
            slide_index,
            presentation_destination: 0,
        })?;
        self.fire(msg).await
    }

    /// Gracefully close the WebSocket.
    pub async fn disconnect(&self) -> Result<()> {
        self.cmd_tx
            .send(WsCommand::Disconnect)
            .await
            .map_err(|_| anyhow!("[PP7] Command channel already closed"))
    }
}
