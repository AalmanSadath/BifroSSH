//! Recently used hosts in the Windows taskbar's jump list.
//!
//! The desktop's version of the Android launcher shortcuts: right-click the
//! taskbar button, pick a host, and it opens. Each entry runs the app with
//! `--host <id>`, which a running app is handed by the single-instance
//! plugin and a starting one reads from its own command line (`launch`).
//!
//! Which hosts, in what order, is kept in the encrypted document
//! (`AppData::recent_hosts`), since the jump list itself cannot be read
//! back. The list is rebuilt from it whenever it changes. The names shown
//! are the hosts' labels, and they stay in the jump list while the vault is
//! locked, as the Android shortcuts do.

use windows::core::{w, Interface, HSTRING};
use windows::Win32::Foundation::E_FAIL;
use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
};

/// How many hosts the list holds.
pub const RECENT_CAP: usize = 5;

/// Replaces the jump list with these hosts, as (id, label), most recent
/// first. An empty list clears it.
///
/// On a thread of its own: COM wants initialising on the thread that uses
/// it, and the async runtime's threads are not ours to initialise.
pub fn set(hosts: Vec<(String, String)>) {
    std::thread::spawn(move || {
        if let Err(e) = build(&hosts) {
            eprintln!("Could not update the jump list: {e}");
        }
    });
}

fn build(hosts: &[(String, String)]) -> windows::core::Result<()> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let mut slots = 0u32;
        let _removed: IObjectArray = list.BeginList(&mut slots)?;

        if !hosts.is_empty() {
            let exe = std::env::current_exe().map_err(|e| windows::core::Error::new(E_FAIL, e.to_string()))?;
            let exe = HSTRING::from(exe.as_os_str());
            let items: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            for (id, label) in hosts.iter().take(RECENT_CAP) {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                link.SetPath(&exe)?;
                link.SetArguments(&HSTRING::from(format!("{} \"{}\"", crate::launch::HOST_FLAG, id)))?;
                link.SetIconLocation(&exe, 0)?;
                link.SetDescription(&HSTRING::from(format!("Connect to {label}")))?;
                // A link's title, what the list shows, is a property of the
                // link rather than something IShellLink can set.
                let store: IPropertyStore = link.cast()?;
                store.SetValue(&PKEY_Title, &PROPVARIANT::from(label.as_str()))?;
                store.Commit()?;
                items.AddObject(&link)?;
            }
            let array: IObjectArray = items.cast()?;
            list.AppendCategory(w!("Recent hosts"), &array)?;
        }
        list.CommitList()
    }
}

