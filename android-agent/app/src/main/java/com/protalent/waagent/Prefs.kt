package com.protalent.waagent

import android.content.Context

object Prefs {
    private const val NAME = "wa_agent"

    fun get(ctx: Context) = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun serverUrl(ctx: Context): String =
        get(ctx).getString("serverUrl", "")?.trim()?.trimEnd('/') ?: ""

    fun token(ctx: Context): String = get(ctx).getString("token", "")?.trim() ?: ""

    fun label(ctx: Context): String = get(ctx).getString("label", "Android")?.trim() ?: "Android"

    fun sessionId(ctx: Context): String = get(ctx).getString("sessionId", "")?.trim() ?: ""

    fun deviceId(ctx: Context): String = get(ctx).getString("deviceId", "")?.trim() ?: ""

    fun save(
        ctx: Context,
        serverUrl: String,
        token: String,
        label: String,
        sessionId: String
    ) {
        get(ctx).edit()
            .putString("serverUrl", serverUrl.trim().trimEnd('/'))
            .putString("token", token.trim())
            .putString("label", label.trim().ifEmpty { "Android" })
            .putString("sessionId", sessionId.trim())
            .apply()
    }

    fun setDeviceId(ctx: Context, id: String) {
        get(ctx).edit().putString("deviceId", id).apply()
    }
}
