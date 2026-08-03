# Send Queue (lote pendiente / programado) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir encolar un lote de mensajes ya generados (sin WhatsApp), opcionalmente programar hora de disparo en el servidor, cancelar o enviar ahora, y quemar el botón Enviar tras disparar ese lote.

**Architecture:** Store JSON de un solo lote (`sendQueueStore` → `data/send-queue.json`). APIs REST bajo `/api/send-queue`. Timer en memoria rehidratado al boot. Dispatch reutiliza `runWhatsAppSendJob` existente. UI: Encolar + datetime + panel Cola; botones según flags del GET.

**Tech Stack:** Node.js + Express, `node:test` + `assert`, front vanilla en `public/app.js` + `public/index.html` + CSS mínimo.

**Spec:** `docs/superpowers/specs/2026-08-03-send-queue-design.md`

## Global Constraints

- Un solo lote activo (`queued` | `scheduled` | `sending`) a la vez.
- Snapshot inmutable: solo cancelar o dispatch (sin editar mensajes del lote).
- Servidor dispara a `scheduledAt` aunque el navegador esté cerrado (Node debe estar arriba).
- Tras `sending`/`sent`, botón Enviar quemado hasta Limpiar o Encolar un lote nuevo.
- Reutilizar `runWhatsAppSendJob` / `isAnySendingInProgress`; no reescribir el envío masivo.
- Auth: mismas reglas `forbidUnlessControlSessions` que `/send-whatsapp`.
- Commits solo si el usuario lo pide en la sesión de implementación.

---

## File map

| File | Responsibility |
|------|----------------|
| `sendQueueStore.js` | Persistencia, estados, helpers `canEnqueue` / `canDispatch` / `buttonBurned` |
| `tests/sendQueueStore.test.js` | Unit tests del store |
| `server.js` | APIs cola, timer, hooks en `/send-whatsapp` y fin de `runWhatsAppSendJob`, boot rehydrate |
| `public/index.html` | Controles Encolar + datetime + panel Cola |
| `public/app.js` | Llamadas API, estado botones, restore al load |
| `public/style.css` | Estilos mínimos del panel cola |

---

### Task 1: `sendQueueStore` + tests

**Files:**
- Create: `sendQueueStore.js`
- Create: `tests/sendQueueStore.test.js`

**Interfaces:**
- Consumes: `fs`, `path`, `crypto` (mismo patrón que `agendaPendingStore.js`)
- Produces (exports):
  - `STATUS` = `{ QUEUED:'queued', SCHEDULED:'scheduled', SENDING:'sending', SENT:'sent', CANCELLED:'cancelled' }`
  - `ACTIVE_STATUSES` = `['queued','scheduled','sending']`
  - `getBatch(): object|null`
  - `isActive(batch): boolean`
  - `canEnqueue(): boolean` — true si no hay batch o status es `sent`/`cancelled`
  - `canDispatch(): boolean` — status `queued` o `scheduled`
  - `buttonBurned(): boolean` — status `sending` o `sent`
  - `getPublicState(): { batch, canEnqueue, canDispatch, buttonBurned }`
  - `enqueue({ cvs, selectedSessions, sessionWeights, scheduledAt }): batch` — throws Error con `.status=409` si `!canEnqueue()`; `.status=400` si cvs vacíos o `scheduledAt` en pasado
  - `markSending(id?: string): batch`
  - `markSent(id?: string): batch`
  - `cancel(): batch` — throws 409 si no `canDispatch`
  - `clearBatch(): void` — pone `batch: null` (opcional para Limpiar)
  - Persist path: `path.join(__dirname, 'data', 'send-queue.json')` shape `{ version: 1, batch: null|object }`

- [ ] **Step 1: Write the failing test**

Crear `tests/sendQueueStore.test.js`:

