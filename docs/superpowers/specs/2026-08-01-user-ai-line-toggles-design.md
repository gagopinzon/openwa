# Diseño: IA por línea para usuarios (no admin)

Fecha: 2026-08-01  
Estado: implementado

## Problema

Los usuarios no admin no ven el panel de Auto-respuesta IA. Solo el admin puede activar/desactivar la IA por línea. Se necesita que cada usuario con permiso **control** pueda encender/apagar la IA en sus líneas, y seguir controlándola por contacto, sin editar prompt ni configuración global.

## Decisiones acordadas

- Prompt / reglas / webhooks / switch global: **solo admin**.
- Usuario: activar/desactivar IA **por línea** (solo líneas con `control`).
- Usuario: activar/desactivar IA **por contacto** (ya existe en Conversaciones).
- Switch global “Auto-respuesta activa”: **solo admin** (opción A).
- UI: **panel simplificado** para usuarios (enfoque 1), panel completo para admin.

## Modelo de datos

Sin cambio de esquema. Se reutiliza `data/auto-reply-config.json`:

| Campo | Quién lo cambia | Efecto |
|-------|-----------------|--------|
| `enabled` | Solo admin | Master switch: si es `false`, nadie auto-responde |
| `enabledSessionIds` | Admin (todas) / usuario (merge de sus líneas) | `null` = todas; `string[]` = solo esas logicalSessionId |
| `basePrompt`, `rules` | Solo admin | Instrucciones de la IA |
| `webhookIdsBySession` | Solo admin (activar/desactivar webhooks) | Registro OpenWA |

Por contacto (MongoDB, ya existe): `aiPaused` vía `POST /api/conversations/ai-control`.

### Materialización de `null`

Si `enabledSessionIds === null` (todas) y un usuario hace el primer toggle:

1. Materializar a la lista de **todas** las `logicalSessionId` actuales.
2. Aplicar el enable/disable de la línea pedida.
3. Persistir el array.

Así no se apagan accidentalmente las líneas de otros al pasar de “todas” a “lista explícita”.

## API

### Nuevo: `PATCH /api/auto-reply/sessions`

Auth: usuario autenticado con **control** sobre `sessionId` (o super).

Body:

```json
{ "sessionId": "session1", "enabled": true }
```

Comportamiento:

1. Validar `sessionId` existe en `sessionsStore`.
2. `forbidUnlessControlSessions([sessionId])`.
3. Leer config; si `enabledSessionIds` es `null`, materializar a todas las sesiones.
4. Si `enabled === true`, asegurar `sessionId` en el array; si `false`, quitarlo.
5. Guardar y devolver config pública + estado de esa línea.

No modifica `enabled`, prompt, rules ni webhooks.

### Existentes (sin cambio de rol)

| Endpoint | Rol |
|----------|-----|
| `PUT /api/auto-reply/config` | `requireSuper` |
| `POST /api/auto-reply/activate` | `requireSuper` |
| `POST /api/auto-reply/deactivate` | `requireSuper` |
| `POST /api/auto-reply/test` | `requireSuper` |
| `GET /api/auto-reply/status` | autenticado |
| `GET /api/auto-reply/config` | autenticado |
| `POST /api/conversations/ai-control` | control en la sesión (sin cambio) |

### Respuesta de status/config para UI de usuario

El front de usuario usa `GET /api/auto-reply/status` y filtra en cliente las líneas a las que tiene `control`. Opcional (nice-to-have, no bloqueante): el GET puede incluir solo `enabledSessionIds` relevantes; no es obligatorio si el cliente ya conoce `permissions`.

## Lógica de auto-respuesta (sin cambio conceptual)

Un mensaje dispara respuesta IA solo si:

1. `enabled === true` (global admin), y
2. la línea está permitida en `enabledSessionIds` (`isSessionEnabled`), y
3. el contacto no tiene `aiPaused`, y
4. resto de reglas actuales (conocido en Mongo, no grupo, texto, misma sesión, etc.).

## UI

### Admin (`isSuper`)

Panel actual sin cambios funcionales: switch global, webhooks, prompt, reglas, checkboxes de todas las líneas, prueba, guardar.

### Usuario con al menos una línea `control`

Mostrar `#autoReplyPanel` (hoy oculto si no es super).

Contenido visible:

- Título / descripción breve.
- Badge solo lectura: “Auto-respuesta global: activa | inactiva”.
- Lista de **sus** líneas con switch IA on/off; cada cambio llama a `PATCH /api/auto-reply/sessions` de inmediato.
- Nota: “Para pausar un contacto, ábrelo en Conversaciones”.

Oculto / no renderizado para usuario:

- Switch global `#autoReplyEnabledToggle`
- Botones activar/desactivar webhooks y probar
- Acordeón prompt / reglas / conversaciones en vivo del panel
- Botón “Guardar configuración”

### Usuario solo `view`

Panel IA oculto (igual que hoy).

### Conversaciones

Sin cambio: botón pausar/reactivar IA por contacto si tiene `control` en esa sesión.

## Archivos a tocar (implementación)

- `server.js` — nuevo `PATCH /api/auto-reply/sessions`
- `autoReplyStore.js` — helper `setSessionEnabled(sessionId, enabled)` con materialización de `null`
- `public/app.js` — `applyRoleUi`: mostrar panel a usuarios con control; modo simplificado vs admin
- `public/index.html` — opcional: envolver bloques admin-only con ids/clases para ocultar

## Fuera de alcance

- Prompt/reglas por línea o por usuario.
- Permitir a usuarios gestionar webhooks.
- Cambiar el master switch global desde la cuenta usuario.
- Rediseño visual amplio del panel.

## Criterios de éxito

1. Usuario con control ve el panel simplificado y puede togglear IA en sus líneas.
2. Usuario no puede cambiar prompt, reglas, webhooks ni el switch global (UI + API).
3. Toggle de una línea no altera el estado IA de líneas ajenas.
4. Con global `enabled: false`, ninguna línea responde aunque el usuario las tenga en on.
5. Pausar IA por contacto sigue funcionando como ahora.
6. Admin conserva el panel completo.
