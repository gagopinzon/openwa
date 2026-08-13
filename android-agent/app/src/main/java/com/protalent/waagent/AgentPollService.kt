package com.protalent.waagent

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
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
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIF_ID, buildNotification("Agente activo"))
        if (running.compareAndSet(false, true)) {
            acquireWakeLock()
            executor.execute { pollLoop() }
            scheduleKeepAlive(this)
        }
        return START_STICKY
    }

    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (wakeLock == null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WaAgent::WakeLock")
            }
            if (wakeLock?.isHeld == false) {
                wakeLock?.acquire()
            }
        } catch (e: Exception) {
            Log.e(TAG, "WakeLock error", e)
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Reiniciar el servicio si el usuario lo cierra desde "Recientes"
        val restartServiceIntent = Intent(applicationContext, this.javaClass)
        restartServiceIntent.setPackage(packageName)
        val restartServicePendingIntent = PendingIntent.getService(
            applicationContext, 1, restartServiceIntent,
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
        )
        val alarmService = applicationContext.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
        alarmService.set(
            android.app.AlarmManager.RTC_WAKEUP,
            System.currentTimeMillis() + 1000,
            restartServicePendingIntent
        )
        super.onTaskRemoved(rootIntent)
    }

    private fun scheduleKeepAlive(context: Context) {
        val alarmIntent = Intent(context, BootReceiver::class.java).apply {
            action = "com.protalent.waagent.KEEP_ALIVE"
        }
        val pendingIntent = PendingIntent.getBroadcast(
            context, 0, alarmIntent, PendingIntent.FLAG_IMMUTABLE
        )
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setExactAndAllowWhileIdle(
                android.app.AlarmManager.RTC_WAKEUP,
                System.currentTimeMillis() + 5 * 60 * 1000,
                pendingIntent
            )
        } else {
            alarmManager.setExact(
                android.app.AlarmManager.RTC_WAKEUP,
                System.currentTimeMillis() + 5 * 60 * 1000,
                pendingIntent
            )
        }
    }

    override fun onDestroy() {
        running.set(false)
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        WhatsAppAccessibilityService.cancel()
        super.onDestroy()
    }

    private fun getBatteryLevel(): Int {
        val intent = registerReceiver(null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1) ?: -1
        return if (level >= 0 && scale > 0) (level * 100 / scale) else -1
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
                val battery = getBatteryLevel()

                if (deviceId.isBlank()) {
                    val reg = api.register(Prefs.label(this), Prefs.sessionId(this).ifBlank { null }, null, battery)
                    deviceId = reg.getJSONObject("device").getString("id")
                    Prefs.setDeviceId(this, deviceId)
                } else {
                    try {
                        api.heartbeat(deviceId, battery)
                    } catch (_: Exception) {
                        val reg = api.register(
                            Prefs.label(this),
                            Prefs.sessionId(this).ifBlank { null },
                            deviceId,
                            battery
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

    private fun wakeUpScreen() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isInteractive) {
            val wl = pm.newWakeLock(
                PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
                "WAAgent:WakeUp"
            )
            wl.acquire(3000) // Mantener encendida por 3 segundos para que cargue la UI
        }
    }

    private fun executeJob(api: ApiClient, deviceId: String, job: AgentJob) {
        val phone = job.telefono.replace(Regex("[^0-9]"), "")
        if (phone.isBlank() || job.mensaje.isBlank()) {
            api.reportResult(job.id, deviceId, false, "invalid_payload")
            return
        }

        // Despertar la pantalla antes de empezar
        wakeUpScreen()

        val latchOk = AtomicBoolean(false)
        val latchDone = AtomicBoolean(false)
        var err: String? = null

        main.post {
            if (!WhatsAppAccessibilityService.isServiceConnected()) {
                latchOk.set(false)
                err = "accessibility_not_enabled"
                latchDone.set(true)
                return@post
            }

            val preferred = Prefs.preferredPackage(this@AgentPollService)
            val fallback = if (preferred == "com.whatsapp") "com.whatsapp.w4b" else "com.whatsapp"

            // Intentamos con la versión preferida
            tryWhatsApp(phone, job.mensaje, preferred) { ok, error ->
                if (ok) {
                    latchOk.set(true)
                    latchDone.set(true)
                } else {
                    // Si falla la preferida, intentamos con la otra
                    Log.i(TAG, "Preferred WhatsApp ($preferred) failed or timeout ($error), trying fallback ($fallback)...")
                    tryWhatsApp(phone, job.mensaje, fallback) { ok2, error2 ->
                        latchOk.set(ok2)
                        err = error2
                        latchDone.set(true)
                    }
                }
            }
        }

        val deadline = System.currentTimeMillis() + 90_000L // Tiempo total para ambos intentos
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

    private fun tryWhatsApp(phone: String, text: String, packageName: String, onFinish: (Boolean, String?) -> Unit) {
        val pm = packageManager
        val intent = pm.getLaunchIntentForPackage(packageName)
        if (intent == null) {
            onFinish(false, "package_not_installed")
            return
        }

        Log.i(TAG, "Attempting to open WhatsApp package: $packageName for phone: $phone")

        WhatsAppAccessibilityService.armForSend(35_000L) { ok, error ->
            onFinish(ok, error)
        }

        val encoded = URLEncoder.encode(text, "UTF-8")
        // Usamos el esquema nativo whatsapp:// que es más directo que el https://
        val uri = Uri.parse("whatsapp://send?phone=$phone&text=$encoded")
        val sendIntent = Intent(Intent.ACTION_VIEW, uri).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // Esto fuerza a que SÓLO esta app pueda responder al mensaje
            setPackage(packageName)
        }
        
        try {
            startActivity(sendIntent)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start WhatsApp intent", e)
            onFinish(false, "intent_failed")
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