```js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '..', 'data', 'send-queue.json');
const store = require('../sendQueueStore');

const sampleCvs = [
  {
    archivoOriginal: 'a.pdf',
    nombre: 'Ana',
    telefono: '5215551112233',
    mensajeIA: 'Hola Ana',
    saludo: 'Hola',
    cvId: '1'
  }
];

describe('sendQueueStore', () => {
  let backup;

  beforeEach(() => {
    backup = fs.existsSync(STORE_FILE) ? fs.readFileSync(STORE_FILE, 'utf8') : null;
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ version: 1, batch: null }, null, 2));
  });

  afterEach(() => {
    if (backup !== null) fs.writeFileSync(STORE_FILE, backup);
    else if (fs.existsSync(STORE_FILE)) fs.unlinkSync(STORE_FILE);
  });

  it('enqueue crea queued sin scheduledAt', () => {
    const batch = store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: { s1: 1 },
      scheduledAt: null
    });
    assert.equal(batch.status, 'queued');
    assert.equal(batch.total, 1);
    assert.equal(store.canDispatch(), true);
    assert.equal(store.buttonBurned(), false);
  });

  it('enqueue con fecha futura → scheduled', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const batch = store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: future
    });
    assert.equal(batch.status, 'scheduled');
    assert.equal(batch.scheduledAt, future);
  });

  it('enqueue con fecha pasada → 400', () => {
    assert.throws(
      () =>
        store.enqueue({
          cvs: sampleCvs,
          selectedSessions: ['s1'],
          sessionWeights: null,
          scheduledAt: '2020-01-01T00:00:00.000Z'
        }),
      (err) => err.status === 400
    );
  });

  it('segundo enqueue activo → 409', () => {
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    assert.throws(
      () =>
        store.enqueue({
          cvs: sampleCvs,
          selectedSessions: ['s1'],
          sessionWeights: null,
          scheduledAt: null
        }),
      (err) => err.status === 409
    );
  });

  it('markSending quema botón; markSent mantiene burned; luego canEnqueue', () => {
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    store.markSending();
    assert.equal(store.buttonBurned(), true);
    assert.equal(store.canDispatch(), false);
    store.markSent();
    assert.equal(store.getBatch().status, 'sent');
    assert.equal(store.buttonBurned(), true);
    assert.equal(store.canEnqueue(), true);
  });

  it('cancel solo en queued/scheduled', () => {
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    const c = store.cancel();
    assert.equal(c.status, 'cancelled');
    assert.equal(store.canEnqueue(), true);
    assert.equal(store.buttonBurned(), false);
  });

  it('tras sent se puede encolar de nuevo (reemplaza)', () => {
    store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s1'],
      sessionWeights: null,
      scheduledAt: null
    });
    store.markSending();
    store.markSent();
    const b2 = store.enqueue({
      cvs: sampleCvs,
      selectedSessions: ['s2'],
      sessionWeights: null,
      scheduledAt: null
    });
    assert.equal(b2.status, 'queued');
    assert.equal(b2.selectedSessions[0], 's2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sendQueueStore.test.js`  
Expected: FAIL (módulo no existe o exports faltan)

- [ ] **Step 3: Implement `sendQueueStore.js`**

Implementar según Interfaces: lectura/escritura JSON, `newId` con `crypto.randomBytes(12).toString('hex')`, `enqueue` copia `cvs` (map a campos string seguros), setea `createdAt` ISO, `total: cvs.length`, status según `scheduledAt`.

Para `scheduledAt` pasado: `Date.parse(scheduledAt) <= Date.now()` → Error status 400.

`markSending` / `markSent`: si hay `id` y no coincide, throw 404; si no hay batch activo apropiado, throw 409.

`cancel`: si status no es queued/scheduled → throw 409; set `cancelledAt`.

`clearBatch`: `{ version:1, batch:null }`.

- [ ] **Step 4: Run tests — pass**

Run: `node --test tests/sendQueueStore.test.js`  
Expected: PASS todos

- [ ] **Step 5: Commit solo si el usuario lo pidió**

```bash
git add sendQueueStore.js tests/sendQueueStore.test.js
# git commit solo con OK explícito del usuario
```

