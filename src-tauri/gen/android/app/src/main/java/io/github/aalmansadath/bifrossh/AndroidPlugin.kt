package io.github.aalmansadath.bifrossh

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * What the Rust side needs from Android that only the Activity can reach.
 * Registered by src-tauri/src/android.rs.
 */
@TauriPlugin
class AndroidPlugin(private val activity: Activity) : Plugin(activity) {
  /**
   * The clipboard as text, or empty when it holds nothing that reads as
   * text. The WebView cannot read it: the permission it asks for is one
   * Android's WebView never grants.
   */
  @Command
  fun readClipboard(invoke: Invoke) {
    val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = manager.primaryClip
    val text = if (clip != null && clip.itemCount > 0) {
      clip.getItemAt(0).coerceToText(activity)?.toString() ?: ""
    } else {
      ""
    }
    val ret = JSObject()
    ret.put("text", text)
    invoke.resolve(ret)
  }

  /**
   * Whether night mode is on, and from Android 12 the Material You accent
   * taken from the wallpaper. The shade is the one Material itself uses on
   * that background: lighter on dark, darker on light.
   */
  @Command
  fun systemAppearance(invoke: Invoke) {
    val night = (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
      Configuration.UI_MODE_NIGHT_YES
    val ret = JSObject()
    ret.put("colorScheme", if (night) "dark" else "light")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val shade = if (night) android.R.color.system_accent1_200 else android.R.color.system_accent1_600
      ret.put("accent", String.format("#%06x", activity.getColor(shade) and 0xffffff))
    }
    invoke.resolve(ret)
  }
}
