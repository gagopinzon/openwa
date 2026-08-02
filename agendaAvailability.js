const panelMsgClient = require('./panelMsgClient');
const usersStore = require('./usersStore');

const WEEKDAY_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTH_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic'
];

/**
 * @param {string} fecha YYYY-MM-DD
 * @param {string} horaInicio
 * @param {string} horaFin
 */
function slotKey(fecha, horaInicio, horaFin) {
  return `${String(fecha || '').trim()}|${String(horaInicio || '').trim()}|${String(horaFin || '').trim()}`;
}

/**
 * @param {{ fecha: string, horaInicio: string, horaFin: string }} slot
 */
function formatSlotLabel(slot) {
  const fecha = String(slot.fecha || '').trim();
  const hora = String(slot.horaInicio || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) return `${fecha} ${hora}`.trim();
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  const wd = WEEKDAY_SHORT[dt.getDay()] || '';
  const mon = MONTH_SHORT[mo - 1] || '';
  return `${wd} ${d} ${mon}, ${hora}`;
}

/**
 * @param {{ users?: Array<{ gerenteEmail?: string }>, superEmail?: string, envEmail?: string }} opts
 * @returns {string[]}
 */
function collectGerenteEmails(opts = {}) {
  const set = new Set();
  const add = (value) => {
    const email = usersStore.sanitizeGerenteEmail(value);
    if (email) set.add(email);
  };

  const users = Array.isArray(opts.users) ? opts.users : usersStore.getAllUsers();
  for (const user of users) {
    add(user && user.gerenteEmail);
  }

  add(
    opts.superEmail != null ? opts.superEmail : usersStore.getSuperGerenteEmail()
  );
  add(
    opts.envEmail != null ? opts.envEmail : panelMsgClient.defaultGerenteEmail()
  );

  return [...set].sort();
}

/**
 * Une respuestas de varios gerentes en slots únicos (sin nombres al lead).
 * @param {Array<{ gerenteEmail: string, data?: object, error?: string }>} responses
 */
function mergePanelDisponibilidad(responses) {
  /** @type {Map<string, { fecha: string, horaInicio: string, horaFin: string, label: string, candidates: Array<{ gerenteEmail: string, vendedorId: string, nombre: string|null }> }>} */
  const byKey = new Map();
  const erroresGerente = [];
  let gerentesConsultados = 0;

  for (const row of responses || []) {
    const gerenteEmail = String(row.gerenteEmail || '').trim().toLowerCase();
    if (row.error) {
      erroresGerente.push({ gerenteEmail, error: String(row.error) });
      continue;
    }
    gerentesConsultados += 1;
    const data = row.data && typeof row.data === 'object' ? row.data : {};
    const vendedores = Array.isArray(data.vendedores) ? data.vendedores : [];

    for (const v of vendedores) {
      const vendedorId = String(v.id || v.vendedorId || '').trim();
      if (!vendedorId) continue;
      const nombre = v.nombre || v.correo || null;
      const slots = Array.isArray(v.disponibilidad) ? v.disponibilidad : [];
      for (const s of slots) {
        const fecha = String(s.fecha || '').trim();
        const horaInicio = String(s.horaInicio || '').trim();
        const horaFin = String(s.horaFin || '').trim();
        if (!fecha || !horaInicio || !horaFin) continue;
        const key = slotKey(fecha, horaInicio, horaFin);
        let entry = byKey.get(key);
        if (!entry) {
          entry = {
            fecha,
            horaInicio,
            horaFin,
            label: formatSlotLabel({ fecha, horaInicio, horaFin }),
            candidates: []
          };
          byKey.set(key, entry);
        }
        const already = entry.candidates.some(
          (c) =>
            c.gerenteEmail === gerenteEmail && c.vendedorId === vendedorId
        );
        if (!already) {
          entry.candidates.push({
            gerenteEmail,
            vendedorId,
            nombre: nombre ? String(nombre) : null
          });
        }
      }
    }
  }

  const slots = [...byKey.values()].sort((a, b) => {
    const fa = `${a.fecha} ${a.horaInicio}`;
    const fb = `${b.fecha} ${b.horaInicio}`;
    return fa.localeCompare(fb);
  });

  return {
    slots,
    gerentesConsultados,
    erroresGerente
  };
}

