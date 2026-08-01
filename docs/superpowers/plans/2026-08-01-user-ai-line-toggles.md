# User AI Line Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que usuarios con permiso `control` activen/desactiven la auto-respuesta IA por línea, sin tocar prompt, reglas, webhooks ni el switch global (solo admin).

**Architecture:** Reutilizar `enabledSessionIds` en `autoReplyStore`. Nuevo helper `setSessionEnabled` materializa `null` → lista completa antes del toggle. Endpoint `PATCH /api/auto-reply/sessions` con `forbidUnlessControlSessions`. UI: panel visible para usuarios con control, modo simplificado (solo switches de sus líneas + badge global read-only).

**Tech Stack:** Node.js + Express (sin framework de tests; scripts `node --test` o `assert` en archivos bajo `scripts/` / `tests/`). Front vanilla JS en `public/app.js` + HTML.

**Spec:** `docs/superpowers/specs/2026-08-01-user-ai-line-toggles-design.md`

## Global Constraints

- Prompt / reglas / webhooks / switch global `enabled`: solo admin (`requireSuper`).
- Usuario solo puede cambiar IA de líneas donde tenga `control`.
- Toggle de una línea no debe apagar/encender líneas ajenas (materializar `null` primero).
- Por contacto (`aiPaused`) ya funciona; no modificar ese flujo salvo verificar que sigue OK.
- No rediseñar el panel admin; solo ocultar bloques admin-only para usuarios.
- Commits solo si el usuario lo pide en la sesión de implementación (preferencia del repo).

---

## File map

| File | Responsibility |
|------|----------------|
| `autoReplyStore.js` | `setSessionEnabled(sessionId, enabled, allSessionIds)` — materializa y persiste |
| `tests/autoReplyStore.sessionEnabled.test.js` | Pruebas unitarias del helper (Node built-in test) |
| `server.js` | `PATCH /api/auto-reply/sessions` |
| `public/index.html` | Wrappers `autoReplyAdminOnly` + badge global read-only |
| `public/app.js` | Mostrar panel a control; modo user vs admin; PATCH al toggle |

---

### Task 1: `setSessionEnabled` en autoReplyStore

**Files:**
- Modify: `autoReplyStore.js`
- Create: `tests/autoReplyStore.sessionEnabled.test.js`

**Interfaces:**
- Consumes: `readConfig`, `writeConfig`, `getPublicConfig`, `normalizeSessionIds` (existentes en el mismo archivo)
- Produces:
  - `setSessionEnabled(sessionId: string, enabled: boolean, allSessionIds: string[]): { config, sessionId, sessionEnabled: boolean }`
  - Exportado en `module.exports`

- [ ] **Step 1: Write the failing test**

Crear `tests/autoReplyStore.sessionEnabled.test.js`:

```js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Aislar DATA_DIR: el store usa path.join(__dirname, 'data').
// Para no tocar data/ real, probar vía require + manipular archivo temporal
// copiando la lógica, O usar el archivo real con backup.
// Enfoque práctico: backup de data/auto-reply-config.json, mutar, restaurar.

const CONFIG = path.join(__dirname, '..', 'data', 'auto-reply-config.json');
const store = require('../autoReplyStore');

describe('setSessionEnabled', () => {
  let backup;

  beforeEach(() => {
    backup = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : null;
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(
      CONFIG,
      JSON.stringify(
        {
          version: 1,
          enabled: true,
          basePrompt: 'test',
          rules: [],
          enabledSessionIds: null,
          webhookIdsBySession: {}
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    if (backup !== null) fs.writeFileSync(CONFIG, backup);
    else if (fs.existsSync(CONFIG)) fs.unlinkSync(CONFIG);
  });

  it('materializa null y desactiva solo la línea pedida', () => {
    const result = store.setSessionEnabled('session2', false, [
      'session1',
      'session2',
      'session3'
    ]);
    assert.deepEqual(result.config.enabledSessionIds.sort(), [
      'session1',
      'session3'
    ]);
    assert.equal(result.sessionEnabled, false);
    assert.equal(store.isSessionEnabled('session1'), true);
    assert.equal(store.isSessionEnabled('session2'), false);
  });

  it('reactiva una línea en lista explícita', () => {
    store.setSessionEnabled('session2', false, ['session1', 'session2']);
    const result = store.setSessionEnabled('session2', true, [
      'session1',
      'session2'
    ]);
    assert.ok(result.config.enabledSessionIds.includes('session2'));
    assert.equal(result.sessionEnabled, true);
  });

  it('no modifica enabled/basePrompt', () => {
    const before = store.getConfig();
    store.setSessionEnabled('session1', false, ['session1', 'session2']);
    const after = store.getConfig();
    assert.equal(after.enabled, before.enabled);
    assert.equal(after.basePrompt, before.basePrompt);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/autoReplyStore.sessionEnabled.test.js`

