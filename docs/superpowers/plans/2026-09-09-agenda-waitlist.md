# Agenda waitlist Implementation Plan

> **For agentic workers:** Execute inline in this session. TDD. No git (repo no inicializado).

**Goal:** Entender fechas tipo “jueves 17”, no ofrecer esta semana si ese día está vacío, guardar espera y avisar por WhatsApp cada 5 h cuando haya huecos o falten 2 días.

**Architecture:** Extender `agendaIntent` (fechas). Store JSON + `agendaWaitlistService` (tick inyectable). `autoReplyService` encola en vez de ampliar rango. `server.js` arranca el intervalo.

**Tech Stack:** Node.js, `node:test`, JSON en `data/`, OpenWA `sendTextMessage`.

## Global Constraints

- Sondeo: 5 horas (`5 * 60 * 60 * 1000`) + tick al arrancar (delay ~15 s)
- Primer reply: waitlist only, sin horas de esta semana
- `jueves 17` = fecha; `jueves 17:00` = hora
- Un waitlist activo por teléfono
- Nudge vacío solo si al inscribirse faltaban >2 días

---

### Task 1: Parser de fechas de calendario

**Files:** `agendaIntent.js`, `tests/agendaIntent.test.js`

- [ ] Tests: `jueves 17` el 9 sep 2026 → 2026-09-17; `jueves 17:00` → próximo jueves (10); `17 de septiembre`; `el 17` → 17; no extraer hora de `jueves 17`
- [ ] Implementar en `resolveDateRangeFromMessage` **antes** del loop de weekday suelto
- [ ] `shouldOfferSlots('el 17')` true; `shouldOfferSlots('jueves 17')` true

### Task 2: Store JSON

**Files:** Create `agendaWaitlistStore.js`, `tests/agendaWaitlistStore.test.js`

- [ ] `upsertWaiting` (un activo por teléfono), `listWaiting`, `markNotifiedSlots/Empty`, `cancelByPhone`, `expirePast`

### Task 3: Mensajes + tick

**Files:** `agendaMeetMessages.js` (3 builders), `agendaWaitlistService.js`, tests

- [ ] `decideWaitlistAction(entry, { today, slots, pendingFecha, confirmedFecha, createdYmd })` → `expire|booked|offer_slots|empty_nudge|skip`
- [ ] `tickWaitlist(deps)` envía y marca; no doble-envío de slots
- [ ] `enqueuePinnedDayIfEmpty` upsert + texto

### Task 4: Auto-reply + poller + server

**Files:** `autoReplyService.js`, `server.js`, `finalizeAgendaBooking` cancela waitlist (`booked`)

- [ ] Día pineado sin slots → waitlist, no `slots_wider_range`
- [ ] Pending de otro día no bloquea waitlist
- [ ] `startWaitlistPoller` / `stopWaitlistPoller`; server llama al listen
