package com.protalent.waagent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Tras abrir WhatsApp via wa.me:
 * 1) pulsa "Continuar al chat" si aparece
 * 2) pulsa el botón Enviar
 */
class WhatsAppAccessibilityService : AccessibilityService() {

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "Accessibility service connected")
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (!armed.get()) return
        attemptSendFlow()
    }

    override fun onInterrupt() {}

    private fun attemptSendFlow() {
        if (!armed.get()) return
        val root = rootInActiveWindow ?: return

        // Paso intermedio del deep link
        clickFirstMatchingText(
            root,
            listOf(
                "Continuar al chat",
                "Continue to chat",
                "Abrir chat",
                "Open chat",
                "Continuar",
                "Continue",
                "OK",
                "Aceptar"
            )
        )

        if (tryClickSend(root)) {
            finishSuccess()
        }
    }

    private fun finishSuccess() {
        if (!armed.getAndSet(false)) return
        handler.removeCallbacks(timeoutRunnable)
        handler.removeCallbacks(pollRunnable)
        pendingResult?.invoke(true, null)
        pendingResult = null
        Log.i(TAG, "Send button clicked")
    }

    private fun tryClickSend(root: AccessibilityNodeInfo): Boolean {
        val sendIds = listOf(
            "com.whatsapp:id/send",
            "com.whatsapp.w4b:id/send",
            "com.whatsapp:id/send_container",
            "com.whatsapp.w4b:id/send_container",
            "com.whatsapp:id/conversation_entry_action_button",
            "com.whatsapp.w4b:id/conversation_entry_action_button",
            "com.whatsapp:id/entry_action_button",
            "com.whatsapp.w4b:id/entry_action_button"
        )
        for (id in sendIds) {
            val nodes = root.findAccessibilityNodeInfosByViewId(id) ?: continue
            for (node in nodes) {
                if (node.isEnabled && clickNode(node)) return true
            }
        }

        // Icono / contentDescription "Enviar" (evitar textos largos del mensaje)
        val byDesc = findNodesByContentDesc(root, listOf("Enviar", "Send"))
        for (node in byDesc) {
            if (node.isEnabled && looksLikeSendButton(node) && clickNode(node)) return true
        }

        // Último recurso: texto exacto corto "Enviar"/"Send"
        for (label in listOf("Enviar", "Send")) {
            val nodes = root.findAccessibilityNodeInfosByText(label) ?: continue
            for (node in nodes) {
                val text = node.text?.toString()?.trim().orEmpty()
                val desc = node.contentDescription?.toString()?.trim().orEmpty()
                if (text.equals(label, true) || desc.equals(label, true)) {
                    if (node.isEnabled && clickNode(node)) return true
                }
            }
        }
        return false
    }

    private fun looksLikeSendButton(node: AccessibilityNodeInfo): Boolean {
        val rect = Rect()
        node.getBoundsInScreen(rect)
        if (rect.width() <= 0 || rect.height() <= 0) return false
        // El botón enviar suele ser pequeño y abajo a la derecha
        val screen = resources.displayMetrics
        val nearBottom = rect.centerY() > screen.heightPixels * 0.55f
        val nearRight = rect.centerX() > screen.widthPixels * 0.55f
        val small = rect.width() < screen.widthPixels * 0.35f
        return nearBottom && nearRight && small
    }

    private fun clickFirstMatchingText(root: AccessibilityNodeInfo, labels: List<String>): Boolean {
        for (label in labels) {
            val nodes = root.findAccessibilityNodeInfosByText(label) ?: continue
            for (node in nodes) {
                val text = node.text?.toString().orEmpty()
                val desc = node.contentDescription?.toString().orEmpty()
                if (text.contains(label, true) || desc.contains(label, true)) {
                    if (clickNode(node)) return true
                }
            }
        }
        return false
    }

    private fun findNodesByContentDesc(
        node: AccessibilityNodeInfo?,
        texts: List<String>,
        out: MutableList<AccessibilityNodeInfo> = mutableListOf()
    ): List<AccessibilityNodeInfo> {
        if (node == null) return out
        val desc = node.contentDescription?.toString().orEmpty()
        if (texts.any { desc.equals(it, ignoreCase = true) }) {
            out.add(node)
        }
        for (i in 0 until node.childCount) {
            findNodesByContentDesc(node.getChild(i), texts, out)
        }
        return out
    }

    private fun clickNode(node: AccessibilityNodeInfo?): Boolean {
        if (node == null) return false

        // 1) ACTION_CLICK en el nodo o ancestros clickable
        var current: AccessibilityNodeInfo? = node
        while (current != null) {
            if (current.isClickable) {
                if (current.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true
            }
            current = current.parent
        }

        // 2) Gesture tap en el centro del nodo (más fiable en muchos Android)
        val rect = Rect()
        node.getBoundsInScreen(rect)
        if (rect.isEmpty) return false
        val x = rect.exactCenterX()
        val y = rect.exactCenterY()
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 60)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(gesture, null, null)
    }

    companion object {
        private const val TAG = "WaA11y"
        @Volatile
        private var instance: WhatsAppAccessibilityService? = null

        private val armed = AtomicBoolean(false)
        private var pendingResult: ((Boolean, String?) -> Unit)? = null
        private val handler = Handler(Looper.getMainLooper())

        private val timeoutRunnable = Runnable {
            if (armed.getAndSet(false)) {
                handler.removeCallbacks(pollRunnable)
                pendingResult?.invoke(false, "send_button_timeout")
                pendingResult = null
                Log.w(TAG, "Send timeout")
            }
        }

        private val pollRunnable = object : Runnable {
            override fun run() {
                if (!armed.get()) return
                instance?.attemptSendFlow()
                handler.postDelayed(this, 700)
            }
        }

        fun isServiceConnected(): Boolean = instance != null

        fun armForSend(timeoutMs: Long = 35_000L, onDone: (Boolean, String?) -> Unit) {
            pendingResult = onDone
            armed.set(true)
            handler.removeCallbacks(timeoutRunnable)
            handler.removeCallbacks(pollRunnable)
            handler.postDelayed(timeoutRunnable, timeoutMs)
            // Reintentos periódicos aunque no lleguen eventos
            handler.post(pollRunnable)
        }

        fun cancel() {
            armed.set(false)
            pendingResult = null
            handler.removeCallbacks(timeoutRunnable)
            handler.removeCallbacks(pollRunnable)
        }
    }
}
