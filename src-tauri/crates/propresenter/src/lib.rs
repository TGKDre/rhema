//! rhema-propresenter — ProPresenter 7 WebSocket client
//!
//! Exposes a single [`ProPresenterClient`] that connects to
//! `ws://[ip]:[port]/remote`, authenticates, and provides library
//! browsing, slide loading, and slide triggering.

pub mod client;
pub mod types;

pub use client::ProPresenterClient;
pub use types::{LibraryEntry, PresentationInfo, ProSlide};
