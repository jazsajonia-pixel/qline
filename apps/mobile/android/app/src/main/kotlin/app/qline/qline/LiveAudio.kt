package app.qline.qline

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.io.OutputStream
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * v1.12 live conversation audio engine (docs/30), over "qline/live_audio" (+ "/events").
 *
 * One microphone stream feeds everything: AudioRecord with the VOICE_COMMUNICATION source and the platform
 * echo canceller and noise suppressor, so the phone's own voice is removed before Dart sees it. Frames
 * (512 samples, 16 kHz, PCM16) go to Dart for voice activity detection and barge-in. While the user talks,
 * the same frames (plus the pre-roll Dart keeps) are written into Android's speech recogniser through
 * EXTRA_AUDIO_SOURCE (API 33+), so nothing the user said before detection is lost and the recogniser never
 * opens a second microphone. Phones without it fall back to the recogniser's own microphone ("legacy").
 *
 * Playback is a streaming AudioTrack: ordered PCM chunks are written in 20 ms slices, so flush() stops the
 * voice within one slice, drops everything queued and reports how much of the current chunk was heard.
 */
object LiveAudio {
    private const val CHANNEL = "qline/live_audio"
    private const val EVENTS = "qline/live_audio/events"
    const val RATE = 16000
    const val FRAME = 512

    private var activity: Activity? = null
    private var sink: EventChannel.EventSink? = null
    private val main = Handler(Looper.getMainLooper())

    // ---- microphone -------------------------------------------------------------------------------------
    @Volatile private var recording = false
    private var record: AudioRecord? = null
    private var aec: AcousticEchoCanceler? = null
    private var ns: NoiseSuppressor? = null
    @Volatile private var pipe: OutputStream? = null
    private var micThread: Thread? = null

    // ---- recogniser -------------------------------------------------------------------------------------
    private var recognizer: SpeechRecognizer? = null
    private var legacyListening = false

    // ---- playback ---------------------------------------------------------------------------------------
    private class Chunk(val seq: Int, val pcm: ShortArray, val rate: Int, val gen: Int)
    private val queue = LinkedBlockingQueue<Chunk>()
    private val gen = AtomicInteger(0)
    private var track: AudioTrack? = null
    private var trackRate = 0
    private var playThread: Thread? = null
    @Volatile private var playing = false
    @Volatile private var currentSeq = -1
    @Volatile private var currentFrames = 0
    @Volatile private var currentRate = 0
    @Volatile private var currentStartHead = 0L
    @Volatile private var writtenFrames = 0L
    @Volatile private var communication = false

    // ---- session ----------------------------------------------------------------------------------------
    private var focus: AudioFocusRequest? = null
    private var active = false

