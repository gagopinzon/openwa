# Send Failover Requeue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Si una línea se cae/bloquea o un envío falla de forma recuperable, reencolar el contacto a otra línea viva (round-robin) en lugar de perderlo.

**Architecture:** Mantener colas fijas por sesión al inicio. Añadir un contexto compartido de failover durante el job: health-check, marcar línea muerta, drenar pendientes, reencolar contactos con límite de un intento por línea viva. Clasificar errores (`invalid` / `session_dead` / `transient`).

**Tech Stack:** Node.js, `node:test` + `node:assert/strict`, Express/SSE existentes, OpenWA client.

**Spec:** `docs/superpowers/specs/2026-08-06-send-failover-requeue-design.md`

## Global Constraints

- No reencolar números inválidos / sin WhatsApp.
- Desconexión/ban → matar línea + drenar toda su cola pendiente.
- Errores transient → 1–2 reintentos locales; luego reencolar solo ese contacto.
- Destino: round-robin entre líneas vivas no intentadas aún para ese contacto.
- Un intento por línea viva; si no hay destino → `exhausted_sessions` / `no_healthy_sessions`.
- No emitir `success: false` definitivo hasta agotar reencolados.
- No commits salvo que el usuario lo pida.
- Defaults env: `SEND_FAILOVER_HEALTH_RETRIES=2`, `SEND_FAILOVER_LOCAL_RETRIES=2`, `SEND_FAILOVER_HEALTH_WAIT_MS=3000`.

## File map

| File | Responsibility |
|------|----------------|
| `sendFailover.js` (create) | classify errors, pick next session, requeue/drain helpers, createFailoverContext |
| `openwaWhatsAppService.js` | wire health-check + failover into `sendSessionQueue` / `sendRoundRobinBulk`; surface send errors |
| `openwaClient.js` | widen `isDisconnectError` ban/restrict patterns if needed |
| `server.js` | pass through new progress phases (if any mapping needed) |
| `public/app.js` | UI for `session_dead` / `requeued` / `retrying` |
| `.env.example` | document failover env vars |
| `tests/sendFailover.test.js` | unit tests for helpers |

---

### Task 1: Helpers de clasificación y reencolado

**Files:**
- Create: `sendFailover.js`
- Test: `tests/sendFailover.test.js`

**Interfaces:**
- Produces:
  - `classifySendError(errorOrMessage) → 'invalid' | 'session_dead' | 'transient'`
  - `createFailoverContext(sessionOrder, queues) → context`
  - `pickNextAliveSession(ctx, triedSessionIds) → string|null`
  - `markSessionDead(ctx, sessionId) → void`
  - `requeueContact(ctx, item, fromSessionId) → { ok: true, toSessionId } | { ok: false, reason: 'exhausted_sessions'|'no_healthy_sessions' }`
  - `drainSessionQueue(ctx, sessionId) → Array<{ item, toSessionId } | { item, reason }>`
  - `getFailoverConfig() → { healthRetries, localRetries, healthWaitMs }`

- [ ] **Step 1: Write the failing test**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifySendError,
  createFailoverContext,
  pickNextAliveSession,
  markSessionDead,
  requeueContact,
  drainSessionQueue
} = require('../sendFailover');

describe('classifySendError', () => {
  it('detecta invalid', () => {
    assert.equal(classifySendError('Number is not on WhatsApp'), 'invalid');
    assert.equal(classifySendError('número inválido'), 'invalid');
  });
  it('detecta session_dead', () => {
    assert.equal(classifySendError('Session disconnected'), 'session_dead');
    assert.equal(classifySendError({ status: 409, message: 'conflict' }), 'session_dead');
    assert.equal(classifySendError('account banned'), 'session_dead');
  });
  it('default transient', () => {
    assert.equal(classifySendError('timeout'), 'transient');
    assert.equal(classifySendError('Too Many Requests'), 'transient');
  });
});

