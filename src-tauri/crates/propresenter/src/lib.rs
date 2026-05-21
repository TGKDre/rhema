//! `rhema-propresenter` — async ProPresenter 7 WebSocket client.
//!
//! ProPresenter 7 exposes a WebSocket endpoint at `ws://[ip]:[port]/remote`.
//! This crate wraps that protocol into a typed async client Grace can call
//! from Tauri commands and from the STT pipeline.

pub mod client;
pub mod types;

pub use client::ProPresenterClient;
pub use types::{LibraryEntry, ProSlide, PresentationInfo};
