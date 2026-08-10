package com.protalent.waagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class AgentPollService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val running = AtomicBoolean(false)
    private val busy = AtomicBoolean(false)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification("Agente activo"))
        if (running.compareAndSet(false, true)) {
            executor.execute { pollLoop() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        WhatsAppAccessibilityService.cancel()
        super.onDestroy()
    }

    private fun pollLoop() {
        while (running.get()) {
            try {
                val base = Prefs.serverUrl(this)
                val token = Prefs.token(this)
                var deviceId = Prefs.deviceId(this)
                if (base.isBlank() || token.isBlank()) {
                    Thread.sleep(5_000)
                    continue
                }
                val api = ApiClient(base, token)
                if (deviceId.isBlank()) {
                    val reg = api.register(Prefs.label(this), Prefs.sessionId(this).ifBlank { null }, null)
                    deviceId = reg.getJSONObject("device").getString("id")
                    Prefs.setDeviceId(this, deviceId)
                } else {
                    try {
                        api.heartbeat(deviceId)
                    } catch (_: Exception) {
                        val reg = api.register(
                            Prefs.label(this),
                            Prefs.sessionId(this).ifBlank { null },
                            deviceId
                        )
                        deviceId = reg.getJSONObject("device").getString("id")
                        Prefs.setDeviceId(this, deviceId)
                    }
                }

                if (!busy.get()) {
                    val job = api.nextJob(deviceId)
                    if (job != null) {
                        busy.set(true)
                        updateNotification("Enviando a ${job.telefono}")
                        executeJob(api, deviceId, job)
                        busy.set(false)
                        updateNotification("Agente activo")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "poll error", e)
            }
            Thread.sleep(4_000)
        }
        stopSelf()
    }

    private fun executeJob(api: ApiClient, deviceId: String, job: AgentJob) {
        val phone = job.telefono.replace(Regex("[^0-9]"), "")
        if (phone.isBlank() || job.mensaje.isBlank()) {
            api.reportResult(job.id, deviceId, false, "invalid_payload")
            return
        }

        val latchOk = AtomicBoolean(false)
        val latchDone = AtomicBoolean(false)
        var err: String? = null

        main.post {
            WhatsAppAccessibilityService.armForSend(25_000L) { ok, error ->
                latchOk.set(ok)
                err = error
                latchDone.set(true)
            }
            openWhatsApp(phone, job.mensaje)
        }

        val deadline = System.currentTimeMillis() + 30_000L
        while (!latchDone.get() && System.currentTimeMillis() < deadline) {
            Thread.sleep(200)
        }
        if (!latchDone.get()) {
            WhatsAppAccessibilityService.cancel()
            api.reportResult(job.id, deviceId, false, "timeout")
            return
        }
        api.reportResult(job.id, deviceId, latchOk.get(), err)
    }

    private fun openWhatsApp(phone: String, text: String) {
        val encoded = URLEncoder.encode(text, "UTF-8")
        val uri = Uri.parse("https://api.whatsapp.com/send?phone=$phone&text=$encoded")
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            setPackage(resolveWhatsAppPackage())
        }
        startActivity(intent)
    }

    private fun resolveWhatsAppPackage(): String {
        val pm = packageManager
        return when {
            pm.getLaunchIntentForPackage("com.whatsapp") != null -> "com.whatsapp"
            pm.getLaunchIntentForPackage("com.whatsapp.w4b") != null -> "com.whatsapp.w4b"
            else -> "com.whatsapp"
        }
    }

    private fun buildNotification(text: String): Notification {
        val channelId = "wa_agent"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(channelId, "WA Agent", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val pending = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("WA Agent")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification(text))
    }

    companion object {
        private const val TAG = "AgentPollService"
        private const val NOTIF_ID = 42
    }
}