Expected: FAIL — `store.setSessionEnabled is not a function` (o similar).

- [ ] **Step 3: Implement `setSessionEnabled`**

En `autoReplyStore.js`, añadir antes de `module.exports`:

```js
/**
 * Activa/desactiva IA para una logicalSessionId.
 * Si enabledSessionIds es null (todas), materializa a allSessionIds primero.
 * @param {string} sessionId
 * @param {boolean} enabled
 * @param {string[]} allSessionIds — ids actuales de sessionsStore
 */
function setSessionEnabled(sessionId, enabled, allSessionIds) {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('sessionId es obligatorio');
  if (typeof enabled !== 'boolean') throw new Error('enabled (boolean) es obligatorio');

  const allIds = normalizeSessionIds(allSessionIds) || [];
  if (!allIds.includes(id)) {
    throw new Error(`Sesión desconocida: ${id}`);
  }

  const cfg = readConfig();
  let ids =
    cfg.enabledSessionIds === null || cfg.enabledSessionIds === undefined
      ? [...allIds]
      : normalizeSessionIds(cfg.enabledSessionIds) || [];

  if (enabled) {
    if (!ids.includes(id)) ids.push(id);
  } else {
    ids = ids.filter((x) => x !== id);
  }

  cfg.enabledSessionIds = ids;
  writeConfig(cfg);

  return {
    config: getPublicConfig(),
    sessionId: id,
    sessionEnabled: ids.includes(id)
  };
}
```

Exportar `setSessionEnabled` en `module.exports`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `node --test tests/autoReplyStore.sessionEnabled.test.js`

Expected: PASS (3 tests).

- [ ] **Step 5: Commit (solo si el usuario lo pide)**

```bash
git add autoReplyStore.js tests/autoReplyStore.sessionEnabled.test.js
git commit -m "$(cat <<'EOF'
feat: allow toggling AI enabled state per session in store

EOF
)"
```

---

### Task 2: Endpoint `PATCH /api/auto-reply/sessions`

**Files:**
- Modify: `server.js` (junto a los otros `/api/auto-reply/*`, ~línea 2670–2725)

**Interfaces:**
- Consumes: `autoReplyStore.setSessionEnabled`, `forbidUnlessControlSessions`, `sessionsStore.getAllSessions` / `getSession`
- Produces: HTTP `PATCH /api/auto-reply/sessions` → `{ success, config, sessionId, sessionEnabled }`

- [ ] **Step 1: Add the route**

Insertar después de `app.get('/api/auto-reply/config', ...)` y **antes** de `app.put('/api/auto-reply/config', requireSuper, ...)`:

```js
app.patch('/api/auto-reply/sessions', (req, res) => {
  try {
    const sessionId = String(req.body.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId es obligatorio' });
    }
    if (typeof req.body.enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'enabled (boolean) es obligatorio'
      });
    }

    const session = sessionsStore.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: `Sesión no encontrada: ${sessionId}`
      });
    }
    if (!forbidUnlessControlSessions([sessionId], req, res)) return;

    const allSessionIds = sessionsStore.getAllSessions().map((s) => s.id);
    const result = autoReplyStore.setSessionEnabled(
      sessionId,
      req.body.enabled,
      allSessionIds
    );

    res.json({
      success: true,
      config: result.config,
      sessionId: result.sessionId,
      sessionEnabled: result.sessionEnabled
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});
```