describe('requeue round-robin', () => {
  it('reencola a la siguiente viva y marca tried', () => {
    const queues = new Map([
      ['a', [{ contact: { telefono: '1' }, globalIndex: 0 }]],
      ['b', []],
      ['c', []]
    ]);
    const ctx = createFailoverContext(['a', 'b', 'c'], queues);
    const item = queues.get('a').shift();
    const r = requeueContact(ctx, item, 'a');
    assert.equal(r.ok, true);
    assert.equal(r.toSessionId, 'b');
    assert.ok(queues.get('b').some((x) => x.globalIndex === 0));
    assert.ok(item.triedSessionIds.includes('a'));
  });

  it('drena cola de línea muerta en RR', () => {
    const queues = new Map([
      ['a', [
        { contact: { telefono: '1' }, globalIndex: 0 },
        { contact: { telefono: '2' }, globalIndex: 1 }
      ]],
      ['b', []],
      ['c', []]
    ]);
    const ctx = createFailoverContext(['a', 'b', 'c'], queues);
    const moved = drainSessionQueue(ctx, 'a');
    assert.equal(ctx.deadSessionIds.has('a'), true);
    assert.equal(queues.get('a').length, 0);
    assert.equal(moved.length, 2);
    assert.equal(moved[0].toSessionId, 'b');
    assert.equal(moved[1].toSessionId, 'c');
  });

  it('exhausted cuando ya probó todas las vivas', () => {
    const queues = new Map([
      ['a', []],
      ['b', []]
    ]);
    const ctx = createFailoverContext(['a', 'b'], queues);
    const item = {
      contact: { telefono: '1' },
      globalIndex: 0,
      triedSessionIds: ['a', 'b']
    };
    const r = requeueContact(ctx, item, 'a');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'exhausted_sessions');
  });

  it('no_healthy_sessions si todas muertas', () => {
    const queues = new Map([
      ['a', []],
      ['b', []]
    ]);
    const ctx = createFailoverContext(['a', 'b'], queues);
    markSessionDead(ctx, 'a');
    markSessionDead(ctx, 'b');
    const r = requeueContact(ctx, { contact: {}, globalIndex: 0, triedSessionIds: [] }, 'a');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_healthy_sessions');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sendFailover.test.js`  
Expected: FAIL (module not found)

- [ ] **Step 3: Write minimal implementation in `sendFailover.js`**

```js
const { isDisconnectError } = require('./openwaClient');

function getFailoverConfig() {
  const n = (k, d) => {
    const v = parseInt(process.env[k], 10);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    healthRetries: n('SEND_FAILOVER_HEALTH_RETRIES', 2),
    localRetries: n('SEND_FAILOVER_LOCAL_RETRIES', 2),
    healthWaitMs: n('SEND_FAILOVER_HEALTH_WAIT_MS', 3000)
  };
}

function classifySendError(errorOrMessage) {
  const err =
    errorOrMessage && typeof errorOrMessage === 'object'
      ? errorOrMessage
      : { message: String(errorOrMessage || '') };
  const msg = String(err.message || err || '');
  if (/invalid|inválido|not on whatsapp|no está en whatsapp/i.test(msg)) {
    return 'invalid';
  }
  if (
    isDisconnectError(err) ||
    /banned|bannead|restrict|blocked by whatsapp|UNPAIRED|logged out/i.test(msg)
  ) {
    return 'session_dead';
  }
  return 'transient';
}

function createFailoverContext(sessionOrder, queues) {
  return {
    sessionOrder: [...sessionOrder],
    queues,
    aliveSessionIds: new Set(sessionOrder),
    deadSessionIds: new Set(),
    rrCursor: 0
  };
}

function markSessionDead(ctx, sessionId) {
  ctx.aliveSessionIds.delete(sessionId);
  ctx.deadSessionIds.add(sessionId);
}

function pickNextAliveSession(ctx, triedSessionIds = []) {
  const tried = new Set(triedSessionIds || []);
  const order = ctx.sessionOrder;
  if (!order.length) return null;
  for (let i = 0; i < order.length; i++) {
    const idx = (ctx.rrCursor + i) % order.length;
    const id = order[idx];
    if (!ctx.aliveSessionIds.has(id)) continue;
    if (tried.has(id)) continue;
    ctx.rrCursor = (idx + 1) % order.length;
    return id;
  }
  return null;
}

function requeueContact(ctx, item, fromSessionId) {
  if (!item.triedSessionIds) item.triedSessionIds = [];
  if (fromSessionId && !item.triedSessionIds.includes(fromSessionId)) {
    item.triedSessionIds.push(fromSessionId);
  }
  if (ctx.aliveSessionIds.size === 0) {
    return { ok: false, reason: 'no_healthy_sessions' };
  }
  const toSessionId = pickNextAliveSession(ctx, item.triedSessionIds);
  if (!toSessionId) {
    return { ok: false, reason: 'exhausted_sessions' };
  }
  ctx.queues.get(toSessionId).push(item);
  return { ok: true, toSessionId };
}

function drainSessionQueue(ctx, sessionId) {
  markSessionDead(ctx, sessionId);
  const queue = ctx.queues.get(sessionId) || [];
  const pending = queue.splice(0, queue.length);
  const moved = [];
  for (const item of pending) {
    const r = requeueContact(ctx, item, sessionId);
    if (r.ok) moved.push({ item, toSessionId: r.toSessionId });
    else moved.push({ item, reason: r.reason });
  }
  return moved;
}

module.exports = {
  getFailoverConfig,
  classifySendError,
  createFailoverContext,
  markSessionDead,
  pickNextAliveSession,
  requeueContact,
  drainSessionQueue
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sendFailover.test.js`  
Expected: PASS

---

### Task 2: Exponer errores reales en el envío

**Files:**
- Modify: `openwaWhatsAppService.js` (`sendMessage`, `sendContactWithGreeting`)
- Modify: `openwaClient.js` (`isDisconnectError` patterns if missing banned/restricted)

**Interfaces:**
- Consumes: `classifySendError` from `sendFailover.js`
- Produces:
  - `sendMessage` throws or returns `{ ok: false, error, errorClass }` (prefer throw with `error.errorClass` for session_dead / invalid / transient)
  - `sendContactWithGreeting` propaga el mismo error (no tragar a `false` silencioso cuando se usa failover)

- [ ] **Step 1: Write failing test for classify via disconnect patterns used by client**

Extend `tests/sendFailover.test.js`:

```js
it('banned y restricted son session_dead', () => {
  assert.equal(classifySendError('This account is restricted'), 'session_dead');
});
```

- [ ] **Step 2: Run — may already pass if Task 1 patterns cover it; if not, widen `isDisconnectError` / classify**

- [ ] **Step 3: Change `sendMessage` to attach class and rethrow path for callers**

Replace the catch that returns `false` with:

```js
} catch (error) {
  const msg = error.message || String(error);
  const errorClass = classifySendError(error);
  error.errorClass = errorClass;
  if (errorClass === 'invalid') {
    console.log(`Número inválido o sin WhatsApp: ${phone} — ${msg}`);
  } else {
    console.error(`Error enviando mensaje a ${phone}:`, msg);
  }
  throw error;
}
```

Keep a thin wrapper only if single-session `sendBulkMessages` still expects boolean — map there with try/catch. Multi-session path must receive the throw.

- [ ] **Step 4: Smoke `node --check openwaWhatsAppService.js`**

---

### Task 3: Integrar failover en `sendSessionQueue` / `sendRoundRobinBulk`

**Files:**
- Modify: `openwaWhatsAppService.js`

**Interfaces:**
- Consumes: all Task 1 helpers + `getSessionStatus` / `isDisconnectError`
- Produces: `sendRoundRobinBulk` creates failover ctx and passes it into each `sendSessionQueue`

- [ ] **Step 1: Add `ensureSessionHealthy(service, cfg)` in service file**

```js
async function ensureSessionHealthy(service, cfg) {
  const openwaSessionId = service.openwaSessionId;
  let lastStatus = null;
  for (let attempt = 0; attempt <= cfg.healthRetries; attempt++) {
    lastStatus = await getSessionStatus(openwaSessionId);
    if (lastStatus.connected) return { ok: true, status: lastStatus };
    if (attempt < cfg.healthRetries) {
      await new Promise((r) => setTimeout(r, cfg.healthWaitMs));
    }
  }
  return { ok: false, status: lastStatus };
}
```

- [ ] **Step 2: Change queue loop to `while (queueItems.length)` (not fixed for-index) so requeued items appended later are processed**

- [ ] **Step 3: Before each contact, if `failoverCtx.deadSessionIds.has(sessionId)` break**

- [ ] **Step 4: Health-check; on fail call `drainSessionQueue`, emit progress `session_dead` + `requeued` per item, push definitive fails for items with `reason`, then `break`**

- [ ] **Step 5: Local send with retries**

```js
let lastErr = null;
let success = false;
for (let attempt = 0; attempt <= cfg.localRetries; attempt++) {
  try {
    if (attempt > 0 && onProgress) {
      onProgress({ sessionId: logicalSessionId, phase: 'retrying', ... });
    }
    success = await service.sendContactWithGreeting(contact);
    lastErr = null;
    break;
  } catch (error) {
    lastErr = error;
    const cls = error.errorClass || classifySendError(error);
    if (cls === 'invalid') break;
    if (cls === 'session_dead') break;
    if (attempt >= cfg.localRetries) break;
  }
}
```

- [ ] **Step 6: Branch on outcome**
  - success → emit result `success: true` (include `sessionId`)
  - invalid → definitive fail
  - session_dead → put current item back into own queue head OR include in drain; `drainSessionQueue`; progress; break
  - transient after retries → `requeueContact`; if ok emit `phase: 'requeued'` **without** `onMessageResult` fail; if not ok emit definitive fail with reason

- [ ] **Step 7: Wire in `sendRoundRobinBulk`**

```js
const failoverCtx = createFailoverContext(sessionOrder, queues);
// pass failoverCtx into sendSessionQueue
```

- [ ] **Step 8: Write integration-style unit test with stub service**

Create `tests/sendFailover.integration.test.js` that mocks a service:
- session `a` fails with disconnect on first send
- remaining contacts end on `b`/`c`
- assert no definitive fail for requeued contact that later succeeds

Use dependency injection: optional `sendSessionQueue` export for testing, OR test only helpers + a small `processContactFailure` if full queue test is too heavy. Prefer exporting `sendSessionQueue` / a `handleSendFailure` helper if needed.

Minimal acceptable: helper-level coverage from Task 1 + manual checklist; if exporting is easy, add one stubbed queue test.

- [ ] **Step 9: Run `node --test tests/sendFailover.test.js` and `node --check openwaWhatsAppService.js`**

---

### Task 4: UI + env docs

**Files:**
- Modify: `public/app.js` (`updateSessionCard`)
- Modify: `.env.example` (create entries if file exists)

- [ ] **Step 1: Add phases in `updateSessionCard`**

```js
else if (state.phase === 'session_dead') {
  statusText = '⛔ Línea desconectada / bloqueada — reencolando…';
} else if (state.phase === 'requeued') {
  const to = state.requeuedTo ? ` → ${state.requeuedTo}` : '';
  statusText = state.nombre
    ? `↩ Reencolado ${state.nombre}${to}`
    : `↩ Contacto reencolado${to}`;
} else if (state.phase === 'retrying') {
  statusText = 'Reintentando envío…';
}
```

- [ ] **Step 2: Ensure SSE `sessionProgress` handler copies `requeuedTo` / `phase` (already spreads `data.phase`)**

- [ ] **Step 3: Document in `.env.example`:**

```bash
# Failover entre líneas al enviar (opcional)
# SEND_FAILOVER_HEALTH_RETRIES=2
# SEND_FAILOVER_LOCAL_RETRIES=2
# SEND_FAILOVER_HEALTH_WAIT_MS=3000
```

- [ ] **Step 4: Mark spec status to approved/implementing in design doc header**

---

### Task 5: Verificación final

- [ ] **Step 1: Run all existing tests**

Run: `node --test tests/`  
Expected: all PASS

- [ ] **Step 2: Syntax check**

Run: `node --check server.js && node --check openwaWhatsAppService.js && node --check sendFailover.js && node --check public/app.js`

- [ ] **Step 3: Manual checklist (real or TEST_MODE notes)**
  - 3+ líneas, matar una a mitad → pendientes siguen en otras
  - número inválido no salta de línea
  - UI muestra reencolado / línea muerta

---

## Spec coverage self-review

| Spec requirement | Task |
|------------------|------|
| Criterio C classify | Task 1–2 |
| Health + drain cola muerta | Task 3 |
| Round-robin destino | Task 1 + 3 |
| Un intento por línea viva | Task 1 `triedSessionIds` |
| No quemar resultado al reencolar | Task 3 Step 6 |
| Burst completo al reencolar | implícito (reenvía `sendContactWithGreeting`) |
| UI phases | Task 4 |
| Env defaults | Task 1 + 4 |
| Tests | Task 1, 3, 5 |
