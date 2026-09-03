//! The Win32 clipboard, read as CF_UNICODETEXT.
//!
//! No dependency beyond the `windows` crate the DPAPI keyring and the theme
//! already pull in: opening the clipboard, taking the one format that is
//! text, and copying it out before letting go.

use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

/// CF_UNICODETEXT. The `windows` crate puts the clipboard format constants
/// behind `Win32_System_Ole`, which is a large feature to enable for one
/// number that has been 13 since Win32 shipped.
const CF_UNICODETEXT: u32 = 13;

pub(super) fn read_text(_app: &tauri::AppHandle) -> Result<String, String> {
    // Another process can hold the clipboard open, and the documented answer
    // is to try again rather than to fail. Ten attempts over a tenth of a
    // second, which is far below what a person notices after a right click.
    let mut opened = false;
    for _ in 0..10 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    if !opened {
        return Err("Another application is holding the clipboard".into());
    }

    let result = read_open();
    // Nothing useful to do if this fails, and the text is already copied.
    let _ = unsafe { CloseClipboard() };
    result
}

/// The read itself, with the clipboard already open so that every exit path
/// above closes it exactly once.
fn read_open() -> Result<String, String> {
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }.is_err() {
        // Something is on the clipboard, but it is not text. Not an error:
        // the caller pastes nothing, the same as an empty clipboard.
        return Ok(String::new());
    }

    let handle: HANDLE =
        unsafe { GetClipboardData(CF_UNICODETEXT) }.map_err(|e| format!("Clipboard read failed: {e}"))?;

    let hglobal = HGLOBAL(handle.0);
    let ptr = unsafe { GlobalLock(hglobal) } as *const u16;
    if ptr.is_null() {
        return Err("Could not lock the clipboard's memory".into());
    }

    // The block is NUL terminated, and GlobalSize rounds up to the allocation
    // rather than the string, so the terminator is what says where it ends.
    let mut len = 0usize;
    while unsafe { *ptr.add(len) } != 0 {
        len += 1;
    }
    let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(ptr, len) });

    let _ = unsafe { GlobalUnlock(hglobal) };
    Ok(text)
}