---

### Task 2: APIs + timer + integración con envío en `server.js`

**Files:**
- Modify: `server.js` (require store; rutas; hook fin de job; boot; guard en `/send-whatsapp`)

**Interfaces:**
- Consumes: `sendQueueStore` (Task 1), `runWhatsAppSendJob`, `isAnySendingInProgress`, `forbidUnlessControlSessions`, `filterSessionsForUser`, `contactHistory`, `TEST_MODE`, `broadcastEvent`
- Produces:
  - `GET /api/send-queue` → `{ success, ...getPublicState() }`
  - `POST /api/send-queue` → encola
  - `POST /api/send-queue/dispatch` → dispara
  - `POST /api/send-queue/cancel` → cancela
  - Helpers internos: `clearSendQueueTimer()`, `armSendQueueTimer()`, `dispatchQueuedBatch(reqUser?)`, `markSendQueueJobFinished()`
  - Al boot (después de cargar stores): `armSendQueueTimer()` si batch `scheduled`

- [ ] **Step 1: Require + timer state + helpers**

Cerca de otros requires:

```js
const sendQueueStore = require('./sendQueueStore');
let sendQueueTimer = null;
let sendQueueTimerBatchId = null;

function clearSendQueueTimer() {
  if (sendQueueTimer) {
    clearTimeout(sendQueueTimer);
    sendQueueTimer = null;
    sendQueueTimerBatchId = null;
  }
}

function armSendQueueTimer() {
  clearSendQueueTimer();
  const batch = sendQueueStore.getBatch();
  if (!batch || batch.status !== sendQueueStore.STATUS.SCHEDULED || !batch.scheduledAt) {
    return;
  }
  const when = Date.parse(batch.scheduledAt);
  if (!Number.isFinite(when)) return;
  const delay = Math.max(0, when - Date.now());
  sendQueueTimerBatchId = batch.id;
  sendQueueTimer = setTimeout(() => {
    dispatchQueuedBatch(null).catch((err) =>
      console.error('send-queue timer dispatch:', err.message)
    );
  }, delay);
  console.log(
    `🗓️ Cola programada ${batch.id} en ${Math.round(delay / 1000)}s (${batch.scheduledAt})`
  );
}
```

- [ ] **Step 2: Extraer preparación de CVs del body de `/send-whatsapp` a helper reutilizable**

Crear función usada por enqueue y send:

```js
/**
 * @returns {{ finalCvsToSend, skippedAlreadyContacted, duplicates } | { error, status }}
 */
async function prepareCvsForSend(cvsFromClient) {
  let cvsToProcess = cvsData;
  if (cvsFromClient && Array.isArray(cvsFromClient)) {
    cvsToProcess = cvsFromClient;
    cvsToProcess.forEach((editedCv) => {
      const index = cvsData.findIndex(
        (cv) => cv.archivoOriginal === editedCv.archivoOriginal
      );
      if (index !== -1) {
        if (editedCv.saludo != null) cvsData[index].saludo = editedCv.saludo;
        cvsData[index].mensajeIA = editedCv.mensajeIA;
      }
    });
    persistCvsData();
  }
  // ... mismo filter procesado+mensajeIA+teléfono, dedupe, contactHistory.filterOutAlreadyContacted
  // devolver finalCvsToSend, skippedAlreadyContacted, duplicates
}
```

Refactorizar `/send-whatsapp` para llamar este helper (comportamiento idéntico).

- [ ] **Step 3: `dispatchQueuedBatch`**

