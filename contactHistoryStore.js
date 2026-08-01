/**
 * Persistencia del historial de contactos WhatsApp en MongoDB.
 *
 * Provisionado (usuario y base solo para esta app — separada de whatsapp-bulk Puppeteer):
 *   mongosh "mongodb://ADMIN_URI" --eval '
 *     use whatsapp_bulk_openwa
 *     db.createUser({
 *       user: "whatsapp_app",
 *       pwd: "CAMBIAR_PASSWORD",
 *       roles: [{ role: "readWrite", db: "whatsapp_bulk_openwa" }]
 *     })'
 *
 * URI en .env (authSource igual al nombre de la base):
 *   MONGODB_URI=mongodb://whatsapp_app:PASSWORD@localhost:27017/whatsapp_bulk_openwa?authSource=whatsapp_bulk_openwa
 *
 * Sin MONGODB_URI: no hay filtro ni registro de historial.
 */

require('dotenv').config();

const { MongoClient } = require('mongodb');

const COLLECTION = 'contact_history';

let clientPromise = null;

function normalizePhone(raw) {
  if (raw == null) return '';
  return String(raw).replace(/\D/g, '');
}

/**
 * Compara teléfonos tolerando +52 / 521 / últimos 10 dígitos.
 */
function phonesMatch(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.endsWith(nb) || nb.endsWith(na)) return true;
  const ta = na.slice(-10);
  const tb = nb.slice(-10);
  if (ta.length === 10 && ta === tb) return true;
  const stripMx = (p) => {
    if (p.startsWith('521') && p.length >= 13) return p.slice(3);
    if (p.startsWith('52') && p.length >= 12) return p.slice(2);
    return p;
  };
  const sa = stripMx(na);
  const sb = stripMx(nb);
  return sa === sb || sa.slice(-10) === sb.slice(-10);
}

function mongoUriConfigured() {
  return Boolean(process.env.MONGODB_URI && String(process.env.MONGODB_URI).trim());
}

async function getCollection() {
  if (!mongoUriConfigured()) return null;

  try {
    if (!clientPromise) {
      clientPromise = MongoClient.connect(process.env.MONGODB_URI);
    }
    const client = await clientPromise;
    const db = client.db();
    const coll = db.collection(COLLECTION);
    await coll.createIndex({ normalizedPhone: 1 }, { unique: true });
    return coll;
  } catch (err) {
    clientPromise = null;
    if (err && /authentication failed|bad auth/i.test(String(err.message))) {
      console.error(
        'MongoDB: usuario/contraseña o authSource incorrectos en MONGODB_URI. ' +
          'El authSource debe ser la base donde creaste el usuario. ' +
          'Si la contraseña tiene @ : / # ? hay que codificarla en la URL (encodeURIComponent).'
      );
    }
    throw err;
  }
}

/**
 * @param {Array<{ nombre?: string, telefono?: string }>} cvsArray
 * @returns {Promise<{ toSend: Array, skippedAlreadyContacted: Array<{ nombre, telefono, contactedAt }> }>}
 */
async function filterOutAlreadyContacted(cvsArray) {
  if (!mongoUriConfigured() || !cvsArray.length) {
    return { toSend: [...cvsArray], skippedAlreadyContacted: [] };
  }

  let coll;
  try {
    coll = await getCollection();
  } catch (err) {
    console.warn('⚠️ contactHistory: no se pudo conectar a MongoDB:', err.message);
    return { toSend: [...cvsArray], skippedAlreadyContacted: [] };
  }

  if (!coll) {
    return { toSend: [...cvsArray], skippedAlreadyContacted: [] };
  }

  const withNorm = cvsArray.map(cv => ({
    cv,
    norm: normalizePhone(cv.telefono)
  }));

  const norms = [...new Set(withNorm.map(w => w.norm).filter(Boolean))];
  const existingDocs =
    norms.length > 0
      ? await coll.find({ normalizedPhone: { $in: norms } }).toArray()
      : [];

  const existingByNorm = new Map(existingDocs.map(d => [d.normalizedPhone, d]));

  const toSend = [];
  /** @type {{ nombre: string, telefono: string, contactedAt: Date }[]} */
  const skippedAlreadyContacted = [];

  for (const { cv, norm } of withNorm) {
    if (!norm) {
      toSend.push(cv);
      continue;
    }
    const doc = existingByNorm.get(norm);
    if (doc) {
      skippedAlreadyContacted.push({
        nombre: cv.nombre,
        telefono: cv.telefono,
        contactedAt: doc.contactedAt
      });
    } else {
      toSend.push(cv);
    }
  }

  return { toSend, skippedAlreadyContacted };
}

