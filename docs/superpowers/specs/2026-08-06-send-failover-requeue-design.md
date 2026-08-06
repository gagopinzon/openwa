# Diseño: reencolar mensajes cuando una línea falla o se bloquea

Fecha: 2026-08-06  
Estado: implementado  
Enfoque: **colas fijas + redistribución al fallar** (enfoque 2)

## Problema

En un lote con muchas líneas (p. ej. 10), algunas se suspenden o bloquean a mitad del envío. La cola de esa línea sigue intentando (o marca error) sin mover el trabajo a líneas que sí funcionan. Los contactos fallidos se pierden aunque haya capacidad en otras sesiones.

## Decisiones acordadas

| Tema | Elección |
|------|----------|
| Criterio de reencolado | **C**: desconexión/ban → reencolar; otros errores → 1–2 reintentos en la misma línea y luego reencolar; número inválido / sin WhatsApp → **no** reencolar |
| Cola de línea muerta | **C**: health-check con 1–2 reintentos; si no revive → marcar fuera de servicio y vaciar **toda** su cola pendiente hacia líneas vivas |
| Destino | **A**: round-robin entre líneas aún activas |
| Límite por contacto | **B**: puede rotar por cada línea viva **una vez**; si ninguna lo completa → error definitivo |
| Arquitectura | Colas fijas al inicio (pesos actuales) + redistribución al fallar (no cola global compartida) |

## Fuera de alcance (v1)

- Cambiar el reparto inicial por pesos / UI de pesos
- Auto-respuesta / webhooks
- Reabrir un lote `sent` automáticamente
- Persistencia extra del historial de saltos en Mongo (solo en resultados del job + SSE)
- Detección de “ban” vía APIs externas distintas de OpenWA (solo señales de error/status existentes)

## Flujo

1. Al disparar el lote: igual que hoy — `resolveExactCounts` + colas por sesión; envío en paralelo por línea (`sendSessionQueue`).
2. Antes de cada contacto: health-check de la sesión OpenWA.
   - Si no connected: 1–2 reintentos con espera corta.
   - Si sigue caída: `markSessionDead` → drenar pendientes (incluido el actual) → líneas vivas en round-robin → esa línea termina su worker.
3. Intento de envío (`sendContactWithGreeting`).
4. Clasificar resultado / error:
   - **Éxito** → resultado normal.
   - **Inválido / no WhatsApp** → `success: false`, `error: invalid_number` (o mensaje actual), sin reencolar.
   - **Desconexión / ban / sesión inutilizable** (`isDisconnectError` + patrones de restricción) → igual que health-check fallido: línea muerta + drenar cola.
   - **Otro error** (timeout, 429, etc.): reintentar 1–2 veces en la misma línea; si sigue fallando → reencolar **solo ese** contacto (no matar la línea).
5. Al reencolar un contacto: se anexa al final de la cola de la siguiente línea viva (round-robin), anotando en `triedSessionIds` la línea que acaba de fallar.
6. Se elige destino entre líneas en `aliveSessionIds` que **aún no** estén en `triedSessionIds` del contacto. Si no hay ninguna → error definitivo `exhausted_sessions`.
7. Si no queda ninguna línea viva → pendientes restantes → `success: false`, `error: no_healthy_sessions`.
8. Burst a medio mensaje: si falla un fragmento, el contacto completo se trata como fallo (no se reanuda a mitad); al reencolar se reenvía el burst entero desde otra línea.
9. Hoy `sendMessage` a veces traga el error y devuelve `false`. Para clasificar bien, el envío debe exponer el motivo (throw clasificado o `{ ok, errorClass, message }`) sin registrar resultado definitivo hasta decidir si reencola.

## Arquitectura

### Componentes

| Pieza | Rol |
|-------|-----|
| `sendRoundRobinBulk` | Orquesta workers; crea un **contexto compartido** de failover (líneas vivas, cursor RR, mutex lógico) |
| `sendSessionQueue` | Procesa cola de una línea; consulta contexto antes de cada item; acepta items encolados en caliente |
| Helpers nuevos (mismo archivo o módulo pequeño) | `classifySendError`, `ensureSessionHealthy`, `markSessionDead`, `requeueContact`, `drainSessionQueue` |
| `openwaClient.isDisconnectError` | Reutilizar; ampliar patrones de ban/restricción si hace falta |
| `server.js` / SSE | Propagar fases nuevas en `sessionProgress` / resultados |
| UI (`public/app.js`) | Mostrar fases `requeued`, `session_dead`, línea origen→destino |

