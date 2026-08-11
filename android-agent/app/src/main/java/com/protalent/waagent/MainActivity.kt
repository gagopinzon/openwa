package com.protalent.waagent

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.RadioButton
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val serverUrl = findViewById<EditText>(R.id.serverUrl)
        val token = findViewById<EditText>(R.id.token)
        val label = findViewById<EditText>(R.id.label)
        val sessionId = findViewById<EditText>(R.id.sessionId)
        val status = findViewById<TextView>(R.id.status)
        val rbNormal = findViewById<RadioButton>(R.id.rbNormal)
        val rbBusiness = findViewById<RadioButton>(R.id.rbBusiness)

        serverUrl.setText(Prefs.serverUrl(this))
        token.setText(Prefs.token(this))
        label.setText(Prefs.label(this))
        sessionId.setText(Prefs.sessionId(this))

        if (Prefs.preferredPackage(this) == "com.whatsapp.w4b") {
            rbBusiness.isChecked = true
        } else {
            rbNormal.isChecked = true
        }

        status.text = "DeviceId: ${Prefs.deviceId(this).ifBlank { "(sin registrar)" }}"

        val getSelectedPkg = { if (rbBusiness.isChecked) "com.whatsapp.w4b" else "com.whatsapp" }

        findViewById<Button>(R.id.saveBtn).setOnClickListener {
            Prefs.save(
                this,
                serverUrl.text.toString(),
                token.text.toString(),
                label.text.toString(),
                sessionId.text.toString(),
                getSelectedPkg()
            )
            Toast.makeText(this, "Guardado", Toast.LENGTH_SHORT).show()
        }

        findViewById<Button>(R.id.registerBtn).setOnClickListener {
            Prefs.save(
                this,
                serverUrl.text.toString(),
                token.text.toString(),
                label.text.toString(),
                sessionId.text.toString(),
                getSelectedPkg()
            )
            thread {
                try {
                    val api = ApiClient(Prefs.serverUrl(this), Prefs.token(this))
                    val res = api.register(
                        Prefs.label(this),
                        Prefs.sessionId(this).ifBlank { null },
                        Prefs.deviceId(this).ifBlank { null }
                    )
                    val id = res.getJSONObject("device").getString("id")
                    Prefs.setDeviceId(this, id)
                    runOnUiThread {
                        status.text = "Registrado: $id"
                        Toast.makeText(this, "OK", Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    runOnUiThread {
                        Toast.makeText(this, e.message, Toast.LENGTH_LONG).show()
                    }
                }
            }
        }

        findViewById<Button>(R.id.accessibilityBtn).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        findViewById<Button>(R.id.batteryBtn).setOnClickListener {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            try {
                startActivity(intent)
            } catch (e: Exception) {
                // Algunos dispositivos no soportan el intent directo
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
        }

        // Recordatorio visible si Accesibilidad no está activa
        val a11yOn = WhatsAppAccessibilityService.isServiceConnected()
        if (!a11yOn) {
            status.append("\n⚠️ Activa Accesibilidad → WA Agent o no podrá pulsar Enviar")
        }

        findViewById<Button>(R.id.startBtn).setOnClickListener {
            Prefs.save(
                this,
                serverUrl.text.toString(),
                token.text.toString(),
                label.text.toString(),
                sessionId.text.toString(),
                getSelectedPkg()
            )
            
            // Programar WorkManager para persistencia extra
            val workRequest = androidx.work.PeriodicWorkRequestBuilder<KeepAliveWorker>(15, java.util.concurrent.TimeUnit.MINUTES)
                .build()
            androidx.work.WorkManager.getInstance(this).enqueueUniquePeriodicWork(
                "KeepAliveWork",
                androidx.work.ExistingPeriodicWorkPolicy.KEEP,
                workRequest
            )

            val intent = Intent(this, AgentPollService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            status.text = "Agente iniciado. DeviceId: ${Prefs.deviceId(this)}"
        }

        findViewById<Button>(R.id.stopBtn).setOnClickListener {
            stopService(Intent(this, AgentPollService::class.java))
            status.text = "Agente detenido"
        }
    }
}
