# Confirmed Meeting Reschedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar reuniones confirmadas en Conversaciones y reagendar automáticamente vía PATCH al Panel priorizando el mismo vendedor.

**Architecture:** Extender `agendaPendingStore` + `panelMsgClient.actualizarReunion`; nueva lógica de reagendar en auto-reply; UI de lista confirmadas + badge en cabecera del chat.

**Tech Stack:** Node.js, axios, store JSON `agenda-pending.json`, frontend vanilla en `public/`.

## Global Constraints

- No inventar `panelReunionId`; sin id → no PATCH.
- Preferir mismo `vendedorId`; fallback a otros candidatos del slot.
- Sin cupo a la hora pedida → mensaje + ofrecer alternativas (sin PATCH).
- Español en UI y respuestas al lead.

---

## File map

| File | Responsibility |
|------|----------------|
| `panelMsgClient.js` | `actualizarReunion` PATCH |
| `agendaPendingStore.js` | `findConfirmedByPhone`, `rescheduleConfirmed` |
| `agendaIntent.js` | Detectar intención de mover cita |
| `agendaRescheduleService.js` | Orquestar slot + vendedor + PATCH + update store |
| `autoReplyService.js` | Rama reagendar antes de nueva agenda |
| `server.js` | contact-status + meeting; SSE si aplica |
| `public/index.html` / `app.js` / `style.css` | Lista confirmadas + badge |

---

### Task 1: Store + PATCH client

**Files:** `agendaPendingStore.js`, `panelMsgClient.js`, `tests/agendaPendingStore.test.js` (crear/ampliar), `tests/panelMsgClient.test.js` si existe

- [ ] `findConfirmedByPhone(telefono)`
- [ ] `rescheduleConfirmed(id, patch)` actualiza fecha/horas/vendedor/gerente/label/url opcional
- [ ] `actualizarReunion({ reunionId, gerenteEmail, fecha, horaInicio, horaFin, vendedorId })`
- [ ] Tests unitarios del store; mock axios para PATCH si hay tests de client
- [ ] Commit: `feat(agenda): store confirmed lookup + panel PATCH`

### Task 2: Intent + reschedule service

**Files:** `agendaIntent.js`, `agendaRescheduleService.js`, `tests/agendaIntent.test.js`, `tests/agendaRescheduleService.test.js`

- [ ] `wantsRescheduleMeeting(body)` heurística (mover, cambiar, reagendar, otro día/hora…)
- [ ] Service: dado confirmed + body + slots → match slot | no_match + alternatives | patch success
- [ ] Preferencia vendedor: mismo id primero en candidatos
- [ ] Tests
- [ ] Commit: `feat(agenda): reschedule intent and service`

### Task 3: Wire auto-reply

**Files:** `autoReplyService.js`

- [ ] Si `findConfirmedByPhone` y (wantsReschedule o time choice): llamar service; set replyText/agendaMeta
- [ ] Evitar crear nueva pending si ya hay confirmed en ese flujo
- [ ] Context prompt: cita confirmada existente
- [ ] Commit: `feat(auto-reply): automatic meeting reschedule`

### Task 4: API + UI visibility

**Files:** `server.js`, `public/index.html`, `public/app.js`, `public/style.css`

- [ ] contact-status (o endpoint) incluye `confirmedMeeting` por teléfono
- [ ] Badge en cabecera del thread
- [ ] Lista/sección «Citas confirmadas» (`status=confirmed`)
- [ ] Commit: `feat(ui): show confirmed meetings in conversations`

### Task 5: Verification

- [ ] Correr tests afectados
- [ ] Smoke mental: sin panelReunionId no PATCH; slot vacío ofrece alternativa
