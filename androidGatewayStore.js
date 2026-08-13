const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'android-gateway.json');

const JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  SENT: 'sent',
  FAILED: 'failed',
  EXPIRED: 'expired'
});

const DEFAULT_MIN_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function newId() {
  return crypto.randomBytes(12).toString('hex');
}

function normalizeStore(raw) {
  return {
    version: 1,
    minIntervalMs: Number(raw?.minIntervalMs) > 0 ? Number(raw.minIntervalMs) : DEFAULT_MIN_INTERVAL_MS,
    claimTimeoutMs:
      Number(raw?.claimTimeoutMs) > 0 ? Number(raw.claimTimeoutMs) : DEFAULT_CLAIM_TIMEOUT_MS,
    devices: Array.isArray(raw?.devices) ? raw.devices.filter(Boolean) : [],
    jobs: Array.isArray(raw?.jobs) ? raw.jobs.filter(Boolean) : []
  };
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    return normalizeStore(null);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return normalizeStore(null);
    return normalizeStore(parsed);
  } catch {
    return normalizeStore(null);
  }
}

function writeStore(data) {
  ensureDataDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(normalizeStore(data), null, 2), 'utf8');
}

const BATTERY_LOW_THRESHOLD = 20;

function getConfig() {
  const store = readStore();
  return {
    minIntervalMs: store.minIntervalMs,
    claimTimeoutMs: store.claimTimeoutMs
  };
}

/**
 * Nivel de batería 0–100. -1 u otros inválidos → null (no pisa un valor previo).
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeBatteryLevel(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  if (i < 0 || i > 100) return null;
  return i;
}

function applyBatteryLevel(device, batteryLevel, nowIso) {
  const level = normalizeBatteryLevel(batteryLevel);
  if (level === null || !device) return;
  device.batteryLevel = level;
  device.batteryUpdatedAt = nowIso;
}

/**
 * @param {{ label: string, logicalSessionId?: string|null, deviceId?: string|null, batteryLevel?: number|null }} opts
 */
function registerDevice({
  label,
  logicalSessionId = null,
  deviceId = null,
  batteryLevel = null
} = {}) {
  const store = readStore();
  const now = new Date().toISOString();
  const cleanLabel = String(label || '').trim() || 'Android';
  const sessionId = logicalSessionId ? String(logicalSessionId).trim() : null;

  let device = null;
  if (deviceId) {
    device = store.devices.find((d) => d.id === String(deviceId).trim()) || null;
  }

  if (device) {
    device.label = cleanLabel;
    if (sessionId) device.logicalSessionId = sessionId;
    device.lastSeenAt = now;
    device.status = 'online';
    applyBatteryLevel(device, batteryLevel, now);
  } else {
    device = {
      id: newId(),
      label: cleanLabel,
      logicalSessionId: sessionId,
      status: 'online',
      lastSeenAt: now,
      lastJobAt: null,
      createdAt: now,
      batteryLevel: null,
      batteryUpdatedAt: null
    };
    applyBatteryLevel(device, batteryLevel, now);
    store.devices.push(device);
  }

  writeStore(store);
  return { ...device };
}

function listDevices() {
  return readStore().devices.map((d) => ({ ...d }));
}

function getDevice(deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return null;
  return readStore().devices.find((d) => d.id === id) || null;
}

/**
 * @param {string} deviceId
 * @param {{ batteryLevel?: number|null }} [opts]
 */
function heartbeat(deviceId, opts = {}) {
  const store = readStore();
  const device = store.devices.find((d) => d.id === String(deviceId || '').trim());
  if (!device) return null;
  const now = new Date().toISOString();
  device.lastSeenAt = now;
  device.status = 'online';
  applyBatteryLevel(device, opts.batteryLevel, now);
  writeStore(store);
  return { ...device };
}

function expireStaleClaims(store, nowMs = Date.now()) {
  const timeout = store.claimTimeoutMs || DEFAULT_CLAIM_TIMEOUT_MS;
  let changed = false;
  for (const job of store.jobs) {
    if (job.status !== JOB_STATUS.CLAIMED) continue;
    const claimedAt = Date.parse(job.claimedAt || '') || 0;
    if (claimedAt && nowMs - claimedAt > timeout) {
      job.status = JOB_STATUS.FAILED;
      job.error = 'claim_timeout';
      job.finishedAt = new Date(nowMs).toISOString();
      changed = true;
    }
  }
  return changed;
}

function deviceCanClaim(device, store, nowMs = Date.now()) {
  if (!device) return false;
  const minInterval = store.minIntervalMs || DEFAULT_MIN_INTERVAL_MS;
  if (!device.lastJobAt) return true;
  const last = Date.parse(device.lastJobAt) || 0;
  return nowMs - last >= minInterval;
}

/**
 * @param {{ deviceId: string }} opts
 */