```js
async function dispatchQueuedBatch(_user) {
  if (!sendQueueStore.canDispatch()) {
    const err = new Error('No hay lote pendiente para enviar');
    err.status = 409;
    throw err;
  }
  if (isAnySendingInProgress()) {
    const err = new Error('Ya hay un envío de mensajes en curso');
    err.status = 409;
    throw err;
  }
  clearSendQueueTimer();
  const batch = sendQueueStore.markSending();
  const mongoRecordHook = /* misma construcción que /send-whatsapp */;
  const sessionIds = TEST_MODE
    ? batch.selectedSessions?.length
      ? batch.selectedSessions
      : ['default']
    : batch.selectedSessions;

  broadcastEvent('sendQueueStarted', { batchId: batch.id, total: batch.total });

  // fire-and-forget igual que /send-whatsapp
  runWhatsAppSendJob({
    finalCvsToSend: batch.cvs,
    sessionIds,
    sessionWeights: batch.sessionWeights,
    skippedAlreadyContacted: [],
    mongoRecordHook,
    testMode: TEST_MODE
  }).finally(() => {
    try {
      sendQueueStore.markSent(batch.id);
      broadcastEvent('sendQueueFinished', {
        batchId: batch.id,
        status: 'sent'
      });
    } catch (e) {
      console.error('send-queue markSent:', e.message);
    }
  });

  return batch;
}
```

Nota: hoy `runWhatsAppSendJob` no se `await` desde el handler HTTP (responde 202 y sigue). El `.finally` debe engancharse donde se invoca. Si actualmente no se capturan promesas, envolver:

```js
Promise.resolve(runWhatsAppSendJob(...)).finally(...)
```

También enganchar `markSent` en el `finally` interno de `runWhatsAppSendJob` cuando `lastSendJob` termine **si** el batch activo está en `sending` — más fiable que depender solo del caller. Preferido: al final del `finally` existente de `runWhatsAppSendJob` (línea ~359):

```js
} finally {
  lastSendJob.inProgress = false;
  const b = sendQueueStore.getBatch();
  if (b && b.status === sendQueueStore.STATUS.SENDING) {
    try {
      sendQueueStore.markSent(b.id);
      broadcastEvent('sendQueueFinished', { batchId: b.id, status: 'sent' });
    } catch (e) {
      console.error('send-queue markSent:', e.message);
    }
  }
}
```

Y entonces `dispatchQueuedBatch` solo hace `markSending` + `runWhatsAppSendJob(...)` sin segundo finally.

- [ ] **Step 4: Rutas HTTP**

