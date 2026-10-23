package io.github.aalmansadath.bifrossh

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

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

  /** The notification's "Disconnect all" (SessionService). */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (intent.getBooleanExtra(EXTRA_DISCONNECT_ALL, false)) {
      intent.removeExtra(EXTRA_DISCONNECT_ALL)
      webView?.evaluateJavascript("window.__bifrosshDisconnectAll && window.__bifrosshDisconnectAll()", null)
    }
  }

  companion object {
    const val EXTRA_DISCONNECT_ALL = "disconnectAll"
  }
}
