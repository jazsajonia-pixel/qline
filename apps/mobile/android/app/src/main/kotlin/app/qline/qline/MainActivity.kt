package app.qline.qline

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // v1.11 (docs/28): in-app updates. Checks and installs a downloaded Qline APK.
        Updater.attach(this, flutterEngine.dartExecutor.binaryMessenger)
        // v1.12 (docs/30): live conversation audio (echo-cancelled microphone, recogniser, streaming voice).
        LiveAudio.attach(this, flutterEngine.dartExecutor.binaryMessenger)
    }

    override fun onDestroy() {
        Updater.detach(this)
        LiveAudio.detach(this)
        super.onDestroy()
    }
}
