package com.protalent.waagent

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
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

        serverUrl.setText(Prefs.serverUrl(this))
        token.setText(Prefs.token(this))
        label.setText(Prefs.label(this))
        sessionId.setText(Prefs.sessionId(this))
        status.text = "DeviceId: ${Prefs.deviceId(this).ifBlank { "(sin registrar)" }}"

        findViewById<Button>(R.id.saveBtn).setOnClickListener {
            Prefs.save(
                this,
                serverUrl.text.toString(),
                token.text.toString(),
                label.text.toString(),
                sessionId.text.toString()
            )
            Toast.makeText(this, "Guardado", Toast.LENGTH_SHORT).show()
        }

        findViewById<Button>(R.id.registerBtn).setOnClickListener {
            Prefs.save(
                this,
                serverUrl.text.toString(),
                token.text.toString(),
                label.text.toString(),
                sessionId.text.toString()
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
                sessionId.text.toString()
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
