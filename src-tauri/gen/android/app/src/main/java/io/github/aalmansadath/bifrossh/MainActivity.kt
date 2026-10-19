package io.github.aalmansadath.bifrossh

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
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
}
