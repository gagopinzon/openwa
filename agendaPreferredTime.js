const agendaIntent = require('./agendaIntent');

const ASK_PREFERRED_CONTEXT =
  'PREGUNTA_HORA: El lead quiere agendar pero aún no dijo una hora concreta. ' +
  'NO listes horarios, tramos, ni ejemplos numéricos de disponibilidad. ' +
  'Pregunta UNA sola cosa: qué horario le acomoda mejor (hoy o mañana).';

const DAY_CHOSEN_PREFIX =
  'El lead ya eligió el día. NO vuelvas a preguntar si prefiere hoy o mañana. ' +
  'Ofrece las horas libres de ese día y pregunta cuál le queda.\n';

function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatHhMm(hour, minute) {
  const h = Number(hour);
  const min = minute == null || minute === '' ? '00' : String(minute).padStart(2, '0');
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  return `${String(h).padStart(2, '0')}:${min}`;
}

/**
 * Hora que el lead pidió. "a las 5" / "a las 6" sin am/pm → tarde (17:00 / 18:00).
 * @param {string} text
 * @returns {string|null} HH:MM
 */
function agendaPreferredHhmm(text) {
  const times = agendaIntent.extractTimesFromMessage(text);
  if (!times.length) return null;

  const raw = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const hasPeriod = /(?:de\s+la|en\s+la|por\s+la)\s+(tarde|manana|noche)|\b(?:a\.?\s*m\.?|p\.?\s*m\.?|am|pm)\b/.test(
    raw
  );
  const bare = /\ba\s+las\s+(\d{1,2})\b/.exec(raw);
  if (!hasPeriod && bare) {
    const h = Number(bare[1]);
    if (h >= 1 && h <= 7) {
      const pm = formatHhMm(h + 12, '00');
      if (pm) return pm;
    }
  }
  return times[0];
}

/**
 * @param {Array<object>} slots
 * @param {string} hhmm
 * @param {{ today: string, tomorrow: string }} opts
 */
function pickExactSlotTodayOrTomorrow(slots, hhmm, opts) {
  const list = Array.isArray(slots) ? slots : [];
  const wanted = String(hhmm || '').trim();
  if (!wanted) return null;
  const today = String((opts && opts.today) || '');
  const tomorrow = String((opts && opts.tomorrow) || '');
  const hitToday = list.find(
    (s) => String(s.fecha) === today && String(s.horaInicio).trim() === wanted
  );
  if (hitToday) return hitToday;
  return (
    list.find(
      (s) => String(s.fecha) === tomorrow && String(s.horaInicio).trim() === wanted
    ) || null
  );
}

function slotDistance(slot, preferredMins) {
  const t = timeToMinutes(slot && slot.horaInicio);
  if (!Number.isFinite(t) || !Number.isFinite(preferredMins)) return Infinity;
  return Math.abs(t - preferredMins);
}

function sortByDistance(items, preferredMins) {
  return [...items].sort((a, b) => {
    const da = slotDistance(a, preferredMins);
    const db = slotDistance(b, preferredMins);
    if (da !== db) return da - db;
    const fecha = String(a.fecha).localeCompare(String(b.fecha));
    if (fecha) return fecha;
    return String(a.horaInicio).localeCompare(String(b.horaInicio));
  });
}

function interleaveDays(todaySlots, tomorrowSlots, max) {
  const out = [];
  let i = 0;
  let j = 0;
  while (out.length < max && (i < todaySlots.length || j < tomorrowSlots.length)) {
    if (i < todaySlots.length) out.push(todaySlots[i++]);
    if (out.length >= max) break;
    if (j < tomorrowSlots.length) out.push(tomorrowSlots[j++]);
  }
  return out;
}

/**
 * Hasta 6 slots en ±2h del horario pedido, hoy y mañana.
 * Si la ventana queda vacía, las más cercanas aunque salgan del rango.
 * @param {Array<object>} slots
 * @param {string} preferredHhmm
 * @param {{ today: string, tomorrow: string, windowMinutes?: number, max?: number }} opts
 */
