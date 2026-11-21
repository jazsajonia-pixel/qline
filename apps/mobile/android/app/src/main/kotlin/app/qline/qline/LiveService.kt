package app.qline.qline

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

/**
 * v1.12 (docs/30): keeps a live conversation going while Qline is in the background or the screen is off.
 * A foreground service of type microphone + mediaPlayback, with an ongoing notification and an End button.
 * It only exists while a live session is on; ending the session (in the app or from the notification) stops it.
 * If Android kills the process anyway, the session ends; Qline does not claim to survive that.
 */
class LiveService : Service() {
    companion object {
        private const val CHANNEL = "qline_live"
        private const val ID = 7201
        const val ACTION_END = "app.qline.qline.LIVE_END"

        fun start(c: Context) {
            try {
                val i = Intent(c, LiveService::class.java)
                if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i) else c.startService(i)
            } catch (_: Exception) {
                // Not allowed right now (for example started from the background): the session still runs while Qline is open.
            }
        }

        fun stop(c: Context) {
            try {
                c.stopService(Intent(c, LiveService::class.java))
            } catch (_: Exception) {}
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_END) {
            LiveAudio.emit(mapOf("type" to "end", "from" to "notification"))
            stopSelf()
            return START_NOT_STICKY
        }
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Live conversation", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while a live voice conversation with Qline is on."
                setShowBadge(false)
            })
        }
        val open = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val end = PendingIntent.getService(this, 1, Intent(this, LiveService::class.java).setAction(ACTION_END), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
        val n = b.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Qline is listening")
            .setContentText("Live conversation is on. Tap to open.")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "End", end).build())
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            } else {
                startForeground(ID, n)
            }
        } catch (_: Exception) {
            // Android refused the microphone type (permission revoked, or started from the background).
            try {
                if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) else startForeground(ID, n)
            } catch (_: Exception) {
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }
}
