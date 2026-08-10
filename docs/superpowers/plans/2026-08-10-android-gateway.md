# Android Gateway Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Enviar mensajes fríos desde WhatsApp en Android, orquestados por el servidor actual.

**Architecture:** Store de devices/jobs + API poll/result; envío con `channel=android`; app Kotlin con intent wa.me + AccessibilityService.

**Tech Stack:** Node/Express (existente), JSON store en `data/`, Kotlin Android (minSdk 24).

## Global Constraints

- Token: `ANDROID_GATEWAY_TOKEN` en `.env`
- Sin IA en el agente
- OpenWA intacto para auto-reply

---

### Task 1: Store + tests

**Files:** `androidGatewayStore.js`, `tests/androidGatewayStore.test.js`

- [ ] Register device, claim next job, report result, heartbeat, enqueue for devices
- [ ] Run tests

### Task 2: API + auth token

**Files:** `server.js`, `.env.example`

- [ ] Endpoints register / next / result / heartbeat / list devices
- [ ] Panel mínimo de devices online

### Task 3: Canal android en envío

**Files:** `server.js`, `androidSendService.js`

- [ ] Si `channel === 'android'`, encolar jobs y esperar resultados (con timeout)
- [ ] Distribuir por devices ligados a sessions o online

### Task 4: App Android

**Files:** `android-agent/**`

- [ ] Config UI, poll service, accessibility send via wa.me, report result