/**
 * @param {{
 *   normalizedPhone: string,
 *   name?: string,
 *   logicalSessionId?: string,
 *   openwaSessionId?: string,
 *   cvId?: string|null,
 *   archivoOriginal?: string|null
 * }} params
 */
async function recordSuccessfulContact({
  normalizedPhone,
  name,
  logicalSessionId,
  openwaSessionId,
  cvId,
  archivoOriginal
}) {
  if (!normalizedPhone || !mongoUriConfigured()) return;

  let coll;
  try {
    coll = await getCollection();
  } catch (err) {
    console.error('contactHistory record:', err.message);
    return;
  }
  if (!coll) return;

  const displayName =
    name != null && String(name).trim() !== '' ? name : '(sin nombre)';
  const now = new Date();
  const sessionFields = {};
  if (logicalSessionId) sessionFields.logicalSessionId = String(logicalSessionId);
  if (openwaSessionId) sessionFields.openwaSessionId = String(openwaSessionId);
  if (logicalSessionId || openwaSessionId) sessionFields.lastOutboundAt = now;
  if (cvId) sessionFields.cvId = String(cvId);
  if (archivoOriginal) sessionFields.archivoOriginal = String(archivoOriginal);

  try {
    await coll.updateOne(
      { normalizedPhone },
      {
        $set: { name: displayName, ...sessionFields },
        $setOnInsert: {
          normalizedPhone,
          contactedAt: now
        }
      },
      { upsert: true }
    );
  } catch (err) {
    if (err && err.code === 11000) {
      await coll.updateOne(
        { normalizedPhone },
        { $set: { name: displayName, ...sessionFields } }
      );
      return;
    }
    console.error('contactHistory record:', err.message);
  }
}

/**
 * @param {string} normalizedPhone
 * @returns {Promise<object|null>}
 */
async function getContactByPhone(normalizedPhone) {
  if (!normalizedPhone || !mongoUriConfigured()) return null;

  let coll;
  try {
    coll = await getCollection();
  } catch (err) {
    console.warn('contactHistory getContactByPhone:', err.message);
    return null;
  }
  if (!coll) return null;

  return coll.findOne({ normalizedPhone });
}

/**
 * @param {string} normalizedPhone
 * @returns {Promise<boolean>}
 */
async function isKnownContact(normalizedPhone) {
  const doc = await getContactByPhone(normalizedPhone);
  return Boolean(doc);
}

/**
 * Busca contacto tolerando variaciones MX (52/521/últimos 10).
 * @param {string} normalizedPhone
 * @returns {Promise<object|null>}
 */
async function findContactByPhoneFuzzy(normalizedPhone) {
  const exact = await getContactByPhone(normalizedPhone);
  if (exact) return exact;
  if (!normalizedPhone || !mongoUriConfigured()) return null;
  if (String(normalizedPhone).startsWith('lid_')) return null;

  let coll;
  try {
    coll = await getCollection();
  } catch {
    return null;
  }
  if (!coll) return null;

  const last10 = normalizedPhone.slice(-10);
  if (last10.length < 10) return null;

  const candidates = await coll
    .find({ normalizedPhone: { $regex: `${last10}$` } })
    .limit(20)
    .toArray();

  for (const doc of candidates) {
    if (phonesMatch(normalizedPhone, doc.normalizedPhone)) return doc;
  }
  return null;
}

/**
 * @param {string} whatsappLid
 * @returns {Promise<object|null>}
 */
async function findContactByLid(whatsappLid) {
  const lid = String(whatsappLid || '').replace(/\D/g, '');
  if (!lid || !mongoUriConfigured()) return null;

  let coll;
  try {
    coll = await getCollection();
  } catch {
    return null;
  }
  if (!coll) return null;

  const byField = await coll.findOne({ whatsappLid: lid });
  if (byField) return byField;
  return coll.findOne({ normalizedPhone: `lid_${lid}` });
}

/**
 * Alta automática al recibir un mensaje (contacto nuevo o solo LID).
 */
