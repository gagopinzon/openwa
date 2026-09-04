# Prospect↔CV Link Guarantee Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tras un envío exitoso, persistir de forma durable teléfono→cvId en el manifesto (y Mongo si hay) para que un reply días después resuelva el mismo CV sin pedirlo.

**Architecture:** Nueva `bindProspectCvLink` en `cvLookup.js` actualiza el manifesto con el teléfono enviado y registra en Mongo vía `recordSuccessfulContact`. El hook de envío en `server.js` la invoca en cada resultado OK.

**Tech Stack:** Node.js, manifesto JSON (`cvFileStore`), Mongo opcional (`contactHistoryStore`), tests `node:test`.

## Global Constraints

- Sin UI de biblioteca/búsqueda de CVs.
- No borrar PDFs ni vaciar manifesto al limpiar mesa.
- Usar el teléfono del contacto **enviado**, no re-parsear el PDF.
- YAGNI: no índice SQLite nuevo; el manifesto es el índice local.

---

## File map

| File | Responsibility |
|------|----------------|
| `cvLookup.js` | `bindProspectCvLink` + actualización manifesto |
| `server.js` | Llamar bind en cada send success |
| `tests/cvLookup.test.js` | Tests del bind y lookup post-archivo |

---

### Task 1: Tests de `bindProspectCvLink`

**Files:**
- Modify: `tests/cvLookup.test.js`

- [ ] **Step 1: Escribir tests que fallen**

Casos:
1. Bind con teléfono + cvId actualiza `telefono` en manifesto y `lookupCvIdFromArchive` lo encuentra con `inWorkspace: false`.
2. Sin `cvId` → `{ ok: false, reason: 'no_cvId' }` y manifesto intacto.
3. `cvId` sin PDF en disco → `{ ok: false, reason: 'missing_pdf' }`.

- [ ] **Step 2: Correr tests y confirmar fallo**

```bash
node --test tests/cvLookup.test.js
```

Expected: fallan por `bindProspectCvLink` indefinido.

- [ ] **Step 3: Implementar `bindProspectCvLink` en `cvLookup.js`**

Firma sugerida:

```js
function bindProspectCvLink(archive, { phone, cvId, name, archivoOriginal }) {
  // returns { ok, reason?, cvs?, cvId? }
}
```

- Normalizar/validar teléfono (rechazar vacío / `No encontrado`).
- Verificar PDF con `getCvFileMeta(cvId)`.
- Patch entrada por `cvId` en `archive` (telefono, nombre opcional).
- Caller persiste con `saveCvsManifest` / `persistCvsData`.

También exportar y, si conviene, helper async que haga disk + `recordSuccessfulContact`.

- [ ] **Step 4: Pasar tests**

```bash
node --test tests/cvLookup.test.js
```

- [ ] **Step 5: Commit** (solo si el usuario lo pide)

---

### Task 2: Cablear bind en el envío (`server.js`)

**Files:**
- Modify: `server.js` (`createMongoRecordHook` / `trackMessageResult`)

- [ ] **Step 1: En cada `row.success`, llamar bind**

- Actualizar `cvsData` en memoria + `persistCvsData()`.
- Luego `recordSuccessfulContact` (como hoy).
- Logs: `bound` / `skipped_no_cvId` / `missing_pdf` / `skipped_bad_phone`.
- En TEST_MODE: igual bind en disco; Mongo sigue omitido si el hook actual lo omite — preferible **siempre** bind en disco aunque TEST_MODE, para no perder el vínculo en pruebas reales.

- [ ] **Step 2: Verificar que filas OpenWA/Android ya traen `cvId`** (ya lo hacen; no cambiar canales salvo gap).

- [ ] **Step 3: Test manual o unit del hook si es extraíble** — opcional; prioridad: tests de Task 1 + smoke mental del path.

- [ ] **Step 4: Commit** (solo si el usuario lo pide)

---

### Task 3: Verificación

- [ ] **Step 1: Correr suite relevante**

```bash
node --test tests/cvLookup.test.js tests/cvFileStore.test.js tests/replyCvPolicy.test.js
```

- [ ] **Step 2: Confirmar criterios del spec**

1. Bind + mesa vacía → lookup OK  
2. Sin cvId → skip  
3. PDF missing → skip  

---

## Done when

- Spec `docs/superpowers/specs/2026-09-04-prospect-cv-link-guarantee-design.md` cumplido.
- Envío OK deja teléfono↔cvId en manifesto aunque `inWorkspace: false`.
- Auto-reply puede resolver por archivo sin depender de la mesa.
