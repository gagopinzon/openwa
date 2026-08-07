# Design: Nombres de sesión visibles en Líneas y Conversaciones

**Fecha:** 2026-08-07  
**Estado:** aprobado en conversación (enfoque C)

## Problema

En Conversaciones el hilo muestra `Desde: session7` (id lógico interno) y los errores 403 dicen `No tienes acceso a la sesión "session7"`. Un usuario/admin no puede saber qué línea de WhatsApp es esa.

En el panel **Líneas** (admin) tampoco queda explícito el mapeo nombre amigable ↔ id de sesión.

## Objetivo

1. En Conversaciones y mensajes de error: mostrar siempre el **label** humano (y remitente si aporta), nunca el id crudo si hay etiqueta.
2. En el panel **Líneas** (admin): cada tarjeta muestra **nombre (label)**, **sesión (id lógico)**, OpenWA y remitente; el label es editable.

## Fuera de alcance

- Cambiar el modelo de permisos (quién tiene `view`/`control`).
- Resolver contactos `@lid` a número/nombre (otro problema).
- Rediseñar envío masivo (chips de “Líneas para este envío”) más allá de reutilizar `getSessionLabel` si ya aplica.
- Migrar datos de `sessions.json` automáticamente.

## Diseño

### A. Resolución de nombre (front)

Unificar en `public/app.js` el helper existente:

- `getSessionLabel(sessionId)` → `configuredSessions[].label` o, si falta, el id.
- Opcional para cabeceras: si hay `senderName` distinto del label, mostrar `label · senderName`.

Usar ese helper en:

- Cabecera del hilo (`Desde: …`)
- Lista de chats / search hits / inbox tags
- Cualquier sitio que hoy haga `chat.sessionLabel || chat.sessionId` sin mirar `configuredSessions`

### B. Errores de acceso (back)

En `auth.js` (`forbidUnlessViewSession`, y si aplica `forbidUnlessControlSessions`):

- Resolver label con `sessionsStore.getSession(sessionId)?.label`.
- Mensaje: `No tienes acceso a la línea "{label}"` (o control), usando el label si existe; si no, el id.

Misma idea en `server.js` donde el 403 de conversaciones arma el string con `rawSession` crudo.

### C. Panel Líneas (admin) — `renderLineUsersList`

Por cada sesión, tarjeta con:

| Campo | Comportamiento |
|--------|----------------|
| **Nombre** | Input editable → `PUT /api/sessions/:id` con `label` (endpoint ya existe) |
| **Sesión** | Solo lectura: `session.id` (ej. `session7`) |
| **OpenWA** | Solo lectura: `openwaSessionId` (como hoy) |
| **Remitente** | Input + guardar/sync (como hoy) |
| Usuarios / quitar línea | Sin cambio |

Usuario no-admin: sigue viendo **label** + badge de acceso. También muestra el id de sesión en texto secundario (pequeño) para poder reportar “es session7 = monica” si hace falta; sin editores.

### D. Datos

No hay campos nuevos. `StoredSession` ya tiene `id`, `label`, `openwaSessionId`, `senderName`.

Si una línea tiene label vacío o igual al id, el admin lo corrige desde el input de Nombre.

## Flujo

```
sessions.json ──► GET /api/sessions ──► configuredSessions
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    ▼                      ▼                      ▼
              Panel Líneas          Conversaciones            Errores 403
              (label + id)          getSessionLabel()         label en mensaje
```

## Criterios de aceptación

1. Abrir un chat de `session7` con label `monica` muestra `Desde: monica` (no `session7`).
2. Un 403 de acceso menciona la línea por label cuando existe.
3. Admin en Líneas ve en cada tarjeta: nombre, id `sessionN`, código OpenWA, remitente; puede guardar un nombre nuevo y al recargar Conversaciones usa ese nombre.
4. No-admin ve el nombre de sus líneas y el id en secundario; no edita label.

## Archivos previstos

- `public/app.js` — resolución de label; UI Líneas (input label + id visible)
- `public/style.css` — estilos mínimos para meta “Sesión: sessionN” / input label
- `auth.js` — mensajes 403 con label
- `server.js` — 403 de `/api/conversations` (y similares) con label si aplica
