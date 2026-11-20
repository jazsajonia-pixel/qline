package app.qline.qline

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * v1.11 (docs/28): in-app updates over the channel "qline/updater".
 *
 * Dart downloads the APK from the GitHub release and checks its SHA-256 against the release. Here the APK is
 * checked again before Android sees it: same SHA-256, same package, newer version code and the same signing
 * certificate as the installed app. It is then handed to Android's PackageInstaller. Android always asks the
 * person to confirm; Qline never installs silently. When the new version is installed, [UpdatedReceiver]
 * reopens Qline, or posts "Qline updated, tap to open" when Android does not allow apps to open themselves.
 */
object Updater {
    const val CHANNEL = "qline/updater"
    const val ACTION_STATUS = "app.qline.qline.UPDATE_STATUS"
    private var channel: MethodChannel? = null
    private var activity: Activity? = null

    fun attach(a: Activity, messenger: BinaryMessenger) {
        activity = a
        channel = MethodChannel(messenger, CHANNEL).also { ch ->
            ch.setMethodCallHandler { call, result ->
                try {
                    when (call.method) {
                        "updateDir" -> result.success(File(a.cacheDir, "updates").apply { mkdirs() }.absolutePath)
                        "installedVersion" -> {
                            val p = info(a)
                            result.success(mapOf("name" to (p.versionName ?: ""), "code" to code(p)))
                        }
                        "canInstall" -> result.success(Build.VERSION.SDK_INT < 26 || a.packageManager.canRequestPackageInstalls())
                        "openInstallSettings" -> {
                            if (Build.VERSION.SDK_INT >= 26) {
                                a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${a.packageName}")))
                            }
                            result.success(null)
                        }
                        "install" -> result.success(install(a, call.argument<String>("path")!!, call.argument<String>("sha256")!!))
                        "dismissNotice" -> {
                            (a.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(7101)
                            result.success(null)
                        }
                        "clear" -> {
                            File(a.cacheDir, "updates").listFiles()?.forEach { it.delete() }
                            result.success(null)
                        }
                        else -> result.notImplemented()
                    }
                } catch (e: Exception) {
                    result.error("UPDATE_FAILED", e.message ?: "Update failed", null)
                }
            }
        }
    }

    fun detach(a: Activity) {
        if (activity === a) {
            channel?.setMethodCallHandler(null)
            channel = null
            activity = null
        }
    }

    /** Tells Dart how the install went ("failed", "cancelled", …). The app process ends on success. */
    fun report(status: String, message: String?) {
        activity?.runOnUiThread { channel?.invokeMethod("status", mapOf("status" to status, "message" to message)) }
    }

    private fun info(c: Context): PackageInfo = if (Build.VERSION.SDK_INT >= 33) {
        c.packageManager.getPackageInfo(c.packageName, PackageManager.PackageInfoFlags.of(0))
    } else {
        @Suppress("DEPRECATION") c.packageManager.getPackageInfo(c.packageName, 0)
    }

    private fun code(p: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else @Suppress("DEPRECATION") p.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun signers(c: Context, archive: String?): Set<String> {
        val pm = c.packageManager
        val sha = MessageDigest.getInstance("SHA-256")
        return if (Build.VERSION.SDK_INT >= 28) {
            val p = if (archive != null) pm.getPackageArchiveInfo(archive, PackageManager.GET_SIGNING_CERTIFICATES) else pm.getPackageInfo(c.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            val s = p?.signingInfo ?: return emptySet()
            val list = if (s.hasMultipleSigners()) s.apkContentsSigners else s.signingCertificateHistory
            list.map { hex(sha.digest(it.toByteArray())) }.toSet()
        } else {
            val p = if (archive != null) pm.getPackageArchiveInfo(archive, PackageManager.GET_SIGNATURES) else pm.getPackageInfo(c.packageName, PackageManager.GET_SIGNATURES)
            p?.signatures?.map { hex(sha.digest(it.toByteArray())) }?.toSet() ?: emptySet()
        }
    }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    private fun fileSha(f: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(f).use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return hex(md.digest())
    }

    /** Returns "pending" when Android is about to ask the person, or "error:<plain message>". */
    private fun install(a: Activity, path: String, expectedSha: String): String {
        val f = File(path)
        val dir = File(a.cacheDir, "updates").canonicalFile
        if (!f.exists() || f.canonicalFile.parentFile != dir) return "error:The download is missing. Try again."
        if (fileSha(f) != expectedSha.lowercase()) {
            f.delete()
            return "error:The download did not match the release checksum, so it was deleted. Try again."
        }
        val pm = a.packageManager
        val archive = (if (Build.VERSION.SDK_INT >= 33) pm.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(0)) else @Suppress("DEPRECATION") pm.getPackageArchiveInfo(path, 0))
            ?: return "error:The download is not a valid app file."
        if (archive.packageName != a.packageName) return "error:The download is not Qline."
        if (code(archive) <= code(info(a))) return "error:This version is not newer than the one you have."
        val mine = signers(a, null)
        val theirs = signers(a, path)
        if (mine.isEmpty() || theirs.isEmpty() || mine.intersect(theirs).isEmpty()) {
            return "error:This update is not signed by Qline's key. Install it from the GitHub release page instead."
        }
        if (Build.VERSION.SDK_INT >= 26 && !pm.canRequestPackageInstalls()) return "error:permission"

        val installer = pm.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(a.packageName)
            setSize(f.length())
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { s ->
            s.openWrite("qline.apk", 0, f.length()).use { out ->
                FileInputStream(f).use { it.copyTo(out) }
                s.fsync(out)
            }
            val intent = Intent(a, UpdateStatusReceiver::class.java).setAction(ACTION_STATUS)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            s.commit(PendingIntent.getBroadcast(a, id, intent, flags).intentSender)
        }
        return "pending"
    }

    fun notifyUpdated(c: Context) {
        val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel("qline_updates", "Qline updates", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "When a Qline update has been installed" })
        }
        val open = c.packageManager.getLaunchIntentForPackage(c.packageName)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) ?: return
        val pi = PendingIntent.getActivity(c, 7101, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val version = try { info(c).versionName } catch (_: Exception) { null }
        val b = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(c, "qline_updates") else @Suppress("DEPRECATION") android.app.Notification.Builder(c)
        val n = b.setSmallIcon(R.mipmap.ic_launcher_monochrome)
            .setContentTitle(if (version != null) "Qline updated to $version" else "Qline updated")
            .setContentText("Tap to open Qline.")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        try { nm.notify(7101, n) } catch (_: SecurityException) { /* notifications are off */ }
    }
}

