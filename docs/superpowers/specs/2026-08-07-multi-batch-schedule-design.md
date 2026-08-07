# Diseño: cola multi-lote + mañana/tarde

Fecha: 2026-08-07  
Estado: aprobado (implementación)

## Objetivo

Permitir varios lotes en cola a la vez (p. ej. mañana y tarde), con horas fijas configurables (default **10:30** y **16:00**), disparo secuencial (si hay envío activo el siguiente espera), y recuperación de lotes `sending` huérfanos.

## Decisiones

| Tema | Elección |
|------|----------|
| Modelo | Varios lotes en `batches[]` |
| Carga | Dos pasadas: subir/generar/programar por turno |
| Horas | Fijas configurables; defaults 10:30 / 16:00 |
| Día de atajos | Mañana calendario (día siguiente) |
| Conflicto horario | Esperar a que termine el `sending` y luego disparar |
| Encolar con lotes pending | Permitido (append) |
| Enviar ahora | Solo bloqueado si hay `sending` (o job en curso) |
| Huérfanos | Al boot: `sending` sin job → `sent`; API force-clear opcional |

## Persistencia (`data/send-queue.json`)

```json
{
  "version": 2,
  "scheduleDefaults": { "morning": "10:30", "afternoon": "16:00" },
  "batches": [ /* batch objects */ ]
}
```

Migración v1 `{ batch }` → `{ version: 2, batches: batch ? [batch] : [], scheduleDefaults }`.

## API (cambios)

- `GET /api/send-queue` → `{ batches, batch (compat), scheduleDefaults, canEnqueue, canDispatch, buttonBurned }`
- `POST /api/send-queue` → append; body opcional `slot: "morning"|"afternoon"` calcula `scheduledAt` mañana a esa hora
- `POST /api/send-queue/dispatch` → body opcional `{ batchId }`; si no, el próximo due/queued
- `POST /api/send-queue/cancel` → `{ batchId }` requerido si hay varios
- `POST /api/send-queue/clear` → limpia terminales; no toca `sending` vivo; `force: true` cierra huérfanos si no hay job
- Timer: arma al próximo `scheduled`; si dispatch 409 por envío, reintenta ~10s

## UI

- Atajos: «Mañana 10:30» / «Tarde 16:00» (+ datetime manual)
- Panel lista varios lotes con cancelar / iniciar por id
