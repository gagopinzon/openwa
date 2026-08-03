# Diseño: seleccionar solo líneas conectadas en OpenWA

Fecha: 2026-08-03  
Estado: pendiente de revisión del usuario

## Problema

En el selector “Enviar mensajes con sesiones” (`#sessionCheckboxes`) se pueden marcar líneas aunque estén desconectadas en OpenWA. Eso provoca errores al encolar/enviar. Hoy el estado de conexión solo se consulta de forma puntual (p. ej. `/open-whatsapp`, import de sesiones conectadas), no al armar el selector.

## Objetivo

Mostrar todas las líneas con permiso de control; las desconectadas visibles pero no seleccionables. Refrescar el estado al cargar el selector y con un botón “Actualizar estado”.

## Decisiones

| Tema | Decisión |
|------|----------|
| UX de desconectadas | Visibles, checkbox deshabilitado, sin marcar |
| Actualización | Al cargar/renderizar + botón “Actualizar estado” |
| Enfoque | Endpoint propio + UI en `renderSessionUI` |
| Validación backend | Opcional en esta entrega (no requerida); el filtro de UI es el alcance |

## Arquitectura

### 1. Backend — `GET /api/sessions/connection-status`

- Auth: cualquier usuario autenticado con al menos una sesión de `control` (mismo criterio que el selector).
- Fuentes:
  - Sesiones lógicas: `sessionsStore` filtradas por `filterSessionsForUser(..., 'control')`.
  - Estado OpenWA: reutilizar `listOpenWASessions` y/o `getSessionStatus` + `isConnectedStatus` de `openwaClient.js`.
- Preferir una sola llamada a `listOpenWASessions({ limit: 100 })` y mapear por `openwaSessionId` para evitar N round-trips.
- Respuesta:

```json
{
  "success": true,
  "sessions": [
    {
      "id": "session1",
      "openwaSessionId": "abc",
      "label": "Línea MX-1",
      "status": "connected",
      "connected": true
    },
    {
      "id": "session2",
      "openwaSessionId": "xyz",
      "label": "Línea MX-2",
      "status": "disconnected",
      "connected": false
    }
  ]
}
```

- Si OpenWA falla para una sesión concreta: `connected: false`, `status` con el error resumido (no tumbar todo el endpoint si se puede devolver el resto).
- Si falla listar OpenWA por completo: 502/500 con mensaje claro; el frontend deja las líneas en estado “desconocido” y permite reintentar con el botón.

### 2. Frontend — `public/app.js` + `index.html` + CSS

Estado en memoria:

```js
this._sessionConnectionById = {}; // { [logicalId]: { connected, status } }
```

Flujo:

1. Tras cargar sesiones configuradas (o al llamar `renderSessionUI`), invocar `refreshSessionConnectionStatus()`.
2. `refreshSessionConnectionStatus()` hace `GET /api/sessions/connection-status`, guarda el mapa y vuelve a pintar checkboxes (o aplica estado sin destruir cantidades si se prefiere).
3. En `renderSessionUI`, por cada fila de `controllable`:
   - Si `connected === true` (o aún no hay dato y se asume desconocido → tratar como no seleccionable hasta confirmar, o mostrar “Verificando…”): checkbox habilitado.
   - Si `connected === false`: checkbox `disabled`, `checked = false`, badge “Desconectado” (color discreto), fila con clase `session-send-row-offline`.
4. Botón `#refreshSessionStatusBtn` junto al selector: llama al refresh, deshabilitado mientras carga, texto “Actualizar estado”.
5. `getSelectedSessionIds()` solo cuenta checkboxes `:checked` (los disabled no se marcan), así encolar/enviar ya excluye desconectadas sin lógica extra.
6. Si al refrescar una línea marcada pasa a desconectada: desmarcarla y recalcular pesos (`updateSessionWeightUI` / `maybeReseedSessionCounts`).

Default al primer render sin datos aún:

- Mientras carga: mostrar las filas con checkbox deshabilitado y texto “Verificando…” para no permitir seleccionar a ciegas.
- Tras respuesta: aplicar conectado/desconectado.

### 3. Visual (mínimo)

- Badge / texto corto al lado del nombre: `Conectada` (opcional, sutil) / `Desconectada`.
- Fila desconectada ligeramente atenuada (`opacity` o color muted ya usado en el panel).
- No rediseñar el bloque de envío; solo señales claras dentro del patrón actual de `.session-send-row`.

## Fuera de alcance

- Polling automático periódico.
- Ocultar líneas desconectadas.
- Validación dura en `POST /api/send-queue` / `send-messages` (se puede añadir después).
- Cambios en el selector del panel “Respuesta automática” u otros selectores de sesión.

## Criterios de éxito

1. Una línea desconectada en OpenWA aparece en el selector pero no se puede marcar.
2. Tras “Actualizar estado”, una línea que se reconectó vuelve a ser seleccionable.
3. Si todas están desconectadas, `getSelectedSessionIds()` queda vacío y el flujo de envío/encolado ya muestra el error existente de “Marca al menos una sesión…”.
4. Usuarios no-super con control en N líneas solo ven el estado de esas N.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Latencia de OpenWA al listar | Una sola `listOpenWASessions`; botón con estado de carga |
| Cache / estado stale | Usuario refresca con el botón antes de enviar |
| Usuario marca y luego se cae la línea | Refresh desmarca; validación backend queda como mejora futura |

## Archivos previstos

- `server.js` — nuevo endpoint
- `public/app.js` — fetch, estado, `renderSessionUI`, botón
- `public/index.html` — botón “Actualizar estado”
- `public/style.css` — estilos mínimos offline/badge