/** Results from PackageInstaller: asks the person to confirm, or reports a failure back to the app. */
class UpdateStatusReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT))
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        c.startActivity(confirm)
                        Updater.report("confirming", null)
                    } catch (e: Exception) {
                        Updater.report("failed", "Android did not show the install screen. Try again.")
                    }
                }
            }
            PackageInstaller.STATUS_SUCCESS -> Updater.report("installed", null)
            PackageInstaller.STATUS_FAILURE_ABORTED -> Updater.report("cancelled", null)
            else -> Updater.report(
                "failed",
                when (status) {
                    PackageInstaller.STATUS_FAILURE_STORAGE -> "Not enough storage to install the update."
                    PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "Android could not install this update over the current app."
                    PackageInstaller.STATUS_FAILURE_BLOCKED -> "Android or a security setting blocked the update."
                    else -> intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "The update was not installed."
                },
            )
        }
    }
}

/** After Qline replaces itself: try to reopen it, and leave a "tap to open" notification in case Android blocks that. */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        File(c.cacheDir, "updates").listFiles()?.forEach { it.delete() }
        Updater.notifyUpdated(c)
        try {
            c.packageManager.getLaunchIntentForPackage(c.packageName)?.let {
                it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                c.startActivity(it)
            }
        } catch (_: Exception) {
            // Background activity starts are often blocked (Android 10+); the notification remains.
        }
    }
}
