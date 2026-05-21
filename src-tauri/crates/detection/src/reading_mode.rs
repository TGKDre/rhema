use std::collections::HashSet;
use std::time::Instant;

use serde::Serialize;

use crate::direct::parser::parse_spoken_number;

/// Timeout: pause lyric-tracking mode after 3 minutes of no line matches.
const READING_MODE_TIMEOUT_MS: u128 = 180_000;

/// Returns the minimum word-overlap ratio required to match a lyric line,
/// scaled by how many words that line contains.
///
/// Short lyric lines (e.g. "Holy holy holy" — 3 words) need a tighter ratio
/// to avoid false positives from ambient speech. Long lines can afford a
/// looser threshold because partial matches are still meaningful.
fn adaptive_overlap_threshold(line_word_count: usize) -> f64 {
    match line_word_count {
        0..=3  => 0.85,
        4..=6  => 0.70,
        7..=10 => 0.55,
        11..=16 => 0.45,
        _      => 0.35,
    }
}

/// A single lyric line loaded for tracking.
#[derive(Debug, Clone)]
struct LoadedLine {
    /// 0-based position within the section.
    line_index: usize,
    text: String,
    /// Pre-computed lowercase word set for fast overlap matching.
    words: HashSet<String>,
    word_count: usize,
}

/// Emitted when lyric tracking advances to a new line.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReadingAdvance {
    pub song_id: String,
    pub section_label: String,
    pub line_index: usize,
    pub line_text: String,
    /// Human-readable reference, e.g. "Amazing Grace — Chorus, line 3"
    pub reference: String,
    pub confidence: f64,
}

/// Tracks the current lyric position and matches incoming STT transcripts
/// against expected line text to auto-advance through a song section.
///
/// Activated when the direct detector recognises a lyric reference.
/// Pre-loads all lines in the current section (verse, chorus, bridge, etc.).
/// On each transcript fragment, compares word overlap against the current
/// and next lines to decide whether the singer has moved on.
pub struct ReadingMode {
    active: bool,
    song_id: String,
    section_label: String,
    /// Index into `lines` for the line currently being sung.
    current_index: usize,
    /// All lines in the active section.
    lines: Vec<LoadedLine>,
    /// Last time a line match was found (used for timeout).
    last_match_time: Instant,
    /// Accumulated transcript text since last advance (multi-fragment matching).
    accumulated_text: String,
}

impl ReadingMode {
    /// Create an inactive lyric-tracking instance.
    pub fn new() -> Self {
        Self {
            active: false,
            song_id: String::new(),
            section_label: String::new(),
            current_index: 0,
            lines: Vec::new(),
            last_match_time: Instant::now(),
            accumulated_text: String::new(),
        }
    }

    /// Activate tracking for a song section.
    ///
    /// `lines` should be `(line_index, line_text)` pairs for every line in
    /// the section, ordered from first to last.  Pass all lines so that
    /// "previous line" / "go back" voice commands can navigate backward.
    pub fn start(
        &mut self,
        song_id: &str,
        section_label: &str,
        start_line: usize,
        lines: Vec<(usize, String)>,
    ) {
        let loaded: Vec<LoadedLine> = lines
            .into_iter()
            .map(|(idx, text)| {
                let words = text_to_word_set(&text);
                let word_count = words.len();
                LoadedLine { line_index: idx, text, words, word_count }
            })
            .collect();

        if loaded.is_empty() {
            log::warn!(
                "[LYRIC] No lines loaded for {song_id} — {section_label}"
            );
            return;
        }

        let start_index = loaded
            .iter()
            .position(|l| l.line_index == start_line)
            .unwrap_or(0);

        log::info!(
            "[LYRIC] Started: {song_id} — {section_label}, line {start_line} ({} lines loaded)",
            loaded.len()
        );

        self.active = true;
        self.song_id = song_id.to_string();
        self.section_label = section_label.to_string();
        self.current_index = start_index;
        self.lines = loaded;
        self.last_match_time = Instant::now();
        self.accumulated_text.clear();
    }

    /// Whether lyric tracking is currently active.
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Whether lines are still loaded (paused but resumable).
    pub fn has_lines(&self) -> bool {
        !self.lines.is_empty()
    }

    /// Resume from the current position after a pause or toggle.
    pub fn resume(&mut self) {
        if !self.lines.is_empty() {
            self.active = true;
            self.last_match_time = Instant::now();
            let idx = self
                .lines
                .get(self.current_index)
                .map_or(0, |l| l.line_index);
            log::info!(
                "[LYRIC] Resumed at: {} — {}, line {idx}",
                self.song_id,
                self.section_label
            );
        }
    }

