package com.protalent.waagent

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Tras abrir WhatsApp via wa.me, busca el botón Enviar y lo pulsa.
 */
class WhatsAppAccessibilityService : AccessibilityService() {

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (!armed.get()) return
        val root = rootInActiveWindow ?: return
        if (tryClickSend(root)) {
            armed.set(false)
            pendingResult?.invoke(true, null)
            pendingResult = null
            handler.removeCallbacks(timeoutRunnable)
        }
    }

    override fun onInterrupt() {}

    companion object {
        private val armed = AtomicBoolean(false)
        private var pendingResult: ((Boolean, String?) -> Unit)? = null
        private val handler = Handler(Looper.getMainLooper())
        private val timeoutRunnable = Runnable {
            if (armed.getAndSet(false)) {
                pendingResult?.invoke(false, "send_button_timeout")
                pendingResult = null
            }
        }

        fun armForSend(timeoutMs: Long = 20_000L, onDone: (Boolean, String?) -> Unit) {
            pendingResult = onDone
            armed.set(true)
            handler.removeCallbacks(timeoutRunnable)
            handler.postDelayed(timeoutRunnable, timeoutMs)
        }

        fun cancel() {
            armed.set(false)
            pendingResult = null
            handler.removeCallbacks(timeoutRunnable)
        }
    }

    private fun tryClickSend(root: AccessibilityNodeInfo): Boolean {
        val candidates = listOf(
            "Enviar",
            "Send",
            "enviar",
            "send"
        )
        for (text in candidates) {
            val nodes = root.findAccessibilityNodeInfosByText(text)
            for (node in nodes) {
                if (clickClickable(node)) return true
            }
        }
        // contentDescription / view ids comunes
        val byDesc = findByContentDesc(root, listOf("Enviar", "Send"))
        if (byDesc != null && clickClickable(byDesc)) return true

        val ids = listOf(
            "com.whatsapp:id/send",
            "com.whatsapp.w4b:id/send",
            "com.whatsapp:id/conversation_entry_action_button",
            "com.whatsapp.w4b:id/conversation_entry_action_button"
        )
        for (id in ids) {
            val nodes = root.findAccessibilityNodeInfosByViewId(id)
            for (node in nodes) {
                if (clickClickable(node)) return true
            }
        }
        return false
    }

    private fun findByContentDesc(node: AccessibilityNodeInfo?, texts: List<String>): AccessibilityNodeInfo? {
        if (node == null) return null
        val desc = node.contentDescription?.toString().orEmpty()
        if (texts.any { desc.equals(it, ignoreCase = true) }) return node
        for (i in 0 until node.childCount) {
            val found = findByContentDesc(node.getChild(i), texts)
            if (found != null) return found
        }
        return null
    }

    private fun clickClickable(node: AccessibilityNodeInfo?): Boolean {
        var current = node
        while (current != null) {
            if (current.isClickable) {
                return current.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
            current = current.parent
        }
        return false
    }
}
