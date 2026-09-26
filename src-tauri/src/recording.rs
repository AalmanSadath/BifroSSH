//! A session kept as an asciicast v2 recording, to be played back with its
//! timing, rather than a log to be read.
//!
//! The format is one JSON header line, then one line per event:
//! `[seconds, "o", "text"]` for output and `[seconds, "r", "COLSxROWS"]` for a
//! resize. Only output is kept, never what was typed, so a password typed
//! with echo off never reaches the file; anything the host printed does, so
//! the file is private like a session log and lives beside them.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

use crate::sessionlog::{file_stem, private_file};

pub struct Recorder {
    file: File,
    start: Instant,
    /// The start of a character whose other bytes are still to come. Output
    /// arrives in chunks cut anywhere, and an event must be whole text.
    carry: Vec<u8>,
}

impl Recorder {
    /// Opens a fresh recording in `dir` and writes its header.
    pub fn create(dir: &Path, label: &str, session_id: &str, cols: u32, rows: u32) -> Result<(PathBuf, Self)> {
        let now = SystemTime::now();
        let path = dir.join(format!("{}.cast", file_stem(label, session_id, now)));
        let mut file = private_file(&path)?;
        let header = serde_json::json!({
            "version": 2,
            "width": cols,
            "height": rows,
            "timestamp": now.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            "title": label,
            "env": { "TERM": "xterm-256color" },
        });
        writeln!(file, "{header}").with_context(|| path.display().to_string())?;
        Ok((path, Recorder { file, start: Instant::now(), carry: Vec::new() }))
    }

    /// Output as it came off the wire.
    pub fn output(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.carry.extend_from_slice(bytes);
        let (text, used) = utf8_split(&self.carry);
        self.carry.drain(..used);
        if text.is_empty() {
            return Ok(());
        }
        self.event("o", &text)
    }

    /// The terminal changed size; a player resizes with it.
    pub fn resize(&mut self, cols: u32, rows: u32) -> std::io::Result<()> {
        self.event("r", &format!("{cols}x{rows}"))
    }

    fn event(&mut self, kind: &str, data: &str) -> std::io::Result<()> {
        let line = event_line(self.start.elapsed().as_micros(), kind, data);
        self.file.write_all(line.as_bytes())
    }
}

impl Drop for Recorder {
    /// A character cut off by the end of the recording is written as what it
    /// is, a broken one, rather than left out.
    fn drop(&mut self) {
        if !self.carry.is_empty() {
            let rest = String::from_utf8_lossy(&self.carry).into_owned();
            self.carry.clear();
            let _ = self.event("o", &rest);
        }
    }
}

/// One event line, newline included. The time is microseconds since the
/// recording started, written as seconds.
fn event_line(micros: u128, kind: &str, data: &str) -> String {
    let seconds = micros as f64 / 1_000_000.0;
    let mut line = serde_json::to_string(&(seconds, kind, data)).unwrap_or_default();
    line.push('\n');
    line
}

/// The text at the start of `bytes`, and how many bytes it took.
///
/// A character cut off at the end is left for the next chunk. A byte that
/// can never be part of a character becomes U+FFFD, as a terminal would show
/// it, so one bad byte does not hold up everything after it.
fn utf8_split(bytes: &[u8]) -> (String, usize) {
    let mut text = String::new();
    let mut at = 0;
    loop {
        match std::str::from_utf8(&bytes[at..]) {
            Ok(rest) => {
                text.push_str(rest);
                return (text, bytes.len());
            }
            Err(e) => {
                let valid = at + e.valid_up_to();
                // Checked by from_utf8 just above.
                text.push_str(std::str::from_utf8(&bytes[at..valid]).unwrap_or_default());
                match e.error_len() {
                    Some(bad) => {
                        text.push('\u{FFFD}');
                        at = valid + bad;
                    }
                    None => return (text, valid),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_character_cut_across_chunks_waits_for_its_end() {
        let smile = "🙂".as_bytes();
        let mut chunk = b"hi ".to_vec();
        chunk.extend_from_slice(&smile[..2]);
        assert_eq!(utf8_split(&chunk), ("hi ".to_string(), 3));
        assert_eq!(utf8_split(smile), ("🙂".to_string(), 4));
    }

    #[test]
    fn a_byte_that_is_never_text_is_replaced_and_passed() {
        assert_eq!(utf8_split(b"a\xffb"), ("a\u{FFFD}b".to_string(), 3));
    }

    #[test]
    fn an_event_is_one_line_of_json_with_escapes_escaped() {
        assert_eq!(event_line(1_500_000, "o", "\x1b[31mred\r\n"), "[1.5,\"o\",\"\\u001b[31mred\\r\\n\"]\n");
        assert_eq!(event_line(250, "r", "80x24"), "[0.00025,\"r\",\"80x24\"]\n");
    }

    #[test]
    fn a_recording_is_a_header_then_its_events() {
        let dir = std::env::temp_dir().join(format!("bifrossh-cast-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let (path, mut rec) = Recorder::create(&dir, "web 1", "0123456789", 100, 30).unwrap();
        rec.output(b"ok \xe2\x9c").unwrap();
        rec.resize(120, 40).unwrap();
        rec.output(b"\x93\n").unwrap();
        rec.output(b"\xe2").unwrap();
        drop(rec);

        assert!(path.to_string_lossy().ends_with("_01234567.cast"));
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<serde_json::Value> =
            text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines[0]["version"], 2);
        assert_eq!((lines[0]["width"].as_u64(), lines[0]["height"].as_u64()), (Some(100), Some(30)));
        assert_eq!(lines[0]["title"], "web 1");
        let events: Vec<(String, String)> = lines[1..]
            .iter()
            .map(|e| (e[1].as_str().unwrap().to_string(), e[2].as_str().unwrap().to_string()))
            .collect();
        assert_eq!(
            events,
            [
                ("o".into(), "ok ".into()),
                ("r".into(), "120x40".into()),
                ("o".into(), "✓\n".into()),
                ("o".into(), "\u{FFFD}".into()),
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