Verificar que `autoReplyStore` ya está requerido al inicio de `server.js` (sí lo está).

- [ ] **Step 2: Smoke-test manual con curl (servidor corriendo)**

Con sesión de usuario autenticada (cookie) o, si estás logueado como super en local:

```bash
# Sustituir COOKIE por la de login; sessionId real de data/sessions.json
curl -s -X PATCH http://localhost:3445/api/auto-reply/sessions \
  -H 'Content-Type: application/json' \
  -H "Cookie: $COOKIE" \
  -d '{"sessionId":"session1","enabled":false}'
```

Expected: `{"success":true,"sessionEnabled":false,...}` y `enabledSessionIds` ya no es `null` y no incluye `session1` (si se desactivó).

Sin cookie / sin control: 401 o 403.

- [ ] **Step 3: Commit (solo si el usuario lo pide)**

```bash
git add server.js
git commit -m "$(cat <<'EOF'
feat: add PATCH endpoint for per-session AI toggle

EOF
)"
```

---

### Task 3: HTML — bloques admin-only + badge global

**Files:**
- Modify: `public/index.html` (sección `#autoReplyPanel`, ~líneas 185–243)

**Interfaces:**
- Produces: ids/clases que `app.js` muestra/oculta:
  - `#autoReplyGlobalBadge` — texto read-only del master switch
  - `.auto-reply-admin-only` — wrapper de controles solo admin
  - Nota usuario `#autoReplyUserHint`

- [ ] **Step 1: Update the panel markup**

Dentro de `#autoReplyPanel`, justo debajo del párrafo introductorio (o del `#autoReplyStatus`), añadir:

```html
<div id="autoReplyGlobalBadge" class="auto-reply-status" style="margin-bottom: 10px;"></div>
<p id="autoReplyUserHint" class="auto-reply-empty" style="display: none; margin-bottom: 12px;">
  Puedes encender o apagar la IA en tus líneas. Para pausar un contacto concreto, ábrelo en Conversaciones.
</p>
```

Envolver en un contenedor con clase `auto-reply-admin-only`:

1. El bloque `.auto-reply-controls` (toggle global + botones webhooks/probar)
2. El formulario `.auto-reply-test-form`
3. El acordeón `#autoReplyAccordion`
4. El botón `#saveAutoReplyConfigBtn`

Dejar **fuera** del wrapper admin-only:

- `#autoReplyStatus`
- `#autoReplyGlobalBadge`
- `#autoReplyUserHint`
- `#autoReplySessionsBox` (lista de líneas)

Ajustar el texto de `#autoReplySessionsBox` para que sirva a ambos roles (ya dice “Elige en qué celulares responde la IA…” — OK).

- [ ] **Step 2: Visual check**

Abrir la página como admin: debe verse todo igual (badge + panel completo).  
(Los estilos de ocultar para usuario se hacen en Task 4.)

- [ ] **Step 3: Commit (solo si el usuario lo pide)**

```bash
git add public/index.html
git commit -m "$(cat <<'EOF'
feat: mark admin-only auto-reply UI sections for role gating

EOF
)"
```

---

### Task 4: Front — panel simplificado + PATCH al toggle

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `PATCH /api/auto-reply/sessions`, `getControllableSessions()`, `isSuperUser()`, `loadAutoReplyStatus`, `loadAutoReplyConfig`
- Produces:
  - `applyPermissionUI` muestra panel si `isSuper || getControllableSessions().length > 0`
  - `applyAutoReplyRoleUI()`
  - `renderAutoReplySessions()` filtra por control si no es super; change → `toggleSessionAi(sessionId, enabled)`
  - `updateAutoReplyGlobalBadge(enabled)`