/**
 * @param {{
 *   fechaInicio?: string,
 *   fechaFin?: string,
 *   slotMinutos?: number,
 *   getDisponibilidad?: Function,
 *   listEmails?: () => string[]
 * }} opts
 */
async function getAggregatedSlots(opts = {}) {
  if (!panelMsgClient.isConfigured() && !opts.getDisponibilidad) {
    const err = new Error(
      'Integración con panel no configurada. Define MSG_INTEGRATION_API_KEY en .env'
    );
    err.status = 503;
    throw err;
  }

  const emails =
    typeof opts.listEmails === 'function'
      ? opts.listEmails()
      : collectGerenteEmails();

  if (!emails.length) {
    return {
      slots: [],
      gerentesConsultados: 0,
      erroresGerente: [
        {
          gerenteEmail: '',
          error:
            'No hay correos de gerente configurados (perfiles de usuario o MSG_GERENTE_EMAIL)'
        }
      ]
    };
  }

  const fetchFn =
    typeof opts.getDisponibilidad === 'function'
      ? opts.getDisponibilidad
      : (params) => panelMsgClient.getDisponibilidad(params);

  const responses = await Promise.all(
    emails.map(async (gerenteEmail) => {
      try {
        const data = await fetchFn({
          gerenteEmail,
          fechaInicio: opts.fechaInicio,
          fechaFin: opts.fechaFin,
          slotMinutos: opts.slotMinutos
        });
        return { gerenteEmail, data };
      } catch (error) {
        return {
          gerenteEmail,
          error: error.message || 'Error al consultar disponibilidad'
        };
      }
    })
  );

  return mergePanelDisponibilidad(responses);
}

/**
 * Vista pública para lead / API (sin candidates).
 * @param {Array<object>} slots
 * @param {number} [limit]
 */
function publicSlots(slots, limit = 8) {
  const list = Array.isArray(slots) ? slots : [];
  return list.slice(0, Math.max(0, Number(limit) || 8)).map((s) => ({
    fecha: s.fecha,
    horaInicio: s.horaInicio,
    horaFin: s.horaFin,
    label: s.label || formatSlotLabel(s)
  }));
}

const DAY_UPPER = [
  'DOMINGO',
  'LUNES',
  'MARTES',
  'MIÉRCOLES',
  'JUEVES',
  'VIERNES',
  'SÁBADO'
];

/**
 * Texto para el prompt estilo playbook (VIERNES: • 10:00 …).
 * @param {Array<object>} slots
 * @param {number} [limit]
 */
function formatSlotsForPrompt(slots, limit = 8) {
  const pub = publicSlots(slots, limit);
  if (!pub.length) return '';

  /** @type {Map<string, string[]>} */
  const byDay = new Map();
  for (const s of pub) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.fecha);
    let dayKey = s.fecha;
    if (m) {
      const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      const name = DAY_UPPER[dt.getDay()] || s.fecha;
      dayKey = `${name} ${Number(m[3])} ${MONTH_SHORT[Number(m[2]) - 1] || ''}`.trim();
    }
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(`• ${s.horaInicio}–${s.horaFin}`);
  }

  return [...byDay.entries()]
    .map(([day, hours]) => `${day}:\n${hours.join('\n')}`)
    .join('\n');
}

/** Cache corta para no martillar el panel en cada mensaje. */
const slotsCache = new Map();
const SLOTS_CACHE_TTL_MS = 60 * 1000;

/**
 * @param {{ fechaInicio?: string, fechaFin?: string, slotMinutos?: number }} opts
 */
async function getAggregatedSlotsCached(opts = {}) {
  const key = `${opts.fechaInicio || ''}|${opts.fechaFin || ''}|${opts.slotMinutos || ''}`;
  const hit = slotsCache.get(key);
  if (hit && Date.now() - hit.at < SLOTS_CACHE_TTL_MS) {
    return hit.data;
  }
  const data = await getAggregatedSlots(opts);
  slotsCache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = {
  slotKey,
  formatSlotLabel,
  collectGerenteEmails,
  mergePanelDisponibilidad,
  getAggregatedSlots,
  getAggregatedSlotsCached,
  publicSlots,
  formatSlotsForPrompt
};
