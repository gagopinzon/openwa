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
 * @param {{ normalizedPhone: string, name?: string, logicalSessionId?: string, openwaSessionId?: string }} params
 */
async function recordSuccessfulContact({
  normalizedPhone,
  name,
  logicalSessionId,
  openwaSessionId
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
 * @param {string} normalizedPhone
 * @returns {Promise<{ logicalSessionId?: string, openwaSessionId?: string, name?: string }|null>}
 */
async function getContactSession(normalizedPhone) {
  const doc = await getContactByPhone(normalizedPhone);
  if (!doc) return null;
  return {
    logicalSessionId: doc.logicalSessionId || null,
    openwaSessionId: doc.openwaSessionId || null,
    name: doc.name || null
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

module.exports = {
  normalizePhone,
  mongoUriConfigured,
  filterOutAlreadyContacted,
  recordSuccessfulContact,
  getContactByPhone,
  isKnownContact,
  getContactSession,
  assignContactSession
};
