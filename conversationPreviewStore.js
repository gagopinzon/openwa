const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'conversation-previews.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readStore() {
  ensureDataDir();
  if (!fs.existsSync(STORE_FILE)) {
    return { version: 1, previews: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return { version: 1, previews: {} };
    }
    return {
      version: 1,
      previews:
        parsed.previews && typeof parsed.previews === 'object' ? parsed.previews : {}
    };
  } catch {
    return { version: 1, previews: {} };
  }
}

function writeStore(data) {
  ensureDataDir();
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_FILE);
}

function chatKey(sessionId, chatId) {
  return `${String(sessionId || '').trim()}::${String(chatId || '').trim()}`;
}

function getPreview(key) {
  if (!key) return null;
  const row = readStore().previews[key];
  return row && typeof row === 'object' ? row : null;
}

function getMany(keys) {
  const store = readStore();
  const out = {};
  for (const key of keys || []) {
    if (store.previews[key]) out[key] = store.previews[key];
  }
  return out;
}

/**
 * @param {string} key
 * @param {{ previewLines: string[], lastFromMe?: boolean|null, lastMessage?: string, sourceLastMessage?: string }} data
 */
function upsert(key, data) {
  if (!key || !data) return null;
  const lines = Array.isArray(data.previewLines)
    ? data.previewLines.map((l) => String(l || '').trim()).filter(Boolean).slice(-8)
    : [];
  if (!lines.length) return null;

  const store = readStore();
  store.previews[key] = {
    previewLines: lines,
    lastFromMe:
      data.lastFromMe === true || data.lastFromMe === false ? data.lastFromMe : null,
    lastMessage: String(data.lastMessage || lines[lines.length - 1] || ''),
    sourceLastMessage: String(
      data.sourceLastMessage || data.lastMessage || lines[lines.length - 1] || ''
    ),
    updatedAt: new Date().toISOString()
  };
  writeStore(store);
  return store.previews[key];
}

function upsertMany(entries) {
  if (!Array.isArray(entries) || !entries.length) return 0;
  const store = readStore();
  let count = 0;
  for (const entry of entries) {
    if (!entry || !entry.key) continue;
    const lines = Array.isArray(entry.previewLines)
      ? entry.previewLines.map((l) => String(l || '').trim()).filter(Boolean).slice(-8)
      : [];
    if (!lines.length) continue;
    store.previews[entry.key] = {
      previewLines: lines,
      lastFromMe:
        entry.lastFromMe === true || entry.lastFromMe === false ? entry.lastFromMe : null,
      lastMessage: String(entry.lastMessage || lines[lines.length - 1] || ''),
      sourceLastMessage: String(
        entry.sourceLastMessage || entry.lastMessage || lines[lines.length - 1] || ''
      ),
      updatedAt: new Date().toISOString()
    };
    count += 1;
  }
  if (count) writeStore(store);
  return count;
}

function isPreviewStale(chat, preview) {
  if (!preview || !Array.isArray(preview.previewLines) || !preview.previewLines.length) {
    return true;
  }
  const incoming = String((chat && chat.lastMessage) || '').trim();
  if (!incoming) return false;
  const stored = String(preview.sourceLastMessage || preview.lastMessage || '').trim();
  const lastLine = String(preview.previewLines[preview.previewLines.length - 1] || '').trim();
  if (incoming === stored || incoming === lastLine) return false;
  if (preview.previewLines.some((l) => String(l).trim() === incoming)) return false;
  return true;
}

/**
 * Adjunta previewLines/lastFromMe desde disco a los chats de la lista.
 * @param {Array} chats
 */
function applyToChats(chats) {
  const list = Array.isArray(chats) ? chats : [];
  if (!list.length) return list;
  const store = readStore();
  return list.map((chat) => {
    const key = chat.key || chatKey(chat.sessionId, chat.id);
    const preview = store.previews[key];
    if (!preview || isPreviewStale(chat, preview)) {
      return { ...chat, key };
    }
    return {
      ...chat,
      key,
      previewLines: [...preview.previewLines],
      lastFromMe:
        preview.lastFromMe === true || preview.lastFromMe === false
          ? preview.lastFromMe
          : null,
      lastMessage: chat.lastMessage || preview.lastMessage || ''
    };
  });
}

/**
 * Chats que necesitan (re)cargar preview desde OpenWA.
 */
function listNeedingEnrichment(chats, limit = 80) {
  const list = Array.isArray(chats) ? chats : [];
  const store = readStore();
  const needing = [];
  for (const chat of list) {
    if (needing.length >= limit) break;
    const key = chat.key || chatKey(chat.sessionId, chat.id);
    const preview = store.previews[key];
    if (!preview || isPreviewStale(chat, preview)) {
      needing.push({
        sessionId: chat.sessionId,
        chatId: chat.id,
        key,
        lastMessage: chat.lastMessage || ''
      });
    }
  }
  return needing;
}

module.exports = {
  chatKey,
  getPreview,
  getMany,
  upsert,
  upsertMany,
  applyToChats,
  isPreviewStale,
  listNeedingEnrichment,
  STORE_FILE
};
