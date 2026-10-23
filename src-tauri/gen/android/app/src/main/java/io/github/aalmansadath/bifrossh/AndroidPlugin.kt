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
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class DataArgs {
  lateinit var data: String
}

@InvokeArg
class SealedArgs {
  lateinit var iv: String
  lateinit var blob: String
}

@InvokeArg
class KeepAliveArgs {
  var count: Int = 0
  var wakeLock: Boolean = false
}

private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val BIOMETRIC_ALIAS = "bifrossh-biometric"
private const val PIN_ALIAS = "bifrossh-pin"

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

  // ── Background ───────────────────────────────────────────────────────────

  private var askedNotifications = false

  /**
   * Starts, updates or stops SessionService. Called whenever the number of
   * open connections changes; 0 stops it.
   *
   * The first start asks for permission to post notifications (Android 13
   * on). A no does not stop the service: Android still runs it, and lists it
   * in the quick settings' active apps instead of the shade.
   */
  @Command
  fun keepAlive(invoke: Invoke) {
    val args = invoke.parseArgs(KeepAliveArgs::class.java)
    val intent = Intent(activity, SessionService::class.java)
    if (args.count > 0) {
      if (!askedNotifications && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED
      ) {
        askedNotifications = true
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
      }
      val service = SessionService.running
      if (service != null) {
        activity.runOnUiThread { service.update(args.count, args.wakeLock) }
        invoke.resolve()
        return
      }
      intent.putExtra(SessionService.EXTRA_COUNT, args.count)
      intent.putExtra(SessionService.EXTRA_WAKE_LOCK, args.wakeLock)
      try {
        ContextCompat.startForegroundService(activity, intent)
      } catch (e: Exception) {
        // Android refuses a foreground start from the background (12 on).
        // The next change made with the app in front starts it.
        invoke.reject("Could not start the background service: ${e.message}")
        return
      }
    } else {
      activity.stopService(intent)
    }
    invoke.resolve()
  }

  // ── Fingerprint and PIN ─────────────────────────────────────────────────
  //
  // The keys below live in the Android Keystore and never leave its secure
  // hardware. The Rust side keeps what they produce in keystore.json; the
  // rules (passphrase required, five PIN tries) are kept there too.

  /** Whether a fingerprint can be used, and if not, why. */
  @Command
  fun biometricStatus(invoke: Invoke) {
    val reason = when (BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG)) {
      BiometricManager.BIOMETRIC_SUCCESS -> null
      BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "No fingerprint is enrolled in Android's settings."
      BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "This phone has no fingerprint sensor."
      BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "The fingerprint sensor is not available right now."
      BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> "Android needs a security update before the fingerprint sensor can be used."
      else -> "Fingerprint unlock is not supported on this phone."
    }
    val ret = JSObject()
    ret.put("available", reason == null)
    if (reason != null) ret.put("reason", reason)
    invoke.resolve(ret)
  }

  /**
   * Encrypts `data` under a fresh fingerprint-bound key, after a fingerprint.
   * The key is made anew each time, so turning this on again after a
   * fingerprint change starts clean.
   */
  @Command
  fun biometricEncrypt(invoke: Invoke) {
    val args = invoke.parseArgs(DataArgs::class.java)
    val cipher = try {
      deleteKey(BIOMETRIC_ALIAS)
      Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, newBiometricKey()) }
    } catch (e: Exception) {
      invoke.reject("Could not make a fingerprint key: ${e.message}", "failed")
      return
    }
    authenticate(invoke, cipher, "Turn on fingerprint unlock") { c ->
      val blob = c.doFinal(Base64.decode(args.data, Base64.NO_WRAP))
      val ret = JSObject()
      ret.put("iv", Base64.encodeToString(c.iv, Base64.NO_WRAP))
      ret.put("blob", Base64.encodeToString(blob, Base64.NO_WRAP))
      ret
    }
  }

  /** Decrypts what `biometricEncrypt` made, after a fingerprint. */
  @Command
  fun biometricDecrypt(invoke: Invoke) {
    val args = invoke.parseArgs(SealedArgs::class.java)
    val cipher = try {
      val key = keystore().getKey(BIOMETRIC_ALIAS, null) as? SecretKey
      if (key == null) {
        invoke.reject("The fingerprint key is gone", "invalidated")
        return
      }
      Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(args.iv, Base64.NO_WRAP)))
      }
    } catch (e: KeyPermanentlyInvalidatedException) {
      // A fingerprint was added or removed since this was turned on, and
      // Android destroyed the key so the new finger cannot use it.
      deleteKey(BIOMETRIC_ALIAS)
      invoke.reject("Fingerprints changed", "invalidated")
      return
    } catch (e: Exception) {
      invoke.reject("Could not use the fingerprint key: ${e.message}", "failed")
      return
    }
    authenticate(invoke, cipher, "Unlock BifroSSH") { c ->
      val ret = JSObject()
      ret.put("data", Base64.encodeToString(c.doFinal(Base64.decode(args.blob, Base64.NO_WRAP)), Base64.NO_WRAP))
      ret
    }
  }

  @Command
  fun biometricRemove(invoke: Invoke) {
    deleteKey(BIOMETRIC_ALIAS)
    invoke.resolve()
  }

  /**
   * HMAC-SHA256 of `data` under a key that never leaves the phone's secure
   * hardware, made on first use. What a PIN guess has to pass through, so
   * guessing can only happen here.
   */
  @Command
  fun pinMac(invoke: Invoke) {
    val args = invoke.parseArgs(DataArgs::class.java)
    try {
      val key = keystore().getKey(PIN_ALIAS, null) as? SecretKey ?: newPinKey()
      val mac = Mac.getInstance("HmacSHA256").apply { init(key) }
      val ret = JSObject()
      ret.put("mac", Base64.encodeToString(mac.doFinal(Base64.decode(args.data, Base64.NO_WRAP)), Base64.NO_WRAP))
      invoke.resolve(ret)
    } catch (e: Exception) {
      invoke.reject("Could not use the PIN key: ${e.message}", "failed")
    }
  }

  @Command
  fun pinRemove(invoke: Invoke) {
    deleteKey(PIN_ALIAS)
    invoke.resolve()
  }

  private fun keystore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  private fun deleteKey(alias: String) {
    try {
      keystore().deleteEntry(alias)
    } catch (_: Exception) {
    }
  }

  private fun newBiometricKey(): SecretKey {
    val spec = KeyGenParameterSpec.Builder(BIOMETRIC_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
      .apply {
        // Every use needs its own fingerprint, never a recent screen unlock.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        }
      }
      .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
      init(spec)
      generateKey()
    }
  }

  /** In StrongBox where the phone has one, the main secure hardware if not. */
  private fun newPinKey(): SecretKey {
    fun make(strongBox: Boolean): SecretKey {
      val spec = KeyGenParameterSpec.Builder(PIN_ALIAS, KeyProperties.PURPOSE_SIGN)
        .setDigests(KeyProperties.DIGEST_SHA256)
        .apply { if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true) }
        .build()
      return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE).run {
        init(spec)
        generateKey()
      }
    }
    return try {
      make(true)
    } catch (_: StrongBoxUnavailableException) {
      make(false)
    }
  }

  /**
   * Shows the system fingerprint prompt for `cipher` and, once a finger
   * unlocks it, resolves `invoke` with what `use` makes of it. Cancelling
   * rejects with "cancelled", too many failed fingers with "lockout".
   */
  private fun authenticate(invoke: Invoke, cipher: Cipher, title: String, use: (Cipher) -> JSObject) {
    val host = activity as FragmentActivity
    host.runOnUiThread {
      val callback = object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          val unlocked = result.cryptoObject?.cipher
          if (unlocked == null) {
            invoke.reject("The fingerprint did not unlock the key", "failed")
            return
          }
          try {
            invoke.resolve(use(unlocked))
          } catch (e: Exception) {
            invoke.reject("Could not use the fingerprint key: ${e.message}", "failed")
          }
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          val code = when (errorCode) {
            BiometricPrompt.ERROR_USER_CANCELED,
            BiometricPrompt.ERROR_NEGATIVE_BUTTON,
            BiometricPrompt.ERROR_CANCELED -> "cancelled"
            BiometricPrompt.ERROR_LOCKOUT,
            BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "lockout"
            else -> "failed"
          }
          invoke.reject(errString.toString(), code)
        }
        // onAuthenticationFailed is one finger not recognised; the prompt
        // stays up for another try, so there is nothing to answer yet.
      }
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title)
        .setNegativeButtonText("Cancel")
        .setAllowedAuthenticators(BIOMETRIC_STRONG)
        .build()
      BiometricPrompt(host, ContextCompat.getMainExecutor(activity), callback)
        .authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
  }
}
