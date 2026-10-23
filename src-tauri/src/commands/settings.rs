use tauri::State;

use crate::models::*;

use super::CmdResult;
use super::AppState;

// ── Settings ─────────────────────────────────────────────────────────────────

/// What the desktop reports about its own appearance.
///
/// Advisory, and never an error: a desktop that cannot be asked answers "no
/// preference" with no accent, which is the same as one that has no opinion.
/// On a blocking thread because it has to be: zbus's blocking API drives its
/// own executor, and calling it straight from a command panics with "Cannot
/// start a runtime from within a runtime". `keyring` uses the same API without
/// this only because it runs at startup, before the runtime exists.
///
/// Android answers from the Activity, by way of the app's own plugin.
#[tauri::command]
pub async fn system_appearance(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: tauri::AppHandle,
) -> crate::appearance::SystemAppearance {
    #[cfg(target_os = "android")]
    let read = move || crate::android::system_appearance(&app);
    #[cfg(not(target_os = "android"))]
    let read = crate::appearance::read;
    tokio::task::spawn_blocking(read).await.unwrap_or_default()
}

/// Whether the user's files can be read and written by path. Always on a
/// desktop; on Android only once All files access is granted.
#[tauri::command]
pub async fn storage_access(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: tauri::AppHandle,
) -> bool {
    #[cfg(target_os = "android")]
    return tokio::task::spawn_blocking(move || crate::android::storage_access(&app))
        .await
        .unwrap_or(false);
    #[cfg(not(target_os = "android"))]
    true
}

/// Asks Android for All files access. Nothing to ask for anywhere else.
#[tauri::command]
pub async fn request_storage_access(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: tauri::AppHandle,
) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    return tokio::task::spawn_blocking(move || crate::android::request_storage_access(&app))
        .await
        .map_err(|e| e.to_string())?
        .map_err(Into::into);
    #[cfg(not(target_os = "android"))]
    Ok(())
}

/// Tells Android how many connections are open, so it keeps the process
/// alive in the background while any are. Nothing to do anywhere else.
#[tauri::command]
pub async fn android_keep_alive(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: tauri::AppHandle,
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] count: u32,
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] wake_lock: bool,
) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    return tokio::task::spawn_blocking(move || crate::android::keep_alive(&app, count, wake_lock))
        .await
        .map_err(|e| e.to_string())?
        .map_err(Into::into);
    #[cfg(not(target_os = "android"))]
    Ok(())
}

/// Hands the volume keys to the terminal's text size, or back to the
/// volume. Android only.
#[tauri::command]
pub async fn android_volume_keys(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: tauri::AppHandle,
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] enabled: bool,
) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    return tokio::task::spawn_blocking(move || crate::android::volume_keys(&app, enabled))
        .await
        .map_err(|e| e.to_string())?
        .map_err(Into::into);
    #[cfg(not(target_os = "android"))]
    Ok(())
}

/// What the app was opened for from outside, if anything is waiting:
/// a launcher shortcut or an `ssh://` link. Android only.
#[tauri::command]
pub async fn android_take_launch(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: tauri::AppHandle,
) -> CmdResult<Option<serde_json::Value>> {
    #[cfg(target_os = "android")]
    return tokio::task::spawn_blocking(move || crate::android::take_launch(&app))
        .await
        .map_err(|e| e.to_string())?
        .map(|l| l.and_then(|l| serde_json::to_value(l).ok()))
        .map_err(Into::into);
    #[cfg(not(target_os = "android"))]
    Ok(None)
}

/// A host was connected to: it goes to the top of the launcher shortcuts.
#[tauri::command]
pub async fn android_host_used(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: tauri::AppHandle,
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] id: String,
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] label: String,
) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    return tokio::task::spawn_blocking(move || crate::android::host_used(&app, &id, &label))
        .await
        .map_err(|e| e.to_string())?
        .map_err(Into::into);
    #[cfg(not(target_os = "android"))]
    Ok(())
}