    /// The song ID currently being tracked.
    pub fn current_song_id(&self) -> &str {
        &self.song_id
    }

    /// The section label currently being tracked (e.g. "Chorus", "Verse 1").
    pub fn current_section_label(&self) -> &str {
        &self.section_label
    }

    /// The 0-based index of the line currently being tracked, if active.
    pub fn current_line_index(&self) -> Option<usize> {
        if self.active {
            self.lines.get(self.current_index).map(|l| l.line_index)
        } else {
            None
        }
    }

    /// Fully deactivate and clear all loaded lines.
    /// Called when the user turns the toggle OFF.
    pub fn deactivate(&mut self) {
        if self.active || !self.lines.is_empty() {
            log::info!("[LYRIC] Deactivated (lines cleared)");
        }
        self.active = false;
        self.lines.clear();
        self.accumulated_text.clear();
    }

    /// Process a transcript fragment and check whether the singer has moved
    /// to the next line.
    ///
    /// Returns `Some(ReadingAdvance)` when the tracker advances.
    /// Returns `None` when still on the current line or no match found.
    /// Automatically pauses (without clearing lines) after the timeout.
    pub fn check_transcript(&mut self, text: &str) -> Option<ReadingAdvance> {
        if !self.active || self.lines.is_empty() {
            return None;
        }

        // Timeout: pause but retain lines so voice nav can re-activate.
        if self.last_match_time.elapsed().as_millis() > READING_MODE_TIMEOUT_MS {
            log::info!("[LYRIC] Timeout — pausing (lines retained)");
            self.active = false;
        }

        // Explicit line-number / next / previous voice commands work even
        // while paused — they re-activate tracking.
        if !self.lines.is_empty() {
            if let Some(advance) = self.check_line_number_reference(text) {
                self.active = true;
                return Some(advance);
            }
        }

        if !self.active {
            return None;
        }

        // Accumulate fragments for multi-fragment matching.
        if !self.accumulated_text.is_empty() {
            self.accumulated_text.push(' ');
        }
        self.accumulated_text.push_str(text);

        if self.accumulated_text.len() > 4096 {
            log::warn!(
                "[LYRIC] accumulated_text large: {} bytes (no advance since last clear)",
                self.accumulated_text.len()
            );
        }

        let transcript_words = text_to_word_set(&self.accumulated_text);

        // --- Check current line ---
        if let Some(current) = self.lines.get(self.current_index) {
            let threshold = adaptive_overlap_threshold(current.word_count);
            let overlap = word_overlap(&transcript_words, &current.words, current.word_count);

            if overlap >= threshold {
                // Current line matches — check whether next line also matches
                // (singer has already moved on).
                let next_idx = self.current_index + 1;
                if next_idx < self.lines.len() {
                    let next = &self.lines[next_idx];
                    let next_threshold = adaptive_overlap_threshold(next.word_count);
                    let next_overlap =
                        word_overlap(&transcript_words, &next.words, next.word_count);
                    if next_overlap >= next_threshold {
                        return self.advance_to(next_idx);
                    }
                }
                // Still on current line.
                self.last_match_time = Instant::now();
                return None;
            }
        }

        // --- Check next line (singer moved ahead without us catching current) ---
        let next_idx = self.current_index + 1;
        if next_idx < self.lines.len() {
            let next = &self.lines[next_idx];
            let threshold = adaptive_overlap_threshold(next.word_count);
            let overlap = word_overlap(&transcript_words, &next.words, next.word_count);
            if overlap >= threshold {
                return self.advance_to(next_idx);
            }
        }

        // --- Check line after next (singer skipped one) ---
        let skip_idx = self.current_index + 2;
        if skip_idx < self.lines.len() {
            let skip = &self.lines[skip_idx];
            let threshold = adaptive_overlap_threshold(skip.word_count);
            let overlap = word_overlap(&transcript_words, &skip.words, skip.word_count);
            if overlap >= threshold {
                return self.advance_to(skip_idx);
            }
        }

        None
    }