function claimNextJob({ deviceId } = {}) {
  const store = readStore();
  const now = Date.now();
  expireStaleClaims(store, now);

  const id = String(deviceId || '').trim();
  const device = store.devices.find((d) => d.id === id);
  if (!device) {
    writeStore(store);
    return null;
  }

  device.lastSeenAt = new Date(now).toISOString();
  device.status = 'online';

  const alreadyClaimed = store.jobs.find(
    (j) => j.deviceId === id && j.status === JOB_STATUS.CLAIMED
  );
  if (alreadyClaimed) {
    writeStore(store);
    return { ...alreadyClaimed };
  }

  if (!deviceCanClaim(device, store, now)) {
    // Aún permitir jobs de prueba admin (bypassInterval)
    const testJob = store.jobs.find(
      (j) =>
        j.deviceId === id &&
        j.status === JOB_STATUS.PENDING &&
        (j.meta?.bypassInterval === true || j.meta?.test === true)
    );
    if (!testJob) {
      writeStore(store);
      return null;
    }
    testJob.status = JOB_STATUS.CLAIMED;
    testJob.claimedAt = new Date(now).toISOString();
    writeStore(store);
    return { ...testJob };
  }

  // Preferir jobs de prueba pendientes
  const job =
    store.jobs.find(
      (j) =>
        j.deviceId === id &&
        j.status === JOB_STATUS.PENDING &&
        (j.meta?.test === true || j.meta?.bypassInterval === true)
    ) || store.jobs.find((j) => j.deviceId === id && j.status === JOB_STATUS.PENDING);
  if (!job) {
    writeStore(store);
    return null;
  }

  job.status = JOB_STATUS.CLAIMED;
  job.claimedAt = new Date(now).toISOString();
  writeStore(store);
  return { ...job };
}

/**
 * @param {{ jobId: string, deviceId: string, ok: boolean, error?: string|null }} opts
 */
function reportJobResult({ jobId, deviceId, ok, error = null } = {}) {
  const store = readStore();
  expireStaleClaims(store);

  const job = store.jobs.find((j) => j.id === String(jobId || '').trim());
  if (!job) {
    const err = new Error('job_not_found');
    err.code = 'job_not_found';
    throw err;
  }
  if (job.deviceId !== String(deviceId || '').trim()) {
    const err = new Error('device_mismatch');
    err.code = 'device_mismatch';
    throw err;
  }
  if (job.status === JOB_STATUS.SENT || job.status === JOB_STATUS.FAILED) {
    return { ...job };
  }
  if (job.status !== JOB_STATUS.CLAIMED && job.status !== JOB_STATUS.PENDING) {
    const err = new Error('invalid_status');
    err.code = 'invalid_status';
    throw err;
  }

  const now = new Date().toISOString();
  job.status = ok ? JOB_STATUS.SENT : JOB_STATUS.FAILED;
  job.error = ok ? null : String(error || 'send_failed');
  job.finishedAt = now;

  const device = store.devices.find((d) => d.id === job.deviceId);
  if (device) {
    device.lastJobAt = now;
    device.lastSeenAt = now;
    device.status = 'online';
  }

  writeStore(store);
  return { ...job };
}

/**
 * @param {Array<{ telefono: string, mensaje: string, nombre?: string, batchId?: string|null, meta?: object }>} items
 * @param {string[]} deviceIds
 */
function enqueueJobs(items, deviceIds) {
  const store = readStore();
  const ids = (deviceIds || []).map((d) => String(d).trim()).filter(Boolean);
  if (!ids.length) {
    const err = new Error('no_devices');
    err.code = 'no_devices';
    throw err;
  }

  const online = ids
    .map((id) => store.devices.find((d) => d.id === id))
    .filter(Boolean);
  if (!online.length) {
    const err = new Error('no_devices');
    err.code = 'no_devices';
    throw err;
  }

  const created = [];
  const now = new Date().toISOString();
  const list = Array.isArray(items) ? items : [];

  list.forEach((item, index) => {
    const device = online[index % online.length];
    const job = {
      id: newId(),
      deviceId: device.id,
      batchId: item.batchId || null,
      telefono: String(item.telefono || '').trim(),
      mensaje: String(item.mensaje || ''),
      nombre: item.nombre ? String(item.nombre) : null,
      status: JOB_STATUS.PENDING,
      createdAt: now,
      claimedAt: null,
      finishedAt: null,
      error: null,
      meta: item.meta || null
    };
    store.jobs.push(job);
    created.push({ ...job });
  });

  writeStore(store);
  return created;
}

function getJob(jobId) {
  return readStore().jobs.find((j) => j.id === String(jobId || '').trim()) || null;
}

function listJobs({ batchId = null, status = null, limit = 200 } = {}) {
  let jobs = readStore().jobs.slice();
  if (batchId) jobs = jobs.filter((j) => j.batchId === batchId);
  if (status) jobs = jobs.filter((j) => j.status === status);
  jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return jobs.slice(0, Math.max(1, Number(limit) || 200)).map((j) => ({ ...j }));
}

/**
 * Devices online (seen within maxAgeMs) optionally filtered by logicalSessionIds.
 * @param {{ logicalSessionIds?: string[], maxAgeMs?: number }} opts
 */
