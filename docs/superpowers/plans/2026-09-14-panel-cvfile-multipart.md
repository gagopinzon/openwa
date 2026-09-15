# Panel cvFile multipart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alinear Msg con la API de Panel: enviar el CV como `cvFile` multipart (≤10 MB), `cvUrl` solo si el PDF pesa más, y cachear disponibilidad 90 s con `skipCache` al confirmar/reagendar.

**Architecture:** `panelCvDelivery` decide `file` vs `url`. `panelMsgClient.crearReunion` arma `FormData` o JSON. Callers reusan `cvFieldsFromDelivery`. `getDisponibilidad` cachea 90 s; confirm y reagendar piden fresco.

**Tech Stack:** Node.js, axios, `FormData`/`Blob` nativos, `node:test`.

## Global Constraints

- No paquete `form-data`.
- No enviar `cvBase64`.
- No enviar `urlReunion` al crear.
- `PANEL_CV_MAX_FILE_BYTES` default `10485760`.
- Cache disponibilidad 90 s; `skipCache` no lee ni escribe.
- PATCH: `vendedorId` opcional.

---

### Task 1: Delivery file / url

**Files:**
- Modify: `panelCvDelivery.js`
- Test: `tests/panelCvDelivery.test.js`

- [ ] Tests: file ≤10 MB aunque haya `CV_PUBLIC_URL`; >límite + URL → `url`; >límite sin URL → 413; sin archivo → 404; sin `cvBase64`.
- [ ] Implementar `resolvePanelCvDelivery` y `cvFieldsFromDelivery`.

### Task 2: Cliente Panel

**Files:**
- Modify: `panelMsgClient.js`
- Test: `tests/panelMsgClient.test.js`

- [ ] Tests: multipart FormData sin `Content-Type: application/json`; JSON con `cvUrl`; PATCH omite `vendedorId`; cache GET 90 s y `skipCache`.
- [ ] Implementar `crearReunion`, `actualizarReunion`, cache de `getDisponibilidad`.

### Task 3: Callers + skipCache + docs

**Files:**
- Modify: `agendaConfirmService.js`, `server.js`, `agendaAvailability.js`, `agendaRescheduleService.js`, `.env.example`

- [ ] Callers usan `cvFieldsFromDelivery`.
- [ ] Ranking de confirmación y reagendado pasan `skipCache: true`.
- [ ] Comentarios de `.env.example`.