    /// Handle explicit navigation voice commands:
    /// - "line three" / "line 4" → jump to that line index
    /// - "next" / "next line"    → advance by 1
    /// - "previous line" / "go back" → go back by 1
    fn check_line_number_reference(&mut self, text: &str) -> Option<ReadingAdvance> {
        let lower = text.to_lowercase();
        let trimmed = lower.trim();

        // "next" / "next line"
        if matches!(trimmed, "next" | "next." | "next line" | "next line.") {
            let next_idx = self.current_index + 1;
            if next_idx < self.lines.len() {
                log::info!("[LYRIC] 'Next' command");
                return self.advance_to(next_idx);
            }
            return None;
        }

        // "previous line" / "go back"
        if matches!(
            trimmed,
            "previous line" | "previous line." | "go back" | "go back."
        ) {
            if self.current_index > 0 {
                let prev_idx = self.current_index - 1;
                log::info!("[LYRIC] 'Previous' command");
                return self.advance_to(prev_idx);
            }
            return None;
        }

        // "line N" or "line <spoken>"
        let cleaned = trimmed
            .replace("line line ", "line ")
            .replace("lines lines ", "lines ");

        let line_num = extract_line_number(&cleaned)?;

        for (idx, l) in self.lines.iter().enumerate() {
            if l.line_index == line_num {
                log::info!("[LYRIC] Line number reference: line {line_num}");
                return self.advance_to(idx);
            }
        }

        None
    }

    /// Advance the tracker to `index` and emit a `ReadingAdvance`.
    fn advance_to(&mut self, index: usize) -> Option<ReadingAdvance> {
        let line = self.lines.get(index)?;
        let line_index = line.line_index;
        let line_text = line.text.clone();

        self.current_index = index;
        self.last_match_time = Instant::now();
        self.accumulated_text.clear();

        let reference = format!(
            "{} — {}, line {}",
            self.song_id, self.section_label, line_index
        );
        log::info!("[LYRIC] Advanced to: {reference}");

        Some(ReadingAdvance {
            song_id: self.song_id.clone(),
            section_label: self.section_label.clone(),
            line_index,
            line_text,
            reference,
            confidence: 1.0,
        })
    }
}

impl Default for ReadingMode {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract a line number from text containing "line N" or a bare number.
fn extract_line_number(text: &str) -> Option<usize> {
    for keyword in &["line ", "lines "] {
        if let Some(pos) = text.find(keyword) {
            let rest = &text[pos + keyword.len()..];
            return parse_line_number_token(rest);
        }
    }
    // Bare number fallback
    parse_line_number_token(text)
}

/// Parse a non-zero line number (digit or spoken word, max 50) from `text`.
fn parse_line_number_token(text: &str) -> Option<usize> {
    let trimmed = text.trim_end_matches(['.', ',', '?', '!']);
    let token: String = trimmed.chars().take_while(|c| c.is_alphanumeric()).collect();
    if let Ok(n) = token.parse::<usize>() {
        if n > 0 && n <= 50 {
            return Some(n);
        }
    }
    let word: String = trimmed.chars().take_while(|c| c.is_alphabetic()).collect();
    if !word.is_empty() {
        if let Some(n) = parse_spoken_number(&word) {
            let n = n as usize;
            if n > 0 && n <= 50 {
                return Some(n);
            }
        }
    }
    None
}

/// Convert text to a set of lowercase, punctuation-stripped words (len >= 2).
fn text_to_word_set(text: &str) -> HashSet<String> {
    text.split_whitespace()
        .map(|w| {
            w.to_lowercase()
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '\'')
                .collect::<String>()
        })
        .filter(|w| w.len() >= 2)
        .collect()
}