/// Asks the launcher to pin a host to the home screen.
#[tauri::command]
pub async fn android_pin_host(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: tauri::AppHandle,
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] id: String,
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] label: String,
) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    return tokio::task::spawn_blocking(move || crate::android::pin_host(&app, &id, &label))
        .await
        .map_err(|e| e.to_string())?
        .map_err(Into::into);
    #[cfg(not(target_os = "android"))]
    Ok(())
}

/// Hosts were deleted: their shortcuts go, and pinned ones stop working.
#[tauri::command]
pub async fn android_hosts_removed(
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] app: tauri::AppHandle,
    #[cfg_attr(not(target_os = "android"), allow(unused_variables))] ids: Vec<String>,
) -> CmdResult<()> {
    #[cfg(target_os = "android")]
    return tokio::task::spawn_blocking(move || crate::android::hosts_removed(&app, &ids))
        .await
        .map_err(|e| e.to_string())?
        .map_err(Into::into);
    #[cfg(not(target_os = "android"))]
    Ok(())
}

/// Which platform the app is running on.
///
/// The frontend needs it for exactly one thing: local paths are separated by
/// `\\` on Windows and `/` everywhere else, and every breadcrumb, rename and
/// save target is built from strings the backend hands over. See `src/paths.ts`.
///
/// A command rather than `@tauri-apps/plugin-os`, which would mean a new npm
/// dependency, a new capability entry and a Flatpak node-sources regeneration
/// for one string.
#[tauri::command]
pub async fn platform() -> &'static str {
    std::env::consts::OS
}

/// Where the vault, the keystore and the backups live.
///
/// Named to the user rather than described, because the recovery advice is to
/// restore that directory and a wrong path sends them looking in the wrong
/// place. It differs by platform, so the frontend must not spell it out.
#[tauri::command]
pub async fn data_dir() -> CmdResult<String> {
    Ok(crate::store::get_data_dir()?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    Ok(state.data.lock().await.settings.clone())
}

#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    data.settings = settings;
    state.save(&data)
}

/// The monospace families installed on this machine, for the font picker.
///
/// Offering only installed families matters because the setting feeds straight
/// into xterm's `fontFamily`. A name nothing resolves silently falls back to
/// whatever the webview picks, which looks like the setting was ignored.
#[tauri::command]
pub async fn list_fonts() -> CmdResult<Vec<String>> {
    let mut families = monospace_families().await?;

    // Both steps compare the same way. Sorting case-insensitively and then
    // deduplicating case-sensitively let "Fira Code" and "fira code" sit next
    // to each other in the list and both survive.
    families.sort_unstable_by_key(|f| f.to_lowercase());
    families.dedup_by_key(|f| f.to_lowercase());
    Ok(families)
}

/// Emoji fonts are fixed advance and so count as monospace on both platforms,
/// but nobody wants a terminal rendered in one.
#[cfg(not(target_os = "android"))]
fn wanted(family: &str) -> bool {
    !family.is_empty() && !family.to_lowercase().contains("emoji")
}

/// Shelling out to `fc-list` rather than linking fontconfig: the binary is
/// present both on a normal desktop and in the Flatpak runtime, and this runs
/// once when Settings opens rather than on any hot path.
#[cfg(not(any(windows, target_os = "android")))]
async fn monospace_families() -> CmdResult<Vec<String>> {
    let out = tokio::process::Command::new("fc-list")
        .args([":mono", "family"])
        .output()
        .await?;
    if !out.status.success() {
        return Err("Could not list installed fonts".into());
    }

    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        // Each line is the family and its aliases, canonical name first, so the
        // weight variants of one family collapse onto the family itself.
        .filter_map(|l| l.split(',').next())
        .map(str::trim)
        .filter(|f| wanted(f))
        .map(str::to_string)
        .collect())
}

