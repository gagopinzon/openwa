# Design: Traspaso de líneas entre vendedores

**Fecha:** 2026-08-17  
**Estado:** aprobado en conversación (enfoque B — API atómica + SSE)

## Problema

Si un vendedor se va a media jornada, el admin tiene que arrastrar pastilla por pastilla. El Kanban **copia** (no mueve). El vendedor que se queda no ve las líneas nuevas hasta recargar, porque `configuredSessions` se carga al iniciar.

## Objetivo

El **admin** pasa **todas** las líneas de un vendedor a otro en un clic. Es un **traspaso** (el origen las pierde). Ambos paneles se actualizan **sin cerrar sesión ni recargar**, vía SSE.

## Fuera de alcance

- Que un vendedor no-admin se traspase líneas a sí mismo.
- Cambiar el arrastre del Kanban (sigue copiando).
- Asignación exclusiva (un tercer usuario que ya tenía la línea la conserva).
- Cambiar el modelo `permissions[sessionId] = view|control`.
- Polling de permisos como mecanismo principal.

## Decisiones confirmadas

| Tema | Decisión |
|------|----------|
| Quién | Solo admin |
| Semántica | Mover, no copiar |
| Destino | Recibe `control` en cada línea (si tenía `view`, sube a `control`) |
| Terceros | No se tocan |
| En vivo | SSE `lineAccessChanged` + recarga de sesiones del cliente |
| Arrastre Kanban | Sin cambio |

## Diseño

### A. UI admin (Kanban)

En cada columna de usuario con ≥1 línea y ≥1 otro usuario, un `<select>` **Pasar líneas…** con el resto de usuarios.

Al elegir destino, `confirm`:

> ¿Pasar N líneas de Ana a Luis? Ana dejará de verlas.

Cancelar deja el select en el placeholder. Confirmar llama a la API, refresca el tablero y muestra toast.

Si el origen no tiene líneas o no hay otro usuario, el select no se renderiza.

### B. Store y API

`usersStore.transferLines(fromUserId, toUserId)` lee `users.json` una vez, aplica el movimiento y escribe una vez.

Reglas:

- Origen y destino existen, son distintos, no-admin.
- Líneas a mover = keys de `from.permissions` con `view` o `control`.
- Si no hay ninguna → error.
- Destino: esas keys quedan en `control`.
- Origen: esas keys se borran.
- Un write atómico.

```
POST /api/users/:id/transfer-lines
requireSuper
body: { "toUserId": "<uuid>" }
```

200:

```json
{
  "success": true,
  "from": { "id": "...", "username": "...", "permissions": {} },
  "to": { "id": "...", "username": "...", "permissions": { "session3": "control" } },
  "sessionIds": ["session3"],
  "movedCount": 1
}
```

400 si destino inválido, mismo usuario, origen/destino inexistente, o sin líneas.

Tras éxito: `broadcastEvent('lineAccessChanged', { fromUserId, toUserId, sessionIds, movedCount })`.

No se emite en el `PUT /api/users/:id` de asignación suelta.

### C. Cliente en vivo

Todos los paneles ya tienen `EventSource('/events')`. Nuevo listener `lineAccessChanged`:

1. `GET /api/auth/status` para refrescar `currentUser.permissions`.
2. `loadSessions()` (lista filtrada en vivo).
3. Si admin: `loadUsers()` (Kanban).
4. `applyPermissionUI()`.
5. Si Conversaciones ya se cargó: `loadConversationsChats({ silent: true })`.
6. Si el hilo abierto es de una línea que ya no se puede ver: cerrarlo (mismo vacío que al borrar un chat).

El vendedor destino ve las líneas nuevas; el origen deja de verlas. Ninguno cierra sesión.

### D. Errores

| Caso | Mensaje |
|------|---------|
| Mismo id | El destino debe ser otro usuario |
| Origen/destino no encontrado | Usuario origen/destino no encontrado |
| Sin líneas | Ese usuario no tiene líneas para pasar |
| No admin | El `requireSuper` existente |

Fallos de red en el botón: toast de error, Kanban se recarga con `loadUsers`.

### E. Tests

`tests/usersStore.transferLines.test.js` (node:test, backup/restore de `data/users.json` como el resto de stores):

- Mueve todas las líneas; origen vacío; destino `control`.
- Destino que ya tenía `view` sube a `control`.
- Tercer usuario no se modifica.
- Mismo usuario / inexistente / sin líneas lanzan error.

## Flujo

```
Admin elige destino en columna de Ana
    │ confirm
    ▼
POST /api/users/:anaId/transfer-lines { toUserId: luisId }
    │
    ▼
usersStore.transferLines  (un read + un write)
    │
    ▼
broadcastEvent('lineAccessChanged')
    │
    ├─ panel Ana  → loadSessions → ya no ve esas líneas
    ├─ panel Luis → loadSessions → las ve con control
    └─ panel admin → loadUsers → Kanban actualizado
```

## Criterios de aceptación

1. Admin pasa N líneas de A a B en un confirm; A queda en 0 de esas líneas; B las tiene en `control`.
2. Un tercer usuario que ya las tenía no pierde acceso.
3. El arrastre Kanban sigue copiando.
4. B, con el panel abierto, ve las líneas/chats nuevos sin F5 ni logout.
5. A, con el panel abierto, deja de verlas sin F5 ni logout; si tenía un hilo de esas líneas, se cierra.
6. No-admin no tiene el control de traspaso.
