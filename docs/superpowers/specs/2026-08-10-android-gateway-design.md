# Diseño: Gateway Android para envío frío

Fecha: 2026-08-10  
Estado: aprobado (implementación)

## Problema

OpenWA (WhatsApp Web) quema muchas líneas en prospección fría. Se necesita enviar desde la app móvil real, orquestado por el panel actual.

## Decisiones

- App Android **programada** (sin IA): AccessibilityService + intent `wa.me` / `api.whatsapp.com/send`.
- Servidor = cola/orquestación; celular = ejecución.
- Volumen objetivo: ~100 msgs/día, ~10 líneas (~10/dispositivo/día).
- Fase 1: canal `android` para el envío masivo frío. OpenWA sigue para auto-reply / chats existentes.
- Auth del agente: token compartido `ANDROID_GATEWAY_TOKEN` (+ `deviceId` tras registro).

## Arquitectura

```
Panel / send-queue / send-whatsapp (channel=android)
        → androidGatewayStore (devices + jobs)
        → App Android (poll) → WhatsApp app → report result
```

## Modelo

**Device:** `id`, `label`, `logicalSessionId` (opcional), `token`, `lastSeenAt`, `status`, `createdAt`.

**Job:** `id`, `deviceId`, `batchId?`, `telefono`, `mensaje`, `nombre?`, `status` (`pending|claimed|sent|failed|expired`), timestamps, `error?`.

## API (agente)

- `POST /api/android/devices/register` `{ label, logicalSessionId? }` + header `X-Android-Token`
- `GET /api/android/jobs/next` query `deviceId` + token → un job `pending` → `claimed`
- `POST /api/android/jobs/:id/result` `{ ok, error? }`
- `POST /api/android/devices/:id/heartbeat`

## API (panel)

- `GET /api/android/devices`
- Envío: `channel: "android"` en body de send / cola; reparte por devices online ligados a `selectedSessions` (o round-robin de online).

## App Android

1. Config: URL servidor, token, label.
2. Foreground service: poll cada N segundos.
3. Al recibir job: intent WhatsApp con teléfono+texto → AccessibilityService pulsa Enviar.
4. Reporta resultado.

## Límites

- Delay mínimo entre jobs por device (config, default 3–5 min).
- Job `claimed` sin resultado en timeout → `failed` o requeue una vez.
- No garantiza evitar bans en frío; solo cambia el canal de salida.
