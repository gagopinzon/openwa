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

  const merged = mergePanelDisponibilidad(responses);
  let slots = merged.slots || [];

  try {
    const agendaPendingStore = require('./agendaPendingStore');
    const held = agendaPendingStore.getHeldSlotKeys();
    if (held && held.size) {
      slots = slots.filter(
        (s) => !held.has(slotKey(s.fecha, s.horaInicio, s.horaFin))
      );
    }
  } catch {
    /* store opcional en tests aislados */
  }

  slots = filterFutureSlots(slots);

  return {
    slots,
    gerentesConsultados: merged.gerentesConsultados,
    erroresGerente: merged.erroresGerente
  };
}

const MEXICO_TZ = 'America/Mexico_City';

/**
 * Fecha y minutos actuales en CDMX.
 * @param {Date} [now]
 * @returns {{ ymd: string, minutes: number }}
 */
function getMexicoNowParts(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: MEXICO_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(now)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + Number(parts.minute)
  };
}

/**
 * Quita slots cuya hora de inicio ya pasó (o está a menos de leadMinutes).
 * @param {Array<object>} slots
 * @param {Date} [now]
 * @param {number} [leadMinutes] margen mínimo para poder ofrecer el slot
 */
function filterFutureSlots(slots, now = new Date(), leadMinutes = 15) {
  const { ymd, minutes } = getMexicoNowParts(now);
  const lead = Number.isFinite(leadMinutes) ? Math.max(0, leadMinutes) : 15;
  const threshold = minutes + lead;

  return (Array.isArray(slots) ? slots : []).filter((s) => {
    const fecha = String(s.fecha || '').trim();
    if (!fecha) return false;
    if (fecha > ymd) return true;
    if (fecha < ymd) return false;
    const start = timeToMinutes(s.horaInicio);
    if (!Number.isFinite(start)) return false;
    // Si el margen cruza medianoche, no queda nada hoy
    if (threshold >= 24 * 60) return false;
    return start >= threshold;
  });
}

/**
 * Vista pública para lead / API (sin candidates).
 * @param {Array<object>} slots
 * @param {number} [limit]
 */
function publicSlots(slots, limit = 8) {
  const list = Array.isArray(slots) ? slots : [];
  const n = limit == null || limit < 0 ? list.length : Math.max(0, Number(limit) || 8);
  return list.slice(0, n).map((s) => ({
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
 * @param {string} hhmm
 * @returns {number}
 */
function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * @param {number} mins
 */
function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Une bloques consecutivos del mismo día en rangos [inicio, fin].
 * @param {Array<{ horaInicio: string, horaFin: string }>} daySlots
 * @returns {Array<{ horaInicio: string, horaFin: string }>}
 */
function collapseConsecutiveRanges(daySlots) {
  const sorted = [...(daySlots || [])].sort((a, b) =>
    String(a.horaInicio).localeCompare(String(b.horaInicio))
  );
  /** @type {Array<{ horaInicio: string, horaFin: string }>} */
  const ranges = [];
  for (const s of sorted) {
    const start = timeToMinutes(s.horaInicio);
    const end = timeToMinutes(s.horaFin);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const last = ranges[ranges.length - 1];
    if (last && timeToMinutes(last.horaFin) >= start) {
      if (end > timeToMinutes(last.horaFin)) {
        last.horaFin = minutesToTime(end);
      }
    } else {
      ranges.push({
        horaInicio: minutesToTime(start),
        horaFin: minutesToTime(end)
      });
    }
  }
  return ranges;
}

/**
 * Texto breve para el prompt: rangos por día (no lista de bloques de 30 min).
 * @param {Array<object>} slots
 * @param {number} [maxDays] máx. días a mostrar
 */
function formatSlotsForPrompt(slots, maxDays = 3) {
  const list = Array.isArray(slots) ? slots : [];
  if (!list.length) return '';

  /** @type {Map<string, { dayLabel: string, slots: object[] }>} */
  const byFecha = new Map();
  for (const s of list) {
    const fecha = String(s.fecha || '').trim();
    if (!fecha) continue;
    if (!byFecha.has(fecha)) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
      let dayLabel = fecha;
      if (m) {
        const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        const name = DAY_UPPER[dt.getDay()] || fecha;
        dayLabel = `${name} ${Number(m[3])} ${MONTH_SHORT[Number(m[2]) - 1] || ''}`.trim();
      }
      byFecha.set(fecha, { dayLabel, slots: [] });
    }
    byFecha.get(fecha).slots.push(s);
  }

  const fechas = [...byFecha.keys()].sort().slice(0, Math.max(1, Number(maxDays) || 3));
  const lines = [];
  for (const fecha of fechas) {
    const group = byFecha.get(fecha);
    const ranges = collapseConsecutiveRanges(group.slots);
    if (!ranges.length) continue;
    const rangeText = ranges
      .map((r) => `de ${r.horaInicio} a ${r.horaFin}`)
      .join(', y ');
    lines.push(`${group.dayLabel}: disponible ${rangeText}`);
  }

  if (!lines.length) return '';
  return `${lines.join('\n')}\n(La sesión dura 15 minutos. Pide al lead una hora de inicio dentro de esos rangos, p.ej. "a las 10". No digas que los bloques son de 30 minutos.)`;
}

/** Cache corta para no martillar el panel en cada mensaje. */
const slotsCache = new Map();
const SLOTS_CACHE_TTL_MS = 60 * 1000;

/**
 * @param {{ fechaInicio?: string, fechaFin?: string, slotMinutos?: number }} opts
 */
async function getAggregatedSlotsCached(opts = {}) {
  const nowParts = getMexicoNowParts();
  // Bucket de 15 min para no servir cache con horas ya vencidas
  const bucket = Math.floor(nowParts.minutes / 15);
  const key = `${opts.fechaInicio || ''}|${opts.fechaFin || ''}|${opts.slotMinutos || ''}|${nowParts.ymd}|${bucket}`;
  const hit = slotsCache.get(key);
  if (hit && Date.now() - hit.at < SLOTS_CACHE_TTL_MS) {
    return {
      ...hit.data,
      slots: filterFutureSlots(hit.data.slots || [])
    };
  }
  const data = await getAggregatedSlots(opts);
  slotsCache.set(key, { at: Date.now(), data });
  return {
    ...data,
    slots: filterFutureSlots(data.slots || [])
  };
}

function clearSlotsCache() {
  slotsCache.clear();
}

module.exports = {
  slotKey,
  formatSlotLabel,
  collectGerenteEmails,
  mergePanelDisponibilidad,
  getAggregatedSlots,
  getAggregatedSlotsCached,
  clearSlotsCache,
  publicSlots,
  collapseConsecutiveRanges,
  formatSlotsForPrompt,
  filterFutureSlots,
  getMexicoNowParts
};
