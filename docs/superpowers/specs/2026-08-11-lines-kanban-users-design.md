# Design: Tablero Kanban de líneas por usuario

**Fecha:** 2026-08-11  
**Estado:** aprobado en conversación (enfoque B — columnas Kanban + pastillas con permiso)

## Problema

El panel **Líneas** organiza por línea y dentro asigna usuarios. Eso dificulta ver “quién lleva qué” y mete configuración técnica (Android, remitente, canal) mezclada con la asignación de gente.

## Objetivo

Para el **admin**, reorganizar la UI de asignación a un **tablero tipo Kanban**:

1. Columna **Sin asignar**: líneas que nadie tiene en `permissions`.
2. Una **columna por usuario**: pastillas de las líneas que controla o ve.
3. Arrastrar pastillas entre columnas **y** botones `+` / `×` (móvil / respaldo).
4. En la pastilla (opción B): chip Android/OpenWA, remitente chiquito y **selector Controlar / Solo ver**.
5. Clic en la pastilla → **modal** para editar remitente, celular Android, canal de primer mensaje y quitar línea.

## Fuera de alcance

- Cambiar el modelo de datos de permisos (`permissions[sessionId] = view|control`).
- Asignación exclusiva (una línea = un solo usuario). Se mantiene multi-usuario.
- Rediseñar envío masivo, Conversaciones, Gateway más allá de no romper el vínculo desde el modal.
- Usuario no-admin: no recibe el Kanban de asignación; sigue viendo solo sus líneas (lectura).

## Decisiones confirmadas

| Tema | Decisión |
|------|----------|
| Layout | Columnas Kanban (sin asignar + usuarios) |
| Pastilla | Opción B: permiso visible/editable en columna de usuario |
| Interacción | Drag & drop + botones |
| Config técnica | Modal al clic |
| Multi-asignación | Misma línea puede aparecer en varias columnas |
| Default al asignar | `control` |
| API | Reutilizar `PUT /api/users/:id` con `permissions` |

## Diseño

### A. Estructura del panel (admin)

Orden vertical en `#linesPanel`:

1. Título + intro corta (“Arrastra líneas a cada usuario”).
2. **Tablero Kanban** (`#lineUsersList` o contenedor nuevo `#linesKanbanBoard`).
3. Formulario agregar líneas OpenWA (picker / importar) — sin cambio de API.
4. Sección Gateway Android (lista dispositivos; el vínculo a línea vive en el modal).
5. **Cuentas** — crear/editar/eliminar usuarios; **sin** asignación aquí (texto actualizado).

### B. Columna “Sin asignar”

- Líneas donde ningún usuario (no-admin) tiene `view` ni `control` en `permissions`.
- Pastilla: label, chip canal (`Android` | `OpenWA`), remitente (o “—”).
- Botón `+ Asignar ▾` → menú/lista de usuarios; asigna con `control`.
- No muestra selector de permiso (aún no hay usuario).
- Drop zone: soltar aquí desde un usuario **quita** el permiso de **ese** usuario (no borra permisos de otros).

### C. Columnas de usuario

- Una columna por cada usuario en `managedUsers` (los que devuelve `GET /api/users`; no hay columna para el super-admin logueado).
- Contador de líneas en el encabezado.
- Drop zone vacía: “Suelta aquí” / “Sin líneas aún”.
- Pastilla asignada:
  - Label + chip Android/OpenWA + remitente.
  - `<select>` Controlar / Solo ver → guarda al cambiar vía `setUserLineAccess`.
  - Botón `×` → quita permiso de ese usuario.
- Drag de “Sin asignar” → usuario: `setUserLineAccess(userId, sessionId, 'control')`.
- Drag entre usuarios: añade permiso en destino; **no** quita del origen (multi), salvo que el UX del drop indique “mover”. **Decisión explícita: copiar/añadir, no mover.** Quitar del origen solo con `×` o arrastrando a Sin asignar **desde esa columna** (el drag identifica `data-user-id` origen).

### D. Modal “Editar línea”

Abre al clic en el cuerpo de la pastilla (no en select/`+`/`×`).

Campos (mismas APIs actuales):

- Remitente + Guardar + ↻ WhatsApp.
- Select celular Android + select primer mensaje (`openwa` | `android`) + Guardar vínculo.
- Nota fija: respuestas / auto-reply siempre OpenWA.
- Botón peligro: Quitar línea (confirmación, `removeSession`).

Cerrar: ×, Cancelar, o clic fuera (opcional). Tras guardar, refrescar pastillas del tablero.

### E. Usuario no-admin

Lista simple de sus líneas (label, badge Control/Solo ver, lectura de canal/Android), sin drag ni modal de edición admin.

### F. Datos y APIs

Sin campos nuevos.

| Acción | API existente |
|--------|----------------|
| Asignar / cambiar / quitar acceso | `PUT /api/users/:id` `{ permissions }` |
| Remitente | endpoints actuales de session sender |
| Android + outreach | endpoints actuales de vínculo por sesión |
| Quitar línea | delete session existente |
| Usuarios CRUD | `/api/users` como hoy |

### G. Front (archivos)

- `public/index.html` — contenedor Kanban, markup del modal.
- `public/app.js` — reemplazar/reescribir `renderLineUsersList` → render del tablero; DnD nativo (HTML5) o equivalente ligero; handlers de modal reutilizando `saveSessionSenderName`, `syncSessionSenderName`, `saveSessionAndroidLink`, `removeSession`, `setUserLineAccess`.
- `public/style.css` — columnas, pastillas, drop highlight, modal.

### H. Criterios de aceptación

1. Admin ve columnas por usuario + Sin asignar; entiende de un vistazo quién tiene qué.
2. Drag y botones asignan/quitan; permiso default `control`.
3. Selector en pastilla cambia `view`/`control` y persiste.
4. Misma línea puede estar en ≥2 usuarios.
5. Línea sin ningún permiso aparece solo en Sin asignar.
6. Modal edita remitente/Android/canal sin perder el resto del panel.
7. No-admin no ve el tablero de asignación.
8. Cuentas ya no dice que la asignación se hace “arriba en cada línea”, sino en el tablero.

## Flujo (asignar)

```
Pastilla (sessionId)
    │ drag/drop o + Asignar
    ▼
setUserLineAccess(userId, sessionId, 'control'|'view'|'')
    │
    ▼
PUT /api/users/:id { permissions }
    │
    ▼
re-render Kanban (permissions locales + managedUsers)
```