/// Fraction of `line_words` that appear in `transcript_words`.
fn word_overlap(
    transcript_words: &HashSet<String>,
    line_words: &HashSet<String>,
    line_word_count: usize,
) -> f64 {
    if line_word_count == 0 {
        return 0.0;
    }
    let matches = line_words.intersection(transcript_words).count();
    #[expect(
        clippy::cast_precision_loss,
        reason = "word counts are small enough for f64 precision"
    )]
    {
        matches as f64 / line_word_count as f64
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_lines() -> Vec<(usize, String)> {
        vec![
            (0, "Amazing grace how sweet the sound that saved a wretch like me".to_string()),
            (1, "I once was lost but now am found was blind but now I see".to_string()),
            (2, "Twas grace that taught my heart to fear and grace my fears relieved".to_string()),
            (3, "How precious did that grace appear the hour I first believed".to_string()),
        ]
    }

    #[test]
    fn test_starts_inactive() {
        let rm = ReadingMode::new();
        assert!(!rm.is_active());
        assert!(rm.current_line_index().is_none());
    }

    #[test]
    fn test_start_activates() {
        let mut rm = ReadingMode::new();
        rm.start("amazing-grace", "Verse 1", 0, sample_lines());
        assert!(rm.is_active());
        assert_eq!(rm.current_line_index(), Some(0));
    }

    #[test]
    fn test_advance_on_next_line_match() {
        let mut rm = ReadingMode::new();
        rm.start("amazing-grace", "Verse 1", 0, sample_lines());

        // Feed line 0 — should stay on line 0
        let r = rm.check_transcript(
            "amazing grace how sweet the sound that saved a wretch like me",
        );
        assert!(r.is_none());

        // Feed line 1 — should advance
        let r = rm.check_transcript(
            "i once was lost but now am found was blind but now i see",
        );
        assert!(r.is_some());
        let adv = r.unwrap();
        assert_eq!(adv.line_index, 1);
        assert!(adv.reference.contains("Verse 1"));
    }

    #[test]
    fn test_deactivate() {
        let mut rm = ReadingMode::new();
        rm.start("amazing-grace", "Verse 1", 0, sample_lines());
        assert!(rm.is_active());
        rm.deactivate();
        assert!(!rm.is_active());
        assert!(!rm.has_lines());
    }

    #[test]
    fn test_no_match_returns_none() {
        let mut rm = ReadingMode::new();
        rm.start("amazing-grace", "Verse 1", 0, sample_lines());
        let r = rm.check_transcript("the weather is nice today and I like coffee");
        assert!(r.is_none());
    }

    #[test]
    fn test_word_overlap_function() {
        let transcript = text_to_word_set("amazing grace how sweet the sound");
        let line = text_to_word_set(
            "amazing grace how sweet the sound that saved a wretch like me",
        );
        let count = line.len();
        let overlap = word_overlap(&transcript, &line, count);
        assert!(overlap > 0.4);
    }

    #[test]
    fn test_next_command() {
        let mut rm = ReadingMode::new();
        rm.start("amazing-grace", "Verse 1", 0, sample_lines());
        let r = rm.check_transcript("next line");
        assert!(r.is_some());
        assert_eq!(r.unwrap().line_index, 1);
    }

    #[test]
    fn test_previous_command() {
        let mut rm = ReadingMode::new();
        rm.start("amazing-grace", "Verse 1", 0, sample_lines());
        // Advance to line 2 first
        rm.check_transcript("i once was lost but now am found was blind but now i see");
        let _ = rm.check_transcript("twas grace that taught my heart to fear and grace my fears relieved");
        // Now go back
        let r = rm.check_transcript("go back");
        assert!(r.is_some());
    }

    #[test]
    fn test_backward_line_navigation() {
        let mut rm = ReadingMode::new();
        let lines: Vec<(usize, String)> = (0..10)
            .map(|i| (i, format!("lyric line number {} content here", i)))
            .collect();
        rm.start("test-song", "Chorus", 5, lines);
        assert_eq!(rm.current_line_index(), Some(5));

        let r = rm.check_transcript("line three");
        assert!(r.is_some());
        assert_eq!(r.unwrap().line_index, 3);
    }

    #[test]
    fn test_adaptive_threshold_short_line() {
        // A 3-word line needs 0.85 overlap
        assert_eq!(adaptive_overlap_threshold(3), 0.85);
    }

    #[test]
    fn test_adaptive_threshold_long_line() {
        // A 20-word line needs only 0.35 overlap
        assert_eq!(adaptive_overlap_threshold(20), 0.35);
    }

    #[test]
    fn test_short_lyric_no_false_positive() {
        let mut rm = ReadingMode::new();
        // "Holy holy holy" — 3 meaningful words, very high threshold
        let lines = vec![
            (0, "Holy holy holy".to_string()),
            (1, "Lord God almighty".to_string()),
        ];
        rm.start("holy-holy-holy", "Chorus", 0, lines);

        // Ambient speech that shares one word should NOT trigger advance
        let r = rm.check_transcript("that was a holy moment today");
        assert!(r.is_none());
    }

    #[test]
    fn test_extract_line_number_spoken() {
        assert_eq!(extract_line_number("line three"), Some(3));
        assert_eq!(extract_line_number("line 4"), Some(4));
        assert_eq!(extract_line_number("5"), Some(5));
        assert_eq!(extract_line_number("hello world"), None);
    }

    #[test]
    fn test_start_positions_cursor_at_start_line() {
        let mut rm = ReadingMode::new();
        let lines: Vec<(usize, String)> = (0..10)
            .map(|i| (i, format!("Line {} text here", i)))
            .collect();
        rm.start("test-song", "Bridge", 6, lines);
        assert_eq!(rm.current_line_index(), Some(6));
    }
}