- [ ] **Step 1: Show panel for users with control**

En `applyPermissionUI()`, cambiar:

```js
if (this.autoReplyPanel) {
    this.autoReplyPanel.style.display = isSuper ? '' : 'none';
}
```

por:

```js
if (this.autoReplyPanel) {
    const showAutoReply = isSuper || this.getControllableSessions().length > 0;
    this.autoReplyPanel.style.display = showAutoReply ? '' : 'none';
}
this.applyAutoReplyRoleUI();
```

- [ ] **Step 2: Add `applyAutoReplyRoleUI`**

```js
applyAutoReplyRoleUI() {
    const isSuper = this.isSuperUser();
    document.querySelectorAll('.auto-reply-admin-only').forEach((el) => {
        el.style.display = isSuper ? '' : 'none';
    });
    if (this.autoReplyUserHint) {
        this.autoReplyUserHint.style.display = isSuper ? 'none' : '';
    }
}
```

En `initAutoReplyElements`, cachear:

```js
this.autoReplyGlobalBadge = document.getElementById('autoReplyGlobalBadge');
this.autoReplyUserHint = document.getElementById('autoReplyUserHint');
```

- [ ] **Step 3: Badge global en `loadAutoReplyStatus`**

Tras parsear `data` OK:

```js
if (this.autoReplyGlobalBadge) {
    const on = Boolean(data.enabled);
    this.autoReplyGlobalBadge.textContent = on
        ? 'Auto-respuesta global: activa'
        : 'Auto-respuesta global: inactiva (solo el admin puede encenderla)';
    this.autoReplyGlobalBadge.className = `auto-reply-status ${on ? 'ok' : 'warning'}`;
}
```

- [ ] **Step 4: Rewrite `renderAutoReplySessions` for dual mode**

```js
renderAutoReplySessions() {
    if (!this.autoReplySessionsList) return;
    const isSuper = this.isSuperUser();
    const sessions = isSuper
        ? this.configuredSessions || []
        : this.getControllableSessions();

    if (!sessions.length) {
        this.autoReplySessionsList.innerHTML =
            '<p class="auto-reply-empty">No hay líneas disponibles.</p>';
        return;
    }

    const allEnabled = this.autoReplyEnabledSessionIds === null;
    this.autoReplySessionsList.innerHTML = sessions
        .map((session) => {
            const checked =
                allEnabled ||
                (Array.isArray(this.autoReplyEnabledSessionIds) &&
                    this.autoReplyEnabledSessionIds.includes(session.id));
            return `
            <label class="auto-reply-session-item">
                <input type="checkbox" class="auto-reply-session-check"
                    data-session-id="${this.escapeHtml(session.id)}"
                    ${checked ? 'checked' : ''}>
                <span>${this.escapeHtml(session.label || session.id)}</span>
            </label>`;
        })
        .join('');

    this.autoReplySessionsList
        .querySelectorAll('.auto-reply-session-check')
        .forEach((el) => {
            el.addEventListener('change', () => {
                const sessionId = el.dataset.sessionId;
                const enabled = el.checked;
                if (isSuper) {
                    // Admin: mantener flujo actual (guardar con el resto vía botón,
                    // o guardar solo enabledSessionIds al vuelo).
                    // Spec: admin sigue con panel completo; para consistencia,
                    // admin también puede PATCH al instante O seguir con "Guardar".
                    // Decisión de plan: PATCH inmediato para ambos roles (más simple).
                    this.toggleSessionAi(sessionId, enabled, el);
                } else {
                    this.toggleSessionAi(sessionId, enabled, el);
                }
            });
        });
}
```

- [ ] **Step 5: Add `toggleSessionAi`**

