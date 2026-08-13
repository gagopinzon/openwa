const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'send-settings.json');

const DEFAULT_MIN_DELAY_SEC = 60;
const DEFAULT_MAX_DELAY_SEC = 300;
const ABS_MIN_SEC = 10;
const ABS_MAX_SEC = 7200;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function envInt(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function defaultSettings() {
  const minDelaySec = clampInt(
    envInt('SEND_MIN_DELAY_SEC', DEFAULT_MIN_DELAY_SEC),
    ABS_MIN_SEC,
    ABS_MAX_SEC,
    DEFAULT_MIN_DELAY_SEC
  );
  const maxDelaySec = clampInt(
    envInt('SEND_MAX_DELAY_SEC', DEFAULT_MAX_DELAY_SEC),
    minDelaySec,
    ABS_MAX_SEC,
    Math.max(minDelaySec, DEFAULT_MAX_DELAY_SEC)
  );
  return {
    version: 1,
    minDelaySec,
    maxDelaySec
  };
}

function normalizeSettings(raw) {
  const base = defaultSettings();
  const minDelaySec = clampInt(
    raw?.minDelaySec,
    ABS_MIN_SEC,
    ABS_MAX_SEC,
    base.minDelaySec
  );
  const maxDelaySec = clampInt(
    raw?.maxDelaySec,
    minDelaySec,
    ABS_MAX_SEC,
    Math.max(minDelaySec, base.maxDelaySec)
  );
  return {
    version: 1,
    minDelaySec,
    maxDelaySec
  };
}

function readSettings() {
  ensureDataDir();
  if (!fs.existsSync(SETTINGS_FILE)) {
    const settings = defaultSettings();
    writeSettings(settings);
    return settings;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return normalizeSettings(parsed);
  } catch {
    return defaultSettings();
  }
}

function writeSettings(data) {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(normalizeSettings(data), null, 2), 'utf8');
}

function getSettings() {
  return readSettings();
}

function getPublicSettings() {
  return getSettings();
}

/**
 * @param {{ minDelaySec?: number, maxDelaySec?: number }} patch
 */
function updateSettings(patch = {}) {
  const current = readSettings();
  const next = normalizeSettings({
    ...current,
    ...(patch.minDelaySec !== undefined ? { minDelaySec: patch.minDelaySec } : {}),
    ...(patch.maxDelaySec !== undefined ? { maxDelaySec: patch.maxDelaySec } : {})
  });
  writeSettings(next);
  return getPublicSettings();
}

module.exports = {
  getSettings,
  getPublicSettings,
  updateSettings,
  DEFAULT_MIN_DELAY_SEC,
  DEFAULT_MAX_DELAY_SEC,
  ABS_MIN_SEC,
  ABS_MAX_SEC
};