function selectNearestInWindow(slots, preferredHhmm, opts = {}) {
  const today = String(opts.today || '');
  const tomorrow = String(opts.tomorrow || '');
  const windowMinutes = Number.isFinite(opts.windowMinutes) ? opts.windowMinutes : 120;
  const max = Number.isFinite(opts.max) ? Math.max(1, opts.max) : 6;
  const pref = timeToMinutes(preferredHhmm);
  const list = (Array.isArray(slots) ? slots : []).filter((s) => {
    const fecha = String(s.fecha || '');
    return fecha === today || fecha === tomorrow;
  });

  const inWindow = Number.isFinite(pref)
    ? list.filter((s) => slotDistance(s, pref) <= windowMinutes)
    : [];
  const pool = inWindow.length ? inWindow : list;
  const todays = sortByDistance(
    pool.filter((s) => String(s.fecha) === today),
    pref
  );
  const tomorrows = sortByDistance(
    pool.filter((s) => String(s.fecha) === tomorrow),
    pref
  );
  return interleaveDays(todays, tomorrows, max);
}

/**
 * @param {{ fecha: string, horaInicio: string }} slot
 * @param {string} today
 */
function formatConfirmReply(slot, today) {
  const hora = String((slot && slot.horaInicio) || '').trim();
  const when = String((slot && slot.fecha) || '') === String(today) ? 'hoy' : 'mañana';
  return `Perfecto, te agendo a las ${hora} ${when}, ¿te queda?`;
}

/**
 * @param {Array<object>} nearby
 * @param {string} preferredHhmm
 * @param {string} [today]
 */
function formatNearestReply(nearby, preferredHhmm, today) {
  const list = Array.isArray(nearby) ? nearby : [];
  const byFecha = new Map();
  for (const s of list) {
    const fecha = String(s.fecha || '');
    if (!byFecha.has(fecha)) byFecha.set(fecha, []);
    byFecha.get(fecha).push(String(s.horaInicio).trim());
  }
  const fechas = [...byFecha.keys()].sort();
  const todayYmd = today ? String(today) : fechas[0];
  const lines = fechas.map((fecha) => {
    const label = fecha === todayYmd ? 'Hoy' : 'Mañana';
    return `${label}: ${byFecha.get(fecha).join(', ')}`;
  });
  const hora = String(preferredHhmm || '').trim() || 'esa hora';
  if (!lines.length) {
    return `A las ${hora} no hay hueco. ¿Te late otra hora hoy o mañana?`;
  }
  return (
    `A las ${hora} no hay hueco. Las más cercanas son:\n` +
    `${lines.join('\n')}\n¿Cuál te queda?`
  );
}

function dayOptsFromRange(range, today, tomorrow) {
  if (range && range.fechaInicio && range.fechaInicio === range.fechaFin) {
    return { today: range.fechaInicio, tomorrow: range.fechaInicio };
  }
  return { today, tomorrow };
}

/**
 * @param {string} body
 * @param {Array<object>} slots
 * @param {{ today: string, tomorrow: string, now?: Date }} opts
 * @returns {{ action: 'ask'|'list'|'confirm'|'nearest', slot?: object, nearby?: object[], preferredTime?: string }}
 */
function resolvePreferredTimeOffer(body, slots, opts = {}) {
  const today = String(opts.today || agendaIntent.todayYmd(opts.now));
  const tomorrow =
    String(opts.tomorrow || '') || agendaIntent.addDaysYmd(today, 1);
  const hhmm = agendaPreferredHhmm(body);
  const range = agendaIntent.resolveDateRangeFromMessage(body, opts.now);
  if (!hhmm) {
    if (range && range.fechaInicio === range.fechaFin) {
      return { action: 'list' };
    }
    return { action: 'ask' };
  }

  const days = dayOptsFromRange(range, today, tomorrow);
  const searchDays =
    days.today === days.tomorrow
      ? (Array.isArray(slots) ? slots : []).filter((s) => String(s.fecha) === days.today)
      : slots;

  const exact = pickExactSlotTodayOrTomorrow(searchDays, hhmm, days);
  if (exact) {
    return { action: 'confirm', slot: exact, preferredTime: hhmm };
  }
  const nearby = selectNearestInWindow(searchDays, hhmm, {
    today: days.today,
    tomorrow: days.tomorrow
  });
  return { action: 'nearest', nearby, preferredTime: hhmm };
}

function isAskPreferredContext(agendaContext) {
  return String(agendaContext || '').startsWith('PREGUNTA_HORA:');
}

module.exports = {
  ASK_PREFERRED_CONTEXT,
  DAY_CHOSEN_PREFIX,
  agendaPreferredHhmm,
  pickExactSlotTodayOrTomorrow,
  selectNearestInWindow,
  formatConfirmReply,
  formatNearestReply,
  resolvePreferredTimeOffer,
  isAskPreferredContext
};
