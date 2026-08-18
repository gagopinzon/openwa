# Line Handover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El admin traspasa todas las líneas de un vendedor a otro en un clic; ambos paneles se actualizan en vivo por SSE sin recargar.

**Architecture:** `usersStore.transferLines` hace un solo read/write de `users.json`. `POST /api/users/:id/transfer-lines` (requireSuper) llama a esa función y emite `lineAccessChanged`. El Kanban añade un select por columna; los clientes ya conectados a `/events` recargan sesiones y conversaciones.

**Tech Stack:** Node (`usersStore.js`, `server.js`), Vanilla JS (`public/app.js`), CSS, `node:test`.

## Global Constraints

- Solo admin dispara el traspaso.
- Mover, no copiar: el origen pierde las líneas.
- Destino recibe `control` (upgrade desde `view` si aplica).
- Terceros no se tocan.
- Drag Kanban sigue copiando.
- Un write atómico de `users.json`.
- SSE `lineAccessChanged`; no poll de permisos.
- No commits (el repo no usa git aquí; no pedir commit).

## File structure

- Modify: `usersStore.js` — `computeLineTransfer` + `transferLines`
- Modify: `server.js` — POST + `broadcastEvent`
- Modify: `public/app.js` — select Kanban, POST, listener SSE
- Modify: `public/style.css` — select en cabecera de columna
- Create: `tests/usersStore.transferLines.test.js`

---

### Task 1: Store `transferLines`

**Files:**
- Create: `tests/usersStore.transferLines.test.js`
- Modify: `usersStore.js`

**Interfaces:**
- Produces: `computeLineTransfer(fromPermissions, toPermissions) => { fromPermissions, toPermissions, sessionIds }`
- Produces: `transferLines(fromUserId, toUserId) => { from, to, sessionIds, movedCount }`
- Throws: `Error` con mensajes: `El destino debe ser otro usuario`, `Usuario origen no encontrado`, `Usuario destino no encontrado`, `Ese usuario no tiene líneas para pasar`, `Origen y destino son obligatorios`

- [ ] **Step 1: Write failing tests** in `tests/usersStore.transferLines.test.js` (backup/restore `data/users.json`, `createUser` + `updateUser` + `transferLines`).
- [ ] **Step 2: Run tests, confirm they fail** (`node --test tests/usersStore.transferLines.test.js`).
- [ ] **Step 3: Implement `computeLineTransfer` + `transferLines` and export them.**
- [ ] **Step 4: Re-run tests, confirm pass.**

---

### Task 2: API + SSE

**Files:**
- Modify: `server.js` (junto a `PUT /api/users/:id`)

**Interfaces:**
- Consumes: `usersStore.transferLines`
- Produces: `POST /api/users/:id/transfer-lines` body `{ toUserId }`, `requireSuper`
- Produces: `broadcastEvent('lineAccessChanged', { fromUserId, toUserId, sessionIds, movedCount })`

- [ ] **Step 1: Add the route; on success broadcast then JSON `{ success: true, from, to, sessionIds, movedCount }`.**
- [ ] **Step 2: On throw, 400 `{ success: false, error }` like the other user routes.**

---

### Task 3: Kanban UI + live client

**Files:**
- Modify: `public/app.js` (`renderLineUsersList`, `attachKanbanBoardEvents`, `connectToEvents`)
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `POST /api/users/:id/transfer-lines`
- Consumes: SSE `lineAccessChanged`
- Produces: `transferUserLines(fromUserId, toUserId)`
- Produces: `applyLineAccessChange()`

- [ ] **Step 1: Select “Pasar líneas…” in user columns when `assigned.length > 0` and there is another user.**
- [ ] **Step 2: On change, confirm, POST, toast, reset select; errors toast + `loadUsers`.**
- [ ] **Step 3: SSE listener calls `applyLineAccessChange`: auth/status, `loadSessions`, admin `loadUsers`, `applyPermissionUI`, silent conversations refresh, close thread if `getSessionAccess` is null.**
- [ ] **Step 4: CSS for the header select so the column stays 220px-wide.**

## Spec coverage

| Spec | Task |
|------|------|
| UI select + confirm | 3 |
| Store atómico + reglas | 1 |
| POST + SSE | 2 |
| Cliente en vivo + cerrar hilo | 3 |
| Tests store | 1 |
| Drag sin cambio | (no tocar handlers de drop) |
