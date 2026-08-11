# Lines Kanban Users Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox syntax.

**Goal:** Admin panel **Líneas** becomes a Kanban (Sin asignar + columnas por usuario) with drag/drop, permission select, and line-edit modal; inbox dedupe already shipped in same session.

**Architecture:** Front-only rearrange of `renderLineUsersList` + HTML/CSS modal; reuse `setUserLineAccess` and existing session APIs. No schema changes.

**Tech Stack:** Vanilla JS (`public/app.js`), HTML, CSS; HTML5 drag-and-drop.

## Global Constraints

- Multi-user permissions preserved (`view`/`control` per session).
- Default on assign: `control`.
- Drag user→user: add (copy), not move.
- Drag to Sin asignar: remove from source user only.
- No-admin: read-only list (existing simplified cards).

---

### Task 1: Markup modal + copy

- [x] Update `public/index.html`: intro lines panel, accounts text, empty modal `#lineEditModal`.
- [x] Verify modal elements exist in DOM.

### Task 2: CSS Kanban + modal

- [x] Add styles in `public/style.css` for board, columns, pills, drag-over, modal.
- [x] Mobile: horizontal scroll on board.

### Task 3: Rewrite `renderLineUsersList`

- [x] Admin: Kanban columns + pills + DnD + assign/remove.
- [x] Modal open/save wiring for sender/android/outreach/remove.
- [x] No-admin: keep simple line cards.

### Task 4: Inbox dedupe (same session)

- [x] Stable inbox id + store dedupe + orphan webhook cleanup + tests.