    fun attach(a: Activity, messenger: BinaryMessenger) {
        activity = a
        EventChannel(messenger, EVENTS).setStreamHandler(object : EventChannel.StreamHandler {
            override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                sink = events
            }
            override fun onCancel(arguments: Any?) {
                sink = null
            }
        })
        MethodChannel(messenger, CHANNEL).setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "capabilities" -> result.success(capabilities(a))
                    "start" -> result.success(start(a, call.argument<Boolean>("aec") ?: true, call.argument<Boolean>("service") ?: true))
                    "stop" -> {
                        stop(a)
                        result.success(null)
                    }
                    "play" -> {
                        val bytes = call.argument<ByteArray>("pcm")!!
                        val shorts = ShortArray(bytes.size / 2)
                        java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
                        queue.put(Chunk(call.argument<Int>("seq")!!, shorts, call.argument<Int>("rate")!!, gen.get()))
                        result.success(null)
                    }
                    "flush" -> result.success(flush())
                    "listen" -> result.success(listen(a, call.argument<String>("locale"), call.argument<ByteArray>("preRoll"), call.argument<Boolean>("inject") ?: true))
                    "endListen" -> {
                        endListen()
                        result.success(null)
                    }
                    "cancelListen" -> {
                        cancelListen()
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) {
                result.error("LIVE_AUDIO", e.message ?: e.javaClass.simpleName, null)
            }
        }
    }

    fun detach(a: Activity) {
        if (activity === a) {
            stop(a)
            activity = null
        }
    }

    internal fun emit(event: Map<String, Any?>) {
        main.post { sink?.success(event) }
    }

    private fun capabilities(a: Activity): Map<String, Any> = mapOf(
        "aec" to AcousticEchoCanceler.isAvailable(),
        "ns" to NoiseSuppressor.isAvailable(),
        "inject" to (Build.VERSION.SDK_INT >= 33),
        "recognizer" to SpeechRecognizer.isRecognitionAvailable(a),
        "sdk" to Build.VERSION.SDK_INT,
        "model" to "${Build.MANUFACTURER} ${Build.MODEL}",
    )

    // ---- session ----------------------------------------------------------------------------------------
    @SuppressLint("MissingPermission")
    private fun start(a: Activity, useAec: Boolean, service: Boolean): Map<String, Any> {
        if (a.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            return mapOf("ok" to false, "error" to "microphone")
        }
        if (active) stop(a)
        active = true
        communication = useAec
        val am = a.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (useAec) {
            // Communication mode turns on the phone's echo path; the voice is routed to the loudspeaker
            // (not the earpiece) unless a headset is connected.
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            routeToSpeaker(am)
            a.volumeControlStream = AudioManager.STREAM_VOICE_CALL
        }
        requestFocus(am)
        startMic(useAec)
        if (service) LiveService.start(a)
        return mapOf(
            "ok" to (record != null),
            "aec" to (aec?.enabled == true),
            "ns" to (ns?.enabled == true),
            "inject" to (Build.VERSION.SDK_INT >= 33),
            "rate" to RATE,
        )
    }

    private fun stop(a: Activity) {
        cancelListen()
        flush()
        stopMic()
        playing = false
        track?.release()
        track = null
        trackRate = 0
        if (active) {
            val am = a.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            focus?.let { am.abandonAudioFocusRequest(it) }
            focus = null
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice() else @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = false }
            am.mode = AudioManager.MODE_NORMAL
            a.volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE
            LiveService.stop(a)
        }
        active = false
        communication = false
    }

    private fun routeToSpeaker(am: AudioManager) {
        val headset = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
            it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
                (Build.VERSION.SDK_INT >= 31 && it.type == AudioDeviceInfo.TYPE_BLE_HEADSET)
        }
        if (headset) return
        if (Build.VERSION.SDK_INT >= 31) {
            am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { am.setCommunicationDevice(it) }
        } else {
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = true
        }
    }

    private fun requestFocus(am: AudioManager) {
        val attrs = AudioAttributes.Builder()
            .setUsage(if (communication) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_ASSISTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attrs)
            .setOnAudioFocusChangeListener { change ->
                val state = when (change) {
                    AudioManager.AUDIOFOCUS_GAIN -> "gain"
                    AudioManager.AUDIOFOCUS_LOSS -> "loss"
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "transient"
                    else -> "other"
                }
                emit(mapOf("type" to "focus", "state" to state))
            }
            .build()
        focus = req
        am.requestAudioFocus(req)
    }

    // ---- microphone -------------------------------------------------------------------------------------
    @SuppressLint("MissingPermission")
    private fun startMic(useAec: Boolean) {
        if (recording) return
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val source = if (useAec) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION
        val r = try {
            AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, FRAME * 2 * 8))
        } catch (e: Exception) {
            emit(mapOf("type" to "error", "where" to "mic", "message" to (e.message ?: "mic")))
            return
        }
        if (r.state != AudioRecord.STATE_INITIALIZED) {
            r.release()
            emit(mapOf("type" to "error", "where" to "mic", "message" to "The microphone is in use by another app."))
            return
        }
        if (useAec && AcousticEchoCanceler.isAvailable()) aec = AcousticEchoCanceler.create(r.audioSessionId)?.apply { enabled = true }
        if (NoiseSuppressor.isAvailable()) ns = NoiseSuppressor.create(r.audioSessionId)?.apply { enabled = true }
        record = r
        recording = true
        r.startRecording()
        micThread = thread(name = "qline-mic", priority = Thread.MAX_PRIORITY) {
            val buf = ShortArray(FRAME)
            val bytes = ByteArray(FRAME * 2)
            while (recording) {
                var got = 0
                while (got < FRAME && recording) {
                    val n = r.read(buf, got, FRAME - got)
                    if (n <= 0) break
                    got += n
                }
                if (got < FRAME) continue
                for (i in 0 until FRAME) {
                    bytes[i * 2] = (buf[i].toInt() and 0xff).toByte()
                    bytes[i * 2 + 1] = (buf[i].toInt() shr 8 and 0xff).toByte()
                }
                pipe?.let {
                    try {
                        it.write(bytes)
                    } catch (_: Exception) {
                        pipe = null
                    }
                }
                emit(mapOf("type" to "mic", "pcm" to bytes.copyOf()))
            }
        }
    }

    private fun stopMic() {
        recording = false
        micThread?.join(300)
        micThread = null
        try {
            record?.stop()
        } catch (_: Exception) {}
        record?.release()
        record = null
        aec?.release()
        aec = null
        ns?.release()
        ns = null
    }

    // ---- recogniser -------------------------------------------------------------------------------------
    private fun listen(a: Activity, locale: String?, preRoll: ByteArray?, inject: Boolean): Map<String, Any> {
        cancelListen()
        if (!SpeechRecognizer.isRecognitionAvailable(a)) return mapOf("ok" to false, "error" to "recognizer")
        val useInject = inject && Build.VERSION.SDK_INT >= 33 && recording
        val sr = SpeechRecognizer.createSpeechRecognizer(a)
        recognizer = sr
        sr.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = emit(mapOf("type" to "rready"))
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {
                if (legacyListening) emit(mapOf("type" to "rlevel", "db" to rmsdB.toDouble()))
            }
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) {
                emit(mapOf("type" to "rerror", "code" to error))
                finishListen()
            }
            override fun onResults(results: Bundle?) {
                emit(results(results, "final"))
                finishListen()
            }
            override fun onPartialResults(partialResults: Bundle?) = emit(results(partialResults, "partial"))
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 4)
            if (!locale.isNullOrBlank()) putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
            // Qline decides when the turn ends (voice activity + the words so far); the recogniser should not stop early.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 6000)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 6000)
        }
        if (useInject) {
            val fds = ParcelFileDescriptor.createPipe()
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, fds[0])
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
            intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, RATE)
            val out = ParcelFileDescriptor.AutoCloseOutputStream(fds[1])
            if (preRoll != null && preRoll.isNotEmpty()) {
                try {
                    out.write(preRoll)
                } catch (_: Exception) {}
            }
            pipe = out
            sr.startListening(intent)
            fds[0].close()
        } else {
            // Legacy: the recogniser needs the microphone itself.
            legacyListening = true
            stopMic()
            sr.startListening(intent)
        }
        return mapOf("ok" to true, "inject" to useInject)
    }

    private fun results(b: Bundle?, type: String): Map<String, Any?> {
        val texts = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION) ?: arrayListOf()
        val conf = b?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)
        return mapOf("type" to type, "texts" to texts, "confidence" to conf?.firstOrNull()?.toDouble())
    }

    /** The turn is over: closing the pipe tells the recogniser the audio ended, so it returns its final result. */
    private fun endListen() {
        val p = pipe
        pipe = null
        try {
            p?.close()
        } catch (_: Exception) {}
        if (legacyListening) recognizer?.stopListening()
    }

    private fun finishListen() {
        val p = pipe
        pipe = null
        try {
            p?.close()
        } catch (_: Exception) {}
        main.post {
            recognizer?.destroy()
            recognizer = null
            if (legacyListening) {
                legacyListening = false
                if (active) startMic(communication)
            }
            emit(mapOf("type" to "rend"))
        }
    }

    private fun cancelListen() {
        val p = pipe
        pipe = null
        try {
            p?.close()
        } catch (_: Exception) {}
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null
        if (legacyListening) {
            legacyListening = false
            if (active) startMic(communication)
        }
    }

    // ---- playback ---------------------------------------------------------------------------------------
    private fun ensureTrack(rate: Int): AudioTrack {
        val t = track
        if (t != null && trackRate == rate) return t
        t?.release()
        val attrs = AudioAttributes.Builder()
            .setUsage(if (communication) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_ASSISTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        val min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val n = AudioTrack.Builder()
            .setAudioAttributes(attrs)
            .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(maxOf(min, rate / 5 * 2))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track = n
        trackRate = rate
        writtenFrames = 0
        return n
    }

    init {
        startPlayer()
    }

    private fun startPlayer() {
        playThread = thread(name = "qline-voice", isDaemon = true, priority = Thread.MAX_PRIORITY) {
            while (true) {
                val c = try {
                    queue.take()
                } catch (_: InterruptedException) {
                    break
                }
                if (c.gen != gen.get()) continue
                try {
                    play(c)
                } catch (_: InterruptedException) {
                    break
                } catch (_: Exception) {
                    // The track was flushed or released under us (barge-in): the chunk is dropped on purpose.
                }
            }
        }
    }

    private fun play(c: Chunk) {
        val t = synchronized(this) { ensureTrack(c.rate) }
        if (t.playState != AudioTrack.PLAYSTATE_PLAYING) t.play()
        currentSeq = c.seq
        currentFrames = c.pcm.size
        currentRate = c.rate
        currentStartHead = writtenFrames
        playing = true
        emit(mapOf("type" to "started", "seq" to c.seq))
        val slice = c.rate / 50 // 20 ms
        var off = 0
        while (off < c.pcm.size && c.gen == gen.get()) {
            val n = minOf(slice, c.pcm.size - off)
            val w = t.write(c.pcm, off, n, AudioTrack.WRITE_BLOCKING)
            if (w <= 0) break
            off += w
            writtenFrames += w
        }
        if (c.gen != gen.get()) return
        if (queue.isEmpty()) {
            // Wait until the last chunk is actually heard, then say so (drained = the voice went quiet).
            val end = writtenFrames
            while (c.gen == gen.get() && (t.playbackHeadPosition.toLong() and 0xffffffffL) < end && queue.isEmpty()) Thread.sleep(10)
            if (c.gen == gen.get()) {
                emit(mapOf("type" to "ended", "seq" to c.seq))
                if (queue.isEmpty()) {
                    playing = false
                    emit(mapOf("type" to "drained", "seq" to c.seq))
                }
            }
        } else {
            emit(mapOf("type" to "ended", "seq" to c.seq))
        }
    }

    /** Stops the voice now and drops everything queued. Returns the chunk that was playing and how much of it was heard. */
    private fun flush(): Map<String, Any> {
        gen.incrementAndGet()
        queue.clear()
        val t = track
        var heardMs = 0
        val seq = currentSeq
        if (t != null && playing) {
            val head = t.playbackHeadPosition.toLong() and 0xffffffffL
            val into = (head - currentStartHead).coerceIn(0, currentFrames.toLong())
            if (currentRate > 0) heardMs = (into * 1000 / currentRate).toInt()
        }
        synchronized(this) {
            try {
                t?.pause()
                t?.flush()
            } catch (_: Exception) {}
            // A fresh track resets the playback position the next chunk is measured from.
            t?.release()
            track = null
            trackRate = 0
        }
        val was = playing
        playing = false
        currentSeq = -1
        return mapOf("seq" to seq, "heardMs" to heardMs, "wasPlaying" to was)
    }
}
