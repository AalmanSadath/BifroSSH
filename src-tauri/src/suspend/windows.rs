//! A power notification callback, for `PBT_APMSUSPEND`, and for
//! `PBT_APMRESUMEAUTOMATIC`, which is passed to `netwatch`. Session change
//! notifications for `WTS_SESSION_LOCK`, the screen locking.
//!
//! Registered once for the life of the process and never unregistered: the
//! app handle it needs is leaked on purpose so the callback, which the system
//! invokes on a thread of its own, always has something valid to point at.

use std::ffi::c_void;

use tauri::AppHandle;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Power::{
    PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND,
};

unsafe extern "system" fn on_power(context: *const c_void, kind: u32, _setting: *const c_void) -> u32 {
    // SAFETY: `context` is the leaked AppHandle registered in `watch`,
    // which lives for the whole process.
    let app = unsafe { &*(context as *const AppHandle) };
    if kind == PBT_APMSUSPEND {
        super::on_suspend(app);
    } else if kind == PBT_APMRESUMEAUTOMATIC {
        crate::netwatch::notify(app);
    }
    0
}

pub(super) fn watch(app: AppHandle) {
    watch_screen_lock(app.clone());
    let app: &'static AppHandle = Box::leak(Box::new(app));
    // Leaked with the handle: the system keeps a pointer to this struct.
    let params: &'static mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS =
        Box::leak(Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power),
            Context: app as *const AppHandle as *mut c_void,
        }));
    let mut registration: *mut c_void = std::ptr::null_mut();
    // A failure to register means no lock on suspend, which the idle timeout
    // and the shortcut still cover. Nothing useful to do with the code here.
    let _ = unsafe {
        PowerRegisterSuspendResumeNotification(
            DEVICE_NOTIFY_CALLBACK,
            HANDLE(params as *mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS as *mut c_void),
            &mut registration,
        )
    };
}

// ── Screen lock ──────────────────────────────────────────────────────────────
//
// Session changes come as window messages, so they need a window and a thread
// pumping its messages. A message-only window, never shown, on a thread of
// its own: the app's real windows belong to the webview's event loop, which
// is not this module's to hook into.

use std::sync::OnceLock;

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, HWND_MESSAGE, MSG,
    WINDOW_EX_STYLE, WINDOW_STYLE, WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_SESSION_LOCK,
};

/// The handle the window procedure locks through. The procedure is a plain
/// function the system calls, so it has nowhere else to find one.
static LOCK_APP: OnceLock<AppHandle> = OnceLock::new();

unsafe extern "system" fn session_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_WTSSESSION_CHANGE && wparam.0 as u32 == WTS_SESSION_LOCK {
        if let Some(app) = LOCK_APP.get() {
            super::on_screen_lock(app);
        }
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn watch_screen_lock(app: AppHandle) {
    if LOCK_APP.set(app).is_err() {
        return;
    }
    std::thread::spawn(|| unsafe {
        // Any failure here means no lock with the screen, which the idle
        // timeout and the shortcut still cover.
        let Ok(module) = GetModuleHandleW(None) else { return };
        let class = w!("BifroSSHSessionWatch");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(session_proc),
            hInstance: module.into(),
            lpszClassName: class,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            return;
        }
        let Ok(hwnd) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(module.into()),
            None,
        ) else {
            return;
        };
        if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION).is_err() {
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    });
}