function pickOnlineDevices({ logicalSessionIds = null, maxAgeMs = 2 * 60 * 1000 } = {}) {
  const store = readStore();
  const now = Date.now();
  const sessions = Array.isArray(logicalSessionIds)
    ? logicalSessionIds.map((s) => String(s).trim()).filter(Boolean)
    : null;

  return store.devices
    .filter((d) => {
      const seen = Date.parse(d.lastSeenAt || '') || 0;
      if (!seen || now - seen > maxAgeMs) return false;
      if (!sessions || sessions.length === 0) return true;
      if (!d.logicalSessionId) return true;
      return sessions.includes(d.logicalSessionId);
    })
    .map((d) => ({ ...d }));
}

function tick() {
  const store = readStore();
  if (expireStaleClaims(store)) {
    writeStore(store);
  }
}

function getJobsByIds(jobIds) {
  tick();
  const set = new Set((jobIds || []).map((id) => String(id)));
  return readStore().jobs.filter((j) => set.has(j.id)).map((j) => ({ ...j }));
}

function areJobsTerminal(jobs) {
  return (jobs || []).every((j) =>
    [JOB_STATUS.SENT, JOB_STATUS.FAILED, JOB_STATUS.EXPIRED].includes(j.status)
  );
}

function linkDeviceToLogicalSession(deviceId, logicalSessionId) {
  const store = readStore();
  const id = deviceId ? String(deviceId).trim() : '';
  const sessionId = logicalSessionId ? String(logicalSessionId).trim() : null;

  if (sessionId) {
    for (const d of store.devices) {
      if (d.logicalSessionId === sessionId && d.id !== id) {
        d.logicalSessionId = null;
      }
    }
  }

  if (id) {
    const device = store.devices.find((d) => d.id === id);
    if (!device) {
      const err = new Error('device_not_found');
      err.code = 'device_not_found';
      throw err;
    }
    device.logicalSessionId = sessionId;
  }

  writeStore(store);
  return id ? { ...store.devices.find((d) => d.id === id) } : null;
}

/**
 * Elimina un dispositivo y cancela jobs pendientes/reclamados.
 * @param {string} deviceId
 * @returns {{ device: object, cancelledJobs: number }|null}
 */
function deleteDevice(deviceId) {
  const store = readStore();
  const id = String(deviceId || '').trim();
  if (!id) return null;
  const idx = store.devices.findIndex((d) => d.id === id);
  if (idx < 0) return null;

  const [device] = store.devices.splice(idx, 1);
  const now = new Date().toISOString();
  let cancelledJobs = 0;
  for (const job of store.jobs) {
    if (job.deviceId !== id) continue;
    if (job.status !== JOB_STATUS.PENDING && job.status !== JOB_STATUS.CLAIMED) continue;
    job.status = JOB_STATUS.FAILED;
    job.error = 'device_deleted';
    job.finishedAt = now;
    cancelledJobs += 1;
  }

  writeStore(store);
  return { device: { ...device }, cancelledJobs };
}

/**
 * Encola jobs ya asignados a deviceId concreto.
 * @param {Array<{ telefono: string, mensaje: string, deviceId: string, nombre?: string, batchId?: string|null, logicalSessionId?: string|null, meta?: object }>} items
 */
function enqueueAssignedJobs(items) {
  const store = readStore();
  const now = new Date().toISOString();
  const created = [];
  const list = Array.isArray(items) ? items : [];

  for (const item of list) {
    const deviceId = String(item.deviceId || '').trim();
    const device = store.devices.find((d) => d.id === deviceId);
    if (!device) {
      const err = new Error(`Dispositivo Android no encontrado: ${deviceId}`);
      err.code = 'device_not_found';
      throw err;
    }
    const job = {
      id: newId(),
      deviceId,
      batchId: item.batchId || null,
      telefono: String(item.telefono || '').trim(),
      mensaje: String(item.mensaje || ''),
      nombre: item.nombre ? String(item.nombre) : null,
      status: JOB_STATUS.PENDING,
      createdAt: now,
      claimedAt: null,
      finishedAt: null,
      error: null,
      meta: {
        ...(item.meta || {}),
        logicalSessionId: item.logicalSessionId || device.logicalSessionId || null
      }
    };
    store.jobs.push(job);
    created.push({ ...job });
  }

  writeStore(store);
  return created;
}

module.exports = {
  JOB_STATUS,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_CLAIM_TIMEOUT_MS,
  BATTERY_LOW_THRESHOLD,
  normalizeBatteryLevel,
  getConfig,
  registerDevice,
  listDevices,
  getDevice,
  heartbeat,
  claimNextJob,
  reportJobResult,
  enqueueJobs,
  enqueueAssignedJobs,
  linkDeviceToLogicalSession,
  deleteDevice,
  getJob,
  listJobs,
  pickOnlineDevices,
  tick,
  getJobsByIds,
  areJobsTerminal,
  // test helpers
  _readStore: readStore,
  _writeStore: writeStore,
  _STORE_FILE: STORE_FILE
};