### Contexto compartido (en memoria, solo durante el job)

```js
{
  aliveSessionIds: Set<string>,
  deadSessionIds: Set<string>,
  queues: Map<string, QueueItem[]>,      // mutables
  rrCursor: number,                      // round-robin global
  sessionOrder: string[],
  // por contacto (clave telefono o globalIndex):
  triedByContact: Map<number, Set<string>>
}
```

Cada `QueueItem`: `{ contact, globalIndex, triedSessionIds?: string[] }`.

Reglas de concurrencia:

- Los workers corren en paralelo; append/shift de colas y avance de `rrCursor` deben ser síncronos en el event loop (sin await en medio de la mutación) o serializados con una cola de operaciones microtask/lock simple.
- Al drenar una línea muerta, no se vuelven a encolar items hacia `deadSessionIds`.
- Una línea no procesa un contacto si `triedSessionIds` ya incluye esa línea (defensa); en ese caso lo reencola de nuevo o lo marca agotado.

### Clasificación de errores

| Clase | Señales | Acción |
|-------|---------|--------|
| `invalid` | invalid, no está en WhatsApp, not on whatsapp | Error definitivo |
| `session_dead` | `isDisconnectError`, unpaired, logged out, banned, restricted, conflict, 409/502/503 | Matar línea + drenar |
| `transient` | rate limit / 429, timeout, 5xx genérico, error desconocido de envío | Reintento local 1–2; luego reencolar contacto |
| `ok` | envío true | Continuar |

Defaults numéricos (env opcionales):

- `SEND_FAILOVER_HEALTH_RETRIES=2`
- `SEND_FAILOVER_LOCAL_RETRIES=2`
- `SEND_FAILOVER_HEALTH_WAIT_MS=3000`

## Resultados y progreso

Campos extra en filas de resultado / SSE (compatibles con lo existente):

- `requeuedFrom` / `requeuedTo` (opcional)
- `error`: `skipped_disconnected` \| `no_healthy_sessions` \| `exhausted_sessions` \| mensaje original
- `phase` en progreso: `session_dead` \| `requeued` \| `retrying` (además de `sending` / `sent` / `waiting` / `done`)

Un contacto reencolado **no** debe emitir `success: false` definitivo en el primer fallo; solo un evento de progreso `requeued`. El resultado final se emite cuando se envía o se agota.

Si hoy `onMessageResult` ya registró un fallo al devolver `false` de `sendMessage`, hay que ajustar para no quemar el contacto como fallido definitivo cuando aún se va a reencolar.

## Testing

- Unit: `classifySendError` (invalid / dead / transient).
- Unit: round-robin `pickNextAliveSession` ignora `deadSessionIds` y respeta `triedSessionIds`.
- Unit: drenar cola de línea muerta reparte en RR y marca la línea dead.
- Integración ligera / test del servicio con `TEST_MODE` o stubs: 3 líneas, matar una a mitad, verificar que pendientes terminan en las otras y no se reintenta en la muerta.
- Caso: contacto ya intentado en todas las vivas → `exhausted_sessions`.
- Caso: todas muertas → `no_healthy_sessions`.

## Archivos previstos

- `openwaWhatsAppService.js` — lógica principal de failover
- `openwaClient.js` — ampliar `isDisconnectError` / helper de clasificación si conviene
- `server.js` — propagar fases si el mapeo de progreso lo requiere
- `public/app.js` (+ CSS mínimo si hace falta) — UI de reencolado / línea muerta
- `.env.example` — variables de reintentos
- `tests/` — unit tests de classify + requeue helpers

## Relación con spec 2026-08-05 (estabilidad)

El diseño de estabilidad (ritmo, stagger, health-check sin reasignar) queda como base. **Este spec añade el rebalanceo** que allí quedó fuera de alcance. Si el health-check de estabilidad aún no está implementado, se implementa aquí junto con el drenado/reencolado (una sola pasada de cambios en `sendSessionQueue`).
