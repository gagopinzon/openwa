package com.protalent.waagent

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class AgentJob(
    val id: String,
    val telefono: String,
    val mensaje: String,
    val nombre: String?
)

class ApiClient(
    private val baseUrl: String,
    private val token: String
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val json = "application/json; charset=utf-8".toMediaType()

    private fun url(path: String): String = "$baseUrl$path"

    fun register(label: String, logicalSessionId: String?, deviceId: String?, batteryLevel: Int? = null): JSONObject {
        val body = JSONObject()
            .put("label", label)
            .put("logicalSessionId", logicalSessionId)
            .put("deviceId", deviceId)
            .put("batteryLevel", batteryLevel)
            .toString()
            .toRequestBody(json)
        val req = Request.Builder()
            .url(url("/api/android/devices/register"))
            .header("X-Android-Token", token)
            .post(body)
            .build()
        return executeJson(req)
    }

    fun heartbeat(deviceId: String, batteryLevel: Int? = null): JSONObject {
        val body = JSONObject()
            .put("batteryLevel", batteryLevel)
            .toString()
            .toRequestBody(json)
        val req = Request.Builder()
            .url(url("/api/android/devices/$deviceId/heartbeat"))
            .header("X-Android-Token", token)
            .post(body)
            .build()
        return executeJson(req)
    }

    fun nextJob(deviceId: String): AgentJob? {
        val req = Request.Builder()
            .url(url("/api/android/jobs/next?deviceId=$deviceId"))
            .header("X-Android-Token", token)
            .get()
            .build()
        val root = executeJson(req)
        if (root.isNull("job")) return null
        val job = root.getJSONObject("job")
        return AgentJob(
            id = job.getString("id"),
            telefono = job.optString("telefono", ""),
            mensaje = job.optString("mensaje", ""),
            nombre = job.optString("nombre", null)
        )
    }

    fun reportResult(jobId: String, deviceId: String, ok: Boolean, error: String?): JSONObject {
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("ok", ok)
            .put("error", error)
            .toString()
            .toRequestBody(json)
        val req = Request.Builder()
            .url(url("/api/android/jobs/$jobId/result"))
            .header("X-Android-Token", token)
            .post(body)
            .build()
        return executeJson(req)
    }

    private fun executeJson(req: Request): JSONObject {
        client.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw IllegalStateException("HTTP ${resp.code}: $text")
            }
            return JSONObject(text)
        }
    }
}
