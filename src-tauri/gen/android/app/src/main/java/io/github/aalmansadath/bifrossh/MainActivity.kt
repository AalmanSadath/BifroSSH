package io.github.aalmansadath.bifrossh

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.plugin.JSObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Edge to edge is enforced from Android 15, and the WebView does not keep
    // clear of the status bar or the navigation bar by itself, so the page's
    // top row sat under the status bar. Padding the content view by those
    // bars keeps the page inside them. The keyboard is in the same sum
    // because edge to edge also turns off adjustResize: without it the
    // keyboard would cover the prompt instead of shrinking the terminal.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }

    // Recreated for a configuration change, the intent is the one already
    // handled when the Activity first started.
    if (savedInstanceState == null) handleLaunch(intent)
  }

  /**
   * Keeps what the app was opened for, for the page to take once it is
   * ready (AndroidPlugin.takeLaunch): a launcher shortcut's host. A page
   * already running is told now; one still loading, or locked, asks when
   * it gets there.
   */
  private fun handleLaunch(intent: Intent?) {
    if (intent == null) return
    val launch = JSObject()
    val hostId = intent.getStringExtra(EXTRA_HOST_ID)
    when {
      hostId != null -> {
        launch.put("kind", "host")
        launch.put("id", hostId)
      }
      else -> return
    }
    pendingLaunch = launch
    webView?.evaluateJavascript("window.__bifrosshLaunch && window.__bifrosshLaunch()", null)
  }

  // Back goes to the page first: it closes whatever is open there, or steps
  // back to the Hosts page (src/backStack.ts). Only when the page has
  // nothing to undo does Back leave the app. Added after the WebView's own
  // callback, so it is asked first.
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("window.__bifrosshBack ? window.__bifrosshBack() : false") { spent ->
          if (spent != "true") {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
      }
    })
  }

  /**
   * A shortcut reaching the running app, or the notification's
   * "Disconnect all" (SessionService).
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleLaunch(intent)
    if (intent.getBooleanExtra(EXTRA_DISCONNECT_ALL, false)) {
      intent.removeExtra(EXTRA_DISCONNECT_ALL)
      webView?.evaluateJavascript("window.__bifrosshDisconnectAll && window.__bifrosshDisconnectAll()", null)
    }
  }

  // The volume keys step the terminal's text size while a terminal is in
  // front and the setting is on; the page says when (AndroidPlugin
  // volumeKeys). Anywhere else they are the volume keys. Both the press and
  // the release are taken, or the release would still reach the system.
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val step = when (event.keyCode) {
      KeyEvent.KEYCODE_VOLUME_UP -> 1
      KeyEvent.KEYCODE_VOLUME_DOWN -> -1
      else -> 0
    }
    if (step != 0 && volumeZoom) {
      if (event.action == KeyEvent.ACTION_DOWN) {
        webView?.evaluateJavascript("window.__bifrosshVolume && window.__bifrosshVolume($step)", null)
      }
      return true
    }
    return super.dispatchKeyEvent(event)
  }

  companion object {
    const val EXTRA_DISCONNECT_ALL = "disconnectAll"
    const val EXTRA_HOST_ID = "hostId"

    /** What the app was opened for, until the page takes it. */
    @Volatile
    var pendingLaunch: JSObject? = null

    @Volatile
    var volumeZoom = false
  }
}
