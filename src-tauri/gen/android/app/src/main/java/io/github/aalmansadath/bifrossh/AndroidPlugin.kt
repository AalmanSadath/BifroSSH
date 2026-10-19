package io.github.aalmansadath.bifrossh

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
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
}