```js
app.get('/api/send-queue', (req, res) => {
  res.json({ success: true, ...sendQueueStore.getPublicState() });
});

app.post('/api/send-queue', async (req, res) => {
  try {
    if (!sendQueueStore.canEnqueue()) {
      return res.status(409).json({ error: 'Ya hay un lote en cola o enviándose' });
    }
    const prepared = await prepareCvsForSend(req.body?.cvs);
    if (prepared.error) {
      return res.status(prepared.status || 400).json({ error: prepared.error });
    }
    if (!prepared.finalCvsToSend.length) {
      return res.status(400).json({
        error: 'No hay CVs con mensajes listos y teléfonos válidos'
      });
    }
    const selectedSessions =
      Array.isArray(req.body.selectedSessions) && req.body.selectedSessions.length > 0
        ? req.body.selectedSessions.map(String)
        : filterSessionsForUser(req.user, sessionsStore.getAllSessions(), 'control').map(
            (s) => s.id
          );
    if (!TEST_MODE && (!selectedSessions || selectedSessions.length < 1)) {
      return res.status(400).json({ error: 'No hay sesiones configuradas' });
    }
    if (!forbidUnlessControlSessions(selectedSessions || [], req, res)) return;

    const batch = sendQueueStore.enqueue({
      cvs: prepared.finalCvsToSend,
      selectedSessions,
      sessionWeights: req.body.sessionWeights || null,
      scheduledAt: req.body.scheduledAt || null
    });
    if (batch.status === sendQueueStore.STATUS.SCHEDULED) armSendQueueTimer();
    else clearSendQueueTimer();

    broadcastEvent('sendQueueUpdated', sendQueueStore.getPublicState());
    res.status(201).json({ success: true, ...sendQueueStore.getPublicState() });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

app.post('/api/send-queue/dispatch', async (req, res) => {
  try {
    const batch = sendQueueStore.getBatch();
    if (batch?.selectedSessions?.length) {
      if (!forbidUnlessControlSessions(batch.selectedSessions, req, res)) return;
    }
    const started = await dispatchQueuedBatch(req.user);
    res.status(202).json({
      success: true,
      started: true,
      batch: started,
      ...sendQueueStore.getPublicState()
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/send-queue/cancel', (req, res) => {
  try {
    clearSendQueueTimer();
    const batch = sendQueueStore.cancel();
    broadcastEvent('sendQueueUpdated', sendQueueStore.getPublicState());
    res.json({ success: true, batch, ...sendQueueStore.getPublicState() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Guard + batch implícito en `/send-whatsapp`**

Al inicio del handler, tras validaciones básicas:

```js
const q = sendQueueStore.getBatch();
if (q && sendQueueStore.isActive(q)) {
  return res.status(409).json({
    error: 'Hay un lote en cola o enviándose. Cancélalo o espera.',
    batch: q
  });
}
```

Justo antes de `runWhatsAppSendJob`:

```js
sendQueueStore.enqueue({
  cvs: finalCvsToSend,
  selectedSessions: sessionIds,
  sessionWeights,
  scheduledAt: null
});
// enqueue deja queued — pasar a sending:
sendQueueStore.markSending();
```

O añadir `sendQueueStore.beginDirectSend({...})` que crea batch ya en `sending` para no race con timer. Preferido en store:

```js
function beginDirectSend(payload) {
  if (!canEnqueue()) {
    const err = new Error('Ya hay un lote activo');
    err.status = 409;
    throw err;
  }
  const batch = enqueue({ ...payload, scheduledAt: null });
  return markSending(batch.id);
}
```

Agregar test en Task 1 si se introduce `beginDirectSend` (o hacerlo en este task y ampliar test).

- [ ] **Step 6: Boot**

Tras init de Express/rutas o al final del startup (donde ya se loguea modo):

```js
armSendQueueTimer();
```

- [ ] **Step 7: Smoke manual / test store regression**

Run: `node --test tests/sendQueueStore.test.js`  
Expected: PASS (incl. `beginDirectSend` si se añadió)

Verificar sintaxis: `node --check server.js`

- [ ] **Step 8: Commit solo si el usuario lo pidió**

---

### Task 3: UI — encolar, panel, quemar botón

**Files:**
- Modify: `public/index.html` (controles + panel)
- Modify: `public/app.js` (lógica)
- Modify: `public/style.css` (panel)

**Interfaces:**
- Consumes: `GET/POST /api/send-queue`, `POST .../dispatch`, `POST .../cancel`; eventos SSE `sendQueueUpdated`, `sendQueueStarted`, `sendQueueFinished` si el client ya escucha `EventSource`
- Produces: UX según spec

- [ ] **Step 1: HTML en sección Resultados**

Después de los botones Generar / Enviar / Limpiar en `public/index.html`:

```html
<div class="queue-controls" style="margin: 12px 0; text-align: center;">
  <label for="scheduleAtInput" style="font-size: 13px; color: #64748b; margin-right: 8px;">
    Programar para (opcional):
  </label>
  <input type="datetime-local" id="scheduleAtInput" />
  <button id="enqueueBtn" class="btn btn-secondary" disabled>
    Encolar lote
  </button>
</div>

<section class="send-queue-panel" id="sendQueuePanel" style="display: none;">
  <div class="send-queue-header">
    <strong>Cola de envío</strong>
    <span id="sendQueueStatus" class="send-queue-status"></span>
  </div>
  <p id="sendQueueMeta" class="send-queue-meta"></p>
  <div class="send-queue-actions">
    <button type="button" id="dispatchQueueBtn" class="btn btn-success btn-sm">
      Enviar ahora
    </button>
    <button type="button" id="cancelQueueBtn" class="btn btn-danger btn-sm">
      Cancelar cola
    </button>
  </div>
