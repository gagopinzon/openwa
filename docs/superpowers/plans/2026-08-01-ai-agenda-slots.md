# IA Agenda Slots + Citas Pendientes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la IA ofrezca horarios reales agregados de todos los gerentes y, al elegir el lead, cree una cita pendiente en Msg para que un humano asigne vendedor + liga y confirme por WhatsApp.

**Architecture:** Módulo `agendaAvailability` agrega `getDisponibilidad` de todos los `gerenteEmail`. `agendaIntent` detecta día/slot en el mensaje. `autoReplyService` inyecta slots al prompt y crea pendientes. Store JSON + APIs `/api/agenda/*` + UI “Citas por confirmar”.

**Tech Stack:** Node.js + Express, `node --test`, front vanilla en `public/`.

**Spec:** `docs/superpowers/specs/2026-08-01-ai-agenda-slots-design.md`

## Global Constraints

- Fase 1: ofrecer horarios sin nombres de vendedor; no crear reunión aún.
- Fase 2: pendiente → humano confirma vendedor + `urlReunion` → `crearReunion` + WhatsApp.
- Disponibilidad = unión de todos los `gerenteEmail` de usuarios + `MSG_GERENTE_EMAIL` / super profile.
- Sin CV ligado → no crear pendiente automática.
- Commits solo si el usuario lo pide.

---

## File map

| File | Responsibility |
|------|----------------|
| `agendaAvailability.js` | Emails de gerentes, merge de slots, fetch agregado |
| `agendaIntent.js` | Detectar intención, rango de fechas, match de slot elegido |
| `agendaOfferStore.js` | Últimos slots ofrecidos por teléfono (TTL) |
| `agendaPendingStore.js` | CRUD citas `pending_link` / `confirmed` / `cancelled` |
| `tests/agendaAvailability.test.js` | Merge + keys únicos |
| `tests/agendaIntent.test.js` | “mañana”, match hora |
| `autoReplyService.js` | Usar agenda en webhook |
| `aiService.js` | Bloque `agendaContext` en prompt |
| `server.js` | Rutas `/api/agenda/*` |
| `public/index.html` + `app.js` + `style.css` | UI pendientes |

---

### Task 1: Merge de slots puros

**Files:**
- Create: `agendaAvailability.js`
- Create: `tests/agendaAvailability.test.js`

**Produces:**
- `slotKey(fecha, horaInicio, horaFin): string`
- `mergePanelDisponibilidad(responses: Array<{gerenteEmail, data}>): { slots, gerentesConsultados, erroresGerente }`
- `collectGerenteEmails({ users, superEmail, envEmail }): string[]`
- `formatSlotLabel(slot): string`
- `getAggregatedSlots({ fechaInicio, fechaFin, getDisponibilidad, listEmails }): Promise<...>`

- [ ] Test merge: dos gerentes mismo horario → 1 slot, 2 candidates
- [ ] Implementar + pasar tests

### Task 2: Intent + offers

**Files:**
- Create: `agendaIntent.js`, `agendaOfferStore.js`
- Create: `tests/agendaIntent.test.js`

**Produces:**
- `looksLikeScheduleIntent(text): boolean`
- `resolveDateRangeFromMessage(text, now?): { fechaInicio, fechaFin } | null`
- `matchSlotFromMessage(text, slots): slot | null`
- `rememberOffer(phone, slots)` / `getOffer(phone)`

### Task 3: API slots + wire IA (Fase 1)

**Files:** Modify `server.js`, `aiService.js`, `autoReplyService.js`

- `GET /api/agenda/slots?fechaInicio&fechaFin` (auth + control)
- Prompt: si hay `agendaContext`, listar horarios y pedir que elija uno; no inventar
- En webhook: si intent → fetch slots → rememberOffer → generateReply con contexto

### Task 4: Pendientes store + APIs (Fase 2)

**Files:** `agendaPendingStore.js`, `server.js`

- `POST/GET /api/agenda/pending`, `POST .../confirm`, `POST .../cancel`
- Confirm: `crearReunion` + WhatsApp confirmación
- Webhook: si match slot de offer + cvId → create pending + reply “te confirmamos con la liga”

### Task 5: UI Citas por confirmar

**Files:** `public/index.html`, `app.js`, `style.css`

- Sección visible con control/super
- Lista, confirmar (vendedor select + url), cancelar
- Poll o refresh al cargar

---

## Self-review

- Spec Fase 1 ↔ Tasks 1–3
- Spec Fase 2 ↔ Tasks 4–5
- Sin nombres al lead ↔ merge publica solo fecha/hora + label