/// DirectWrite is the `fc-list :mono` of Windows: the same font collection the
/// shell and the webview resolve names against, and `IsMonospacedFont` is a
/// real answer rather than a guess from the name. The registry's font list
/// would give filenames and no monospace flag.
///
/// On a blocking thread because it is COM, and this is an async command.
/// Android has no fontconfig, and the WebView offers its own monospace face
/// and nothing a user installed. The list stays empty and the setting keeps
/// what it holds.
#[cfg(target_os = "android")]
async fn monospace_families() -> CmdResult<Vec<String>> {
    Ok(Vec::new())
}

#[cfg(windows)]
async fn monospace_families() -> CmdResult<Vec<String>> {
    tokio::task::spawn_blocking(directwrite_families)
        .await
        .map_err(|e| format!("Could not list installed fonts: {e}"))?
}

#[cfg(windows)]
fn directwrite_families() -> CmdResult<Vec<String>> {
    use windows::core::Interface;
    use windows::Win32::Graphics::DirectWrite::{
        DWriteCreateFactory, IDWriteFactory, IDWriteFont1, IDWriteFontCollection,
        DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
        DWRITE_FONT_WEIGHT_NORMAL,
    };

    unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)
            .map_err(|e| format!("Could not open the font collection: {e}"))?;

        let mut collection: Option<IDWriteFontCollection> = None;
        factory
            .GetSystemFontCollection(&mut collection, false)
            .map_err(|e| format!("Could not read the font collection: {e}"))?;
        let collection = collection.ok_or("Could not read the font collection")?;

        let mut families = Vec::new();
        for i in 0..collection.GetFontFamilyCount() {
            let Ok(family) = collection.GetFontFamily(i) else { continue };

            // The regular face stands for the family: a family is monospaced
            // or it is not, and asking every weight would just repeat it.
            let Ok(font) = family.GetFirstMatchingFont(
                DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_FONT_STRETCH_NORMAL,
                DWRITE_FONT_STYLE_NORMAL,
            ) else {
                continue;
            };
            // IsMonospacedFont arrived with IDWriteFont1; a font that does not
            // answer to it is old enough that it is not what anyone is looking
            // for in this list.
            let Ok(font) = font.cast::<IDWriteFont1>() else { continue };
            if !font.IsMonospacedFont().as_bool() {
                continue;
            }

            let Ok(names) = family.GetFamilyNames() else { continue };
            if let Some(name) = localised_name(&names).filter(|n| wanted(n)) {
                families.push(name);
            }
        }
        Ok(families)
    }
}

/// The family name in the user's own language where there is one, and whatever
/// the font lists first where there is not.
#[cfg(windows)]
fn localised_name(
    names: &windows::Win32::Graphics::DirectWrite::IDWriteLocalizedStrings,
) -> Option<String> {
    unsafe {
        let mut index = 0u32;
        let mut found = windows::core::BOOL::default();
        let locale = sys_locale();
        let _ = names.FindLocaleName(
            windows::core::PCWSTR(locale.as_ptr()),
            &mut index,
            &mut found,
        );
        if !found.as_bool() {
            index = 0;
        }

        let len = names.GetStringLength(index).ok()? as usize;
        // GetString writes a null terminator, so the buffer is one longer than
        // the length it just reported.
        let mut buf = vec![0u16; len + 1];
        names.GetString(index, &mut buf).ok()?;
        buf.truncate(len);
        Some(String::from_utf16_lossy(&buf))
    }
}

/// The UI locale as a null-terminated wide string, falling back to US English,
/// which is the locale a font that names only one always uses.
#[cfg(windows)]
fn sys_locale() -> Vec<u16> {
    use windows::Win32::Globalization::GetUserDefaultLocaleName;

    // LOCALE_NAME_MAX_LENGTH, which the crate does not re-export.
    let mut buf = [0u16; 85];
    let len = unsafe { GetUserDefaultLocaleName(&mut buf) };
    if len > 1 {
        buf[..len as usize].to_vec()
    } else {
        "en-us\0".encode_utf16().collect()
    }
}