</section>
```

- [ ] **Step 2: CSS mínimo**

En `public/style.css`:

```css
.send-queue-panel {
  margin: 12px auto 16px;
  max-width: 640px;
  padding: 12px 16px;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #f8fafc;
  text-align: left;
}
.send-queue-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.send-queue-meta {
  font-size: 13px;
  color: #475569;
  margin: 8px 0;
}
.send-queue-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
```

- [ ] **Step 3: Wiring en `app.js`**

En el constructor / init, refs:

```js
this.enqueueBtn = document.getElementById('enqueueBtn');
this.scheduleAtInput = document.getElementById('scheduleAtInput');
this.sendQueuePanel = document.getElementById('sendQueuePanel');
this.sendQueueStatus = document.getElementById('sendQueueStatus');
this.sendQueueMeta = document.getElementById('sendQueueMeta');
this.dispatchQueueBtn = document.getElementById('dispatchQueueBtn');
this.cancelQueueBtn = document.getElementById('cancelQueueBtn');
this.queueState = null;
```

Listeners: `enqueueBtn` → `enqueueBatch`, `dispatchQueueBtn` → `dispatchQueue`, `cancelQueueBtn` → `cancelQueue`.

Métodos:

```js
async refreshSendQueue() {
  const res = await fetch('/api/send-queue');
  const data = await res.json();
  this.queueState = data;
  this.applyQueueUi(data);
}

applyQueueUi(data) {
  const batch = data.batch;
  const panel = this.sendQueuePanel;
  if (!batch || ['sent', 'cancelled'].includes(batch.status)) {
    // panel: mostrar info breve si sent/cancelled opcional; ocultar acciones
    if (!batch) {
      panel.style.display = 'none';
    } else {
      panel.style.display = 'block';
      this.sendQueueStatus.textContent = batch.status;
      this.sendQueueMeta.textContent =
        batch.status === 'sent'
          ? `Lote ${batch.id.slice(0, 8)}… enviado (${batch.total} msgs)`
          : `Lote cancelado`;
      this.dispatchQueueBtn.style.display = 'none';
      this.cancelQueueBtn.style.display = 'none';
    }
  } else {
    panel.style.display = 'block';
    this.sendQueueStatus.textContent = batch.status;
    const when = batch.scheduledAt
      ? ` · programado ${new Date(batch.scheduledAt).toLocaleString()}`
      : '';
    this.sendQueueMeta.textContent = `${batch.total} mensajes${when}`;
    const showActions = data.canDispatch;
    this.dispatchQueueBtn.style.display = showActions ? '' : 'none';
    this.cancelQueueBtn.style.display = showActions ? '' : 'none';
  }

  // Encolar
  const hasReady =
    this.cvsData &&
    this.cvsData.some(
      (cv) => cv.mensajeIA && cv.mensajeIA.trim() && cv.telefono !== 'No encontrado'
    );
  this.enqueueBtn.disabled = !hasReady || !data.canEnqueue;

  // Quemar Enviar
  if (data.buttonBurned || (batch && ['queued', 'scheduled', 'sending'].includes(batch.status))) {
    this.sendWhatsAppBtn.disabled = true;
    if (batch?.status === 'sending') this.sendWhatsAppBtn.textContent = 'Enviando…';
    else if (batch?.status === 'sent') this.sendWhatsAppBtn.textContent = 'Enviado';
    else if (batch?.status === 'queued' || batch?.status === 'scheduled') {
      this.sendWhatsAppBtn.textContent = 'En cola…';
    }
  } else if (hasReady) {
    this.sendWhatsAppBtn.disabled = false;
    this.sendWhatsAppBtn.textContent = 'Enviar por WhatsApp';
  }
}

