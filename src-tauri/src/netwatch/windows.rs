//! An IP address change callback, from the IP helper API.
//!
//! Registered once for the life of the process and never cancelled, like the
//! power callback in `suspend::windows`: the app handle it needs is leaked on
//! purpose so the callback, which the system invokes on a thread of its own,
//! always has something valid to point at.
//!
//! An address is what changes when the machine moves networks: the old
//! one goes and a new one comes. Every add, remove and change is passed on,
//! and `notify` waits for them to settle.

use std::ffi::c_void;

use tauri::AppHandle;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::NetworkManagement::IpHelper::{
    NotifyUnicastIpAddressChange, MIB_NOTIFICATION_TYPE, MIB_UNICASTIPADDRESS_ROW,
};
use windows::Win32::Networking::WinSock::AF_UNSPEC;

unsafe extern "system" fn on_change(
    context: *const c_void,
    _row: *const MIB_UNICASTIPADDRESS_ROW,
    _kind: MIB_NOTIFICATION_TYPE,
) {
    // SAFETY: `context` is the leaked AppHandle registered in `watch`, which
    // lives for the whole process.
    let app = unsafe { &*(context as *const AppHandle) };
    super::notify(app);
}

pub(super) fn watch(app: AppHandle) {
    let app: &'static AppHandle = Box::leak(Box::new(app));
    let mut handle = HANDLE::default();
    // A failure to register means no early reconnect, and keepalives still
    // find the dead connections. Nothing useful to do with the code here.
    let _ = unsafe {
        NotifyUnicastIpAddressChange(
            AF_UNSPEC,
            Some(on_change),
            Some(app as *const AppHandle as *const c_void),
            false,
            &mut handle,
        )
    };
}
