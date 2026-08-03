# Diseño: Cola de envío (lote pendiente / programado)

Fecha: 2026-08-03  
Estado: aprobado (pendiente implementación)

## Problema

Hoy el flujo es: subir PDFs → generar mensajes IA → **Enviar por WhatsApp** dispara al momento. No hay forma de dejar un lote listo sin mandarlo, ni de programar una hora, ni de impedir re-disparar el mismo lote una vez iniciado el envío.

Se necesita: preparar y **encolar** (con o sin fecha/hora), persistir en servidor, disparar manual o automático, y **quemar** el botón de envío tras disparar ese lote.

## Decisiones acordadas

- Enfoque **A minimal**: un solo lote activo; no cola de varios lotes concurrentes.
- Persistencia en servidor (`data/`), sobrevive cierre de navegador.
- Programación: el **servidor** dispara a la hora aunque la página esté cerrada (Node debe estar corriendo).
- Controles del lote encolado: **solo cancelar o enviar ahora** (sin editar el snapshot).
- Tras disparar el envío: botón Enviar queda quemado para ese lote (no re-disparar el mismo).
- Tras `sent` o `cancelled`: se puede preparar / encolar un lote nuevo.

## Flujo de usuario

1. Subir PDFs → Procesar → Generar mensajes (igual que hoy).
2. Elegir sesiones/pesos como hoy.
3. **Encolar lote** (opcional datetime “Programar para…”). Guarda snapshot en servidor; **no** llama a WhatsApp.
4. Panel Cola: estado, cantidad, hora programada → **Cancelar** o **Enviar ahora**.
5. Al iniciar envío (manual, “Enviar ahora”, o timer): estado `sending`, botón Enviar quemado.
6. Al terminar → `sent`. Al cancelar antes → `cancelled`. Luego se permite un lote nuevo.

El botón legacy **Enviar por WhatsApp** puede seguir enviando al momento si no hay lote activo; al disparar también quema y marca el lote como el envío en curso (o crea un lote implícito `sending` para no duplicar).

## Modelo de datos

Nuevo store: `sendQueueStore.js` → `data/send-queue.json` (mismo patrón que `agendaPendingStore`).

Estados:

| Estado | Significado |
|--------|-------------|
| `queued` | Listo, sin hora; espera “Enviar ahora” |
| `scheduled` | Listo, con `scheduledAt`; el servidor programa timer |
| `sending` | Envío en curso vía `runWhatsAppSendJob` |
| `sent` | Terminado (éxito o fin del job) |
| `cancelled` | Cancelado antes de enviar |

Campos del lote (único activo):

```json
{
  "version": 1,
  "batch": {
    "id": "hex",
    "status": "queued|scheduled|sending|sent|cancelled",
    "createdAt": "ISO",
    "scheduledAt": "ISO|null",
    "sentAt": "ISO|null",
    "cancelledAt": "ISO|null",
    "selectedSessions": ["session1"],
    "sessionWeights": { "session1": 10 },
    "cvs": [
      {
        "archivoOriginal": "...",
        "nombre": "...",
        "telefono": "...",
        "mensajeIA": "...",
        "saludo": "...",
        "cvId": "..."
      }
    ],
    "total": 10
  }
}
```

Reglas:

- Siempre se conserva el último `batch` (también `sent`/`cancelled`) para que la UI sepa si el botón está quemado.
- Solo un lote “activo” (`queued` | `scheduled` | `sending`) a la vez. Encolar con otro activo → `409`.
- Encolar cuando el último lote es `sent` o `cancelled` (o `batch` null) → reemplaza por el nuevo lote.
- Snapshot inmutable: cancelar o dispatch; no PATCH de mensajes.
- Al arrancar el servidor: si hay `scheduled` con `scheduledAt` futuro → reprogramar timeout; si ya pasó → dispatch cuando no haya envío en curso.

## API

Auth: mismas reglas de control de sesiones que `/send-whatsapp` (`forbidUnlessControlSessions`).

### `POST /api/send-queue`

Body:

```json
{
  "cvs": [ /* mismos campos editables que hoy */ ],
  "selectedSessions": ["..."],
  "sessionWeights": { "...": 1 },
  "scheduledAt": "2026-08-03T22:00:00-06:00" | null
}
```

- Valida CVs con `mensajeIA` y teléfono válido (misma lógica de filtrado/dedupe que el envío actual, o al menos la misma entrada que usaría el send).
- `scheduledAt` ausente/null → `queued`; con fecha futura → `scheduled`.
- Persiste y, si `scheduled`, arma el timer.
- No inicia WhatsApp.

### `GET /api/send-queue`

Devuelve el lote actual (o `batch: null`) + flags útiles para UI (`canEnqueue`, `canDispatch`, `buttonBurned`).

### `POST /api/send-queue/dispatch`

- Solo si status es `queued` o `scheduled`.
- Pasa a `sending`, cancela timer pendiente, llama `runWhatsAppSendJob` con el snapshot.
- Al finalizar el job → `sent` (+ `sentAt`).

### `POST /api/send-queue/cancel`

- Solo si `queued` o `scheduled` (no si ya `sending`).
- Cancela timer; status `cancelled`.

### Relación con `/send-whatsapp`

- Si hay lote `queued`/`scheduled`/`sending` → `/send-whatsapp` responde `409` (evitar doble camino).
- Si se usa Enviar directo sin cola: crear/actualizar batch a `sending` y al terminar `sent`, para quemar el botón de forma coherente.
- Reutilizar `isAnySendingInProgress` / `runWhatsAppSendJob` sin reescribir el envío.

## UI

En `public/index.html` / `app.js` (sección Resultados):

- Botón **Encolar lote** + input datetime-local opcional (timezone del navegador → ISO al API).
- Panel Cola: estado, total, `scheduledAt`, **Enviar ahora**, **Cancelar**.
- **Enviar por WhatsApp**:
  - Habilitado solo si hay mensajes listos **y** no hay lote activo (`queued`/`scheduled`/`sending`) **y** el último lote no está en `sending`/`sent` (quemado).
  - Tras disparar: texto “Enviando…” / “Enviado”; se desbloquea al **Cancelar** (solo pre-envío), **Limpiar**, o al **Encolar** un lote nuevo tras `sent`/`cancelled`.
- Al cargar la página: `GET /api/send-queue` para restaurar panel y estado de botones.

## Errores / bordes

| Caso | Comportamiento |
|------|----------------|
| Encolar sin mensajes listos | `400` |
| Encolar con lote activo | `409` |
| Dispatch con envío ya en curso (otra vía) | `409` |
| `scheduledAt` en el pasado | `400` |
| Reinicio del proceso Node | Rehidratar timer desde `scheduled` |
| Fallo mid-job | El job actual ya reporta errores por mensaje; el batch termina en `sent` (completado) con resultados parciales visibles vía progreso existente. No reabrir el mismo snapshot automáticamente. |

## Fuera de alcance (YAGNI)

- Varios lotes concurrentes / historial de colas.
- Editar mensajes del snapshot encolado.
- Reintentar solo fallidos del mismo lote (se puede re-preparar un lote nuevo después).
- UI de calendario compleja; basta datetime-local.

## Criterios de éxito

1. Puedo generar mensajes y encolar sin que salga ningún WhatsApp.
2. Puedo programar una hora; con la página cerrada y Node arriba, a esa hora arranca el envío.
3. Puedo cancelar o “Enviar ahora” mientras está pendiente.
4. Tras disparar, no puedo volver a pulsar Enviar para el mismo lote.
5. Tras cancelar o terminar, puedo preparar un lote nuevo.
