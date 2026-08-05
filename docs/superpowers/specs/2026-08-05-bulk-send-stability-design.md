# Diseño: estabilidad del envío masivo OpenWA

Fecha: 2026-08-05  
Estado: aprobado (enfoque A)

## Problema

Durante envíos masivos con varias líneas OpenWA, las sesiones se desconectan casi a la vez. Causas probables en el código actual:

- Arranque en paralelo (`Promise.all`) sin desfase entre líneas
- Burst de 1–4 mensajes con pausas muy cortas (1.5–3.5 s)
- Delay entre contactos 1–5 min, pero sincronizado entre sesiones
- Sin health-check entre mensajes ni pausa por línea caída

Contexto confirmado: ocurre en envío masivo; auto-respuesta no está en uso; caídas casi simultáneas; varias líneas (hasta ~14) con corridas pequeñas (~6–7 contactos).

## Enfoque

Estabilizar ritmo (desfase + delays + burst más lento) y health-check por línea sin reasignar contactos.

## Ritmo

| Parámetro | Antes | Nuevo (default) |
|-----------|-------|-----------------|
| Delay entre contactos | 60–300 s | 120–480 s |
| Stagger arranque multi-sesión | 0 | `index × STAGGER + jitter` |
| Pausa entre fragmentos burst | 1.5–3.5 s | 8–20 s |
| Delay humano pre-envío | 3–10 s | 5–15 s |
| Typing antes de enviar | no | sí (opcional, default on) |

Variables de entorno (ver `.env.example`).

## Health-check

1. Antes de cada contacto: `getSessionStatus`; si no connected, 2–3 reintentos con espera.
2. Si sigue caída: pausar solo esa línea; contactos restantes → `success: false`, `error: skipped_disconnected`.
3. Otras líneas continúan.
4. Errores de envío que indiquen desconexión → mismo flujo.
5. SSE/`sessionProgress` con `phase: 'disconnected'`; UI muestra el estado.

Fuera de alcance v1: rebalanceo a otras líneas, auto-respuesta, cambios en el servidor OpenWA.

## Archivos

- `openwaWhatsAppService.js` — ritmo, stagger, health, typing
- `openwaClient.js` — helper `isDisconnectError` si aplica
- `server.js` — propagar fase en progreso si hace falta
- `public/app.js` — UI fase `disconnected` / `staggering`
- `.env.example` — variables documentadas

## Prueba

- `TEST_MODE=true` sin cambios de ritmo real
- Envío real con 2–3 líneas: verificar desfase de arranque
- Simular línea caída: el resto del lote sigue
