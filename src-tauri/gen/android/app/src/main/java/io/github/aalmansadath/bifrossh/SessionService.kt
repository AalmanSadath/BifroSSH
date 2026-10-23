package io.github.aalmansadath.bifrossh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

private const val CHANNEL = "connections"
private const val NOTIFICATION_ID = 1

/**
 * Keeps the process, and with it every SSH connection, alive while the app
 * is out of sight. Without it Android freezes the process soon after the
 * Activity stops, and the servers drop the connections when keepalives stop
 * arriving.
 *
 * Started by AndroidPlugin.keepAlive while anything is connected, stopped
 * when nothing is. It does no work of its own: being a foreground service,
 * with its notification, is what keeps the process running.
 */
class SessionService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val count = intent?.getIntExtra(EXTRA_COUNT, 1) ?: 1
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
    } else {
      0
    }
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(count), type)
    holdWakeLock(intent?.getBooleanExtra(EXTRA_WAKE_LOCK, false) ?: false)
    // Not restarted after the process dies: the connections died with it.
    return START_NOT_STICKY
  }

  /**
   * A new count or wake lock choice for the running service. Applied here
   * rather than by starting it again, which Android refuses from the
   * background, where a tunnel coming back on its own may well be.
   */
  fun update(count: Int, wakeLock: Boolean) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIFICATION_ID, notification(count))
    holdWakeLock(wakeLock)
  }

  /**
   * Swiped out of Recents. That is the user quitting, so the connections
   * go with the Activity rather than living on in a process with no screen.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    android.os.Process.killProcess(android.os.Process.myPid())
  }

  override fun onDestroy() {
    if (running === this) running = null
    holdWakeLock(false)
    super.onDestroy()
  }

  /**
   * A partial wake lock keeps the CPU running with the screen off, so Doze
   * does not stall the connections. Only on the user's say-so: it costs
   * battery for as long as anything is connected.
   */
  private fun holdWakeLock(on: Boolean) {
    if (on && wakeLock == null) {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BifroSSH:connections").apply {
        setReferenceCounted(false)
        acquire()
      }
    } else if (!on) {
      wakeLock?.release()
      wakeLock = null
    }
  }

  private fun notification(count: Int): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Open connections", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while BifroSSH keeps connections open in the background"
          setShowBadge(false)
        }
      )
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      flags
    )
    val disconnect = PendingIntent.getActivity(
      this, 1,
      Intent(this, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(MainActivity.EXTRA_DISCONNECT_ALL, true),
      flags
    )
    val text = if (count == 1) "1 connection open" else "$count connections open"
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.ic_notification)
      .setContentTitle("BifroSSH")
      .setContentText(text)
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(0, "Disconnect all", disconnect)
      .build()
  }

  companion object {
    const val EXTRA_COUNT = "count"
    const val EXTRA_WAKE_LOCK = "wakeLock"

    /** The service while it runs. Set on the main thread, read from the plugin's. */
    @Volatile
    var running: SessionService? = null
  }
}
