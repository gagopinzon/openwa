package com.protalent.waagent

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action == Intent.ACTION_BOOT_COMPLETED || 
            action == Intent.ACTION_MY_PACKAGE_REPLACED || 
            action == "com.protalent.waagent.KEEP_ALIVE") {
            
            val serviceIntent = Intent(context, AgentPollService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
            
            // Si es la alarma de KEEP_ALIVE, reprogramar la siguiente para crear un bucle infinito
            if (action == "com.protalent.waagent.KEEP_ALIVE") {
                val nextAlarmIntent = Intent(context, BootReceiver::class.java).apply {
                    this.action = "com.protalent.waagent.KEEP_ALIVE"
                }
                val pendingIntent = PendingIntent.getBroadcast(
                    context, 0, nextAlarmIntent, PendingIntent.FLAG_IMMUTABLE
                )
                val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    alarmManager.setExactAndAllowWhileIdle(
                        AlarmManager.RTC_WAKEUP,
                        System.currentTimeMillis() + 5 * 60 * 1000,
                        pendingIntent
                    )
                }
            }
        }
    }
}