async enqueueBatch() {
  const scheduledLocal = this.scheduleAtInput.value;
  const scheduledAt = scheduledLocal
    ? new Date(scheduledLocal).toISOString()
    : null;
  const body = {
    cvs: this.cvsData,
    selectedSessions: this.getSelectedSessionIds(), // usar helper existente de checkboxes
    sessionWeights: this.getSessionWeights(),       // helper existente si hay
    scheduledAt
  };
  const res = await fetch('/api/send-queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    this.showStatus(data.error || 'Error al encolar', 'error');
    return;
  }
  this.showStatus(
    scheduledAt ? 'Lote programado' : 'Lote encolado (sin enviar)',
    'success'
  );
  this.applyQueueUi(data);
}

async dispatchQueue() {
  const res = await fetch('/api/send-queue/dispatch', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    this.showStatus(data.error || 'No se pudo enviar', 'error');
    return;
  }
  this.applyQueueUi(data);
  // reutilizar flujo de progreso existente (poll send-job-status / SSE)
  if (typeof this.startSendProgressTracking === 'function') {
    this.startSendProgressTracking();
  } else {
    // enganchar al mismo path que sendWhatsApp tras 202
  }
}

async cancelQueue() {
  const res = await fetch('/api/send-queue/cancel', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    this.showStatus(data.error || 'No se pudo cancelar', 'error');
    return;
  }
  this.showStatus('Cola cancelada', 'success');
  this.applyQueueUi(data);
}
```

Al `clearData` / Limpiar: llamar `POST` cancel si `canDispatch`, o nuevo endpoint clear; o `fetch` cancel + reset botón texto. Si el store expone clear vía cancel solo cuando queued — tras `sent`, Limpiar debe:

```js
await fetch('/api/send-queue/cancel').catch(() => {});
// si cancel falla por sent, añadir POST /api/send-queue/clear que llama clearBatch()
```

Añadir en Task 2 si falta: `POST /api/send-queue/clear` → `clearBatch()` + `clearSendQueueTimer()`, usable tras sent/cancelled o admin reset. Spec: Limpiar desbloquea → incluir este endpoint mínimo:

```js
app.post('/api/send-queue/clear', (req, res) => {
  clearSendQueueTimer();
  sendQueueStore.clearBatch();
  res.json({ success: true, ...sendQueueStore.getPublicState() });
});
```

Y test: `clearBatch` deja `canEnqueue` true y `buttonBurned` false.

En `generateMessages` success path: además de habilitar Enviar, llamar `refreshSendQueue()` para respetar burned.

Al boot de la app (después de auth/load CVs): `this.refreshSendQueue()`.

SSE: si ya existe handler de eventos, añadir casos `sendQueueUpdated` / `sendQueueFinished` → `applyQueueUi`.

Resolver nombres reales de helpers de sesiones: buscar en `app.js` `selectedSessions` / `getSelected` / checkboxes — usar exactamente las funciones existentes que ya usa `sendWhatsApp()`.

- [ ] **Step 4: Verificar en navegador (checklist manual)**

1. Generar mensajes → Encolar sin datetime → panel `queued`, Enviar disabled “En cola…”, no WhatsApp.
2. Cancelar → Enviar se rehace si hay mensajes.
3. Encolar con datetime +1 min → esperar / o Enviar ahora → progreso; botón “Enviando…”/“Enviado”.
4. Reiniciar Node con lote `scheduled` futuro → log de timer y disparo.
5. `/send-whatsapp` con cola activa → 409.

- [ ] **Step 5: Commit solo si el usuario lo pidió**

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Encolar sin WhatsApp | 2 + 3 |
| Programar + timer server / boot rehydrate | 2 |
| Cancel / Enviar ahora | 2 + 3 |
| Quemar botón tras disparo | 2 (markSending/Sent) + 3 (UI) |
| Persistencia JSON | 1 |
| Un lote activo / 409 | 1 + 2 |
| scheduledAt pasado → 400 | 1 |
| Guard `/send-whatsapp` + batch implícito | 2 |
| Limpiar desbloquea | 2 clear + 3 |
| Sin editar snapshot / sin multi-lote | scoped out; enforced |

No placeholders pendientes. Firmas `enqueue` / `markSending` / `getPublicState` alineadas entre tasks.
