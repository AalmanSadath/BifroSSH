//! A power notification callback, for `PBT_APMSUSPEND`.
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
use windows::Win32::UI::WindowsAndMessaging::{DEVICE_NOTIFY_CALLBACK, PBT_APMSUSPEND};

unsafe extern "system" fn on_power(context: *const c_void, kind: u32, _setting: *const c_void) -> u32 {
    if kind == PBT_APMSUSPEND {
        // SAFETY: `context` is the leaked AppHandle registered in `watch`,
        // which lives for the whole process.
        let app = unsafe { &*(context as *const AppHandle) };
        super::on_suspend(app);
    }
    0
}

pub(super) fn watch(app: AppHandle) {
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