async function enrollInboundContact({
  normalizedPhone,
  name,
  logicalSessionId,
  openwaSessionId,
  chatId,
  whatsappLid,
  source = 'inbound_auto'
}) {
  if (!normalizedPhone || !mongoUriConfigured()) return null;

  let coll;
  try {
    coll = await getCollection();
  } catch (err) {
    console.error('contactHistory enrollInboundContact:', err.message);
    return null;
  }
  if (!coll) return null;

  try {
    await coll.createIndex({ whatsappLid: 1 }, { sparse: true });
  } catch {
    /* index may already exist */
  }

  const displayName =
    name != null && String(name).trim() !== '' ? String(name).trim() : '(sin nombre)';
  const now = new Date();
  const $set = {
    name: displayName,
    source: String(source),
    lastInboundAt: now
  };
  if (logicalSessionId) $set.logicalSessionId = String(logicalSessionId);
  if (openwaSessionId) $set.openwaSessionId = String(openwaSessionId);
  if (chatId) $set.chatId = String(chatId);
  if (whatsappLid) $set.whatsappLid = String(whatsappLid).replace(/\D/g, '');

  await coll.updateOne(
    { normalizedPhone },
    {
      $set,
      $setOnInsert: {
        normalizedPhone,
        contactedAt: now,
        enrolledFromInbound: true
      }
    },
    { upsert: true }
  );

  return getContactByPhone(normalizedPhone);
}

/**
 * @param {string} normalizedPhone
 * @returns {Promise<{ logicalSessionId?: string, openwaSessionId?: string, name?: string }|null>}
 */
async function getContactSession(normalizedPhone) {
  const doc = await getContactByPhone(normalizedPhone);
  if (!doc) return null;
  return {
    logicalSessionId: doc.logicalSessionId || null,
    openwaSessionId: doc.openwaSessionId || null,
    name: doc.name || null,
    aiPaused: Boolean(doc.aiPaused),
    aiPausedAt: doc.aiPausedAt || null
  };
}

/**
 * Asigna sesión a contacto legacy (sin sessionId) en primer reply.
 * @param {string} normalizedPhone
 * @param {{ logicalSessionId: string, openwaSessionId: string }} session
 */
async function assignContactSession(normalizedPhone, { logicalSessionId, openwaSessionId }) {
  if (!normalizedPhone || !mongoUriConfigured()) return;

  let coll;
  try {
    coll = await getCollection();
  } catch (err) {
    console.error('contactHistory assignContactSession:', err.message);
    return;
  }
  if (!coll) return;

  await coll.updateOne(
    { normalizedPhone },
    {
      $set: {
        logicalSessionId: String(logicalSessionId),
        openwaSessionId: String(openwaSessionId)
      }
    }
  );
}

/**
 * Pausa o reactiva la auto-respuesta IA para un contacto concreto.
 * @param {string} normalizedPhone
 * @param {boolean} paused
 * @returns {Promise<{ ok: boolean, aiPaused?: boolean, error?: string }>}
 */
async function setContactAiPaused(normalizedPhone, paused) {
  if (!normalizedPhone) {
    return { ok: false, error: 'teléfono inválido' };
  }
  if (!mongoUriConfigured()) {
    return { ok: false, error: 'MongoDB no configurado' };
  }

  let coll;
  try {
    coll = await getCollection();
  } catch (err) {
    console.error('contactHistory setContactAiPaused:', err.message);
    return { ok: false, error: err.message };
  }
  if (!coll) return { ok: false, error: 'MongoDB no disponible' };

  const aiPaused = Boolean(paused);
  const update = aiPaused
    ? { $set: { aiPaused: true, aiPausedAt: new Date() } }
    : { $set: { aiPaused: false }, $unset: { aiPausedAt: '' } };

  const result = await coll.updateOne({ normalizedPhone }, update);
  if (result.matchedCount === 0) {
    return { ok: false, error: 'Contacto no está en el historial' };
  }
  return { ok: true, aiPaused };
}

/**
 * @param {string} normalizedPhone
 * @returns {Promise<boolean>}
 */
async function isContactAiPaused(normalizedPhone) {
  const doc = await getContactByPhone(normalizedPhone);
  return Boolean(doc && doc.aiPaused);
}

module.exports = {
  normalizePhone,
  phonesMatch,
  mongoUriConfigured,
  filterOutAlreadyContacted,
  recordSuccessfulContact,
  getContactByPhone,
  isKnownContact,
  findContactByPhoneFuzzy,
  findContactByLid,
  enrollInboundContact,
  getContactSession,
  assignContactSession,
  setContactAiPaused,
  isContactAiPaused
};