```js
async toggleSessionAi(sessionId, enabled, checkboxEl) {
    try {
        const response = await fetch('/api/auto-reply/sessions', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled })
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.error || 'No se pudo actualizar');
        this.autoReplyEnabledSessionIds =
            data.config.enabledSessionIds === null ||
            data.config.enabledSessionIds === undefined
                ? null
                : data.config.enabledSessionIds;
        this.showStatus(
            enabled
                ? `IA activada en ${sessionId}`
                : `IA desactivada en ${sessionId}`,
            'success'
        );
        await this.loadAutoReplyStatus();
    } catch (error) {
        if (checkboxEl) checkboxEl.checked = !enabled;
        this.showStatus(error.message, 'error');
    }
}
```

Nota: el admin que marque checkboxes y luego pulse “Guardar configuración” seguirá enviando `enabledSessionIds` vía PUT; eso es compatible. Si usa PATCH al change, el estado ya estará persistido antes de Guardar.

- [ ] **Step 6: Ensure init loads config for non-super**

Buscar dónde se llama `loadAutoReplyConfig` / `loadAutoReplyStatus` al iniciar (solo si super hoy). Si está gated por `isSuperUser()`, ampliar a:

```js
if (this.isSuperUser() || this.getControllableSessions().length > 0) {
    this.loadAutoReplyStatus();
    this.loadAutoReplyConfig();
    this.applyAutoReplyRoleUI();
}
```

(Ajustar al sitio real en `app.js` — suele estar en el boot post-login o `DOMContentLoaded`.)

- [ ] **Step 7: Manual QA checklist**

1. Login **admin**: panel completo; badge global; toggles de todas las líneas funcionan.
2. Login **usuario con control** en session1 y session2: ve panel; no ve prompt/webhooks/guardar; solo ve session1/2; toggle llama PATCH; badge muestra global.
3. Login **usuario solo view**: no ve panel IA.
4. Con global `enabled: false` (admin), usuario puede marcar línea on; la IA no debe responder mensajes reales hasta que admin encienda global (verificar razón `auto_reply_disabled` en bandeja si llega webhook).
5. En Conversaciones, pausar IA por contacto sigue OK.

- [ ] **Step 8: Commit (solo si el usuario lo pide)**

```bash
git add public/app.js public/index.html
git commit -m "$(cat <<'EOF'
feat: show simplified per-line AI toggles for control users

EOF
)"
```

---

### Task 5: Verificación final vs criterios de éxito

**Files:** ninguna (solo checklist)

- [ ] **Step 1: Run unit tests**

Run: `node --test tests/autoReplyStore.sessionEnabled.test.js`  
Expected: PASS

- [ ] **Step 2: Map criteria → evidence**

| Criterio (spec) | Cómo verificar |
|-----------------|----------------|
| 1. Usuario control ve panel y toggles | QA Step 2 Task 4 |
| 2. No cambia prompt/webhooks/global | UI oculta + PUT/activate siguen `requireSuper` |
| 3. Toggle no altera líneas ajenas | Test Task 1 + inspeccionar `enabledSessionIds` tras PATCH |
| 4. Global off → no responde | Admin apaga toggle; webhook → `auto_reply_disabled` |
| 5. Pausar por contacto | Conversaciones → toggle IA contacto |
| 6. Admin panel completo | QA Step 1 Task 4 |

- [ ] **Step 3: Update spec status**

En `docs/superpowers/specs/2026-08-01-user-ai-line-toggles-design.md`, cambiar:

`Estado: pendiente de revisión del usuario` → `Estado: implementado`

---

## Spec coverage self-check

| Spec requirement | Task |
|------------------|------|
| Panel simplificado usuario control | Task 3 + 4 |
| Solo admin prompt/reglas/webhooks/global | Task 2 (API sin abrir PUT) + Task 3/4 (UI) |
| PATCH por línea + materializar null | Task 1 + 2 |
| Por contacto sin cambios | Task 4 QA (no code change) |
| Criterios de éxito | Task 5 |

No placeholders remaining. Types consistent: `setSessionEnabled(sessionId, enabled, allSessionIds)` → PATCH body `{ sessionId, enabled }`.
