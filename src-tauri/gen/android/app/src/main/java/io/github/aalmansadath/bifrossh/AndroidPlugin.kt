package io.github.aalmansadath.bifrossh

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
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

  /** Whether the app may read and write shared storage by path. */
  @Command
  fun storageAccess(invoke: Invoke) {
    val ret = JSObject()
    ret.put("granted", storageGranted())
    invoke.resolve(ret)
  }

  /**
   * Asks for it: the system's All files access page for this app from
   * Android 11, which the user comes back from on their own, and the plain
   * storage permission prompt before that.
   */
  @Command
  fun requestStorageAccess(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val forApp = Intent(
        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
        Uri.parse("package:" + activity.packageName)
      )
      try {
        activity.startActivity(forApp)
      } catch (e: Exception) {
        // Some builds have only the list of every app, not the page for one.
        activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
      }
    } else {
      ActivityCompat.requestPermissions(
        activity,
        arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE),
        0
      )
    }
    invoke.resolve()
  }

  private fun storageGranted(): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Environment.isExternalStorageManager()
    } else {
      ContextCompat.checkSelfPermission(activity, Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
        PackageManager.PERMISSION_GRANTED
    }
}
