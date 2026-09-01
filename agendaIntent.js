const { slotKey } = require('./agendaAvailability');

const TZ = 'America/Mexico_City';

const WEEKDAY_NAMES = {
  domingo: 0,
  dom: 0,
  lunes: 1,
  lun: 1,
  martes: 2,
  mar: 2,
  miercoles: 3,
  miércoles: 3,
  mie: 3,
  mié: 3,
  jueves: 4,
  jue: 4,
  viernes: 5,
  vie: 5,
  sabado: 6,
  sábado: 6,
  sab: 6,
  sáb: 6
};

const SCHEDULE_RE =
  /\b(agendar|agenda|cita|disponib|horario|horarios|mañana|manana|hoy|esta\s+semana|próxim|proxim|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|\d{1,2}:\d{2}|\d{1,2}\s*(am|pm)|a\s+las)\b/i;

const REJECT_RE =
  /\b(no\s+me\s+interesa|no\s+gracias|deja\s+de\s+escribir|bloquear|spam|no\s+molestar)\b/i;

/**
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD en CDMX
 */
function todayYmd(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

/**
 * @param {string} ymd
 * @param {number} days
 */
function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * @param {string} ymd
 * @returns {number} 0=dom … 6=sáb
 */
function weekdayOfYmd(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/**
 * @param {string} text
 */
function looksLikeScheduleIntent(text) {
  return SCHEDULE_RE.test(String(text || ''));
}

/**
 * En el playbook de Mónica casi siempre se cierran con horarios.
 * Solo se omite en rechazos claros.
 * @param {string} text
 */
function shouldOfferSlots(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (REJECT_RE.test(raw)) return false;
  return true;
}

/**
 * Interpreta el mensaje y devuelve un rango de fechas a consultar.
 * @param {string} text
 * @param {Date} [now]
 * @returns {{ fechaInicio: string, fechaFin: string } | null}
 */
function resolveDateRangeFromMessage(text, now = new Date()) {
  const raw = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!raw.trim()) return null;

  const today = todayYmd(now);

  if (/\bhoy\b/.test(raw)) {
    return { fechaInicio: today, fechaFin: today };
  }
  if (/\bmanana\b/.test(raw)) {
    const t = addDaysYmd(today, 1);
    return { fechaInicio: t, fechaFin: t };
  }
  if (/\besta\s+semana\b/.test(raw) || /\bproxim[oa]s?\s+dias?\b/.test(raw)) {
    return { fechaInicio: today, fechaFin: addDaysYmd(today, 6) };
  }

  for (const [name, targetDow] of Object.entries(WEEKDAY_NAMES)) {
    const nameNorm = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (!new RegExp(`\\b${nameNorm}\\b`).test(raw)) continue;
    let delta = (targetDow - weekdayOfYmd(today) + 7) % 7;
    if (delta === 0 && !/\bhoy\b/.test(raw)) delta = 7;
    const day = addDaysYmd(today, delta);
    return { fechaInicio: day, fechaFin: day };
  }

  if (looksLikeScheduleIntent(text)) {
    return { fechaInicio: today, fechaFin: addDaysYmd(today, 2) };
  }

  return null;
}

/**
 * Normaliza "10", "10:00", "10 am" → "10:00" / "22:00"
 * @param {string} text
 * @returns {string[]}
 */
function extractTimesFromMessage(text) {
  const raw = String(text || '').toLowerCase();
  const out = new Set();

  const withMeridiem =
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)\b/gi;
  let m;
  while ((m = withMeridiem.exec(raw))) {
    let h = Number(m[1]);
    const min = m[2] != null ? m[2] : '00';
    const mer = m[3].replace(/\./g, '').replace(/\s/g, '').toLowerCase();
    if (mer.startsWith('p') && h < 12) h += 12;
    if (mer.startsWith('a') && h === 12) h = 0;
    out.add(`${String(h).padStart(2, '0')}:${min}`);
  }

  const hhmm = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
  while ((m = hhmm.exec(raw))) {
    out.add(`${String(m[1]).padStart(2, '0')}:${m[2]}`);
  }

  const bare = /\ba\s+las\s+(\d{1,2})\b/gi;
  while ((m = bare.exec(raw))) {
    const h = Number(m[1]);
    if (h >= 0 && h <= 23) {
      out.add(`${String(h).padStart(2, '0')}:00`);
    }
  }

  return [...out];
}

/**
 * El lead ya dijo una hora concreta (no solo "mañana" o "miércoles").
 * @param {string} text
 */
function hasExplicitTimeChoice(text) {
  return extractTimesFromMessage(text).length > 0;
}

/**
 * @param {string} text
 */
function userMentionsSendingCv(text) {
  const raw = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return /\b(cv|curriculum|curriculo|hoja\s+de\s+vida)\b/.test(raw);
}

/**
 * @param {string} text
 * @param {Array<{ fecha: string, horaInicio: string, horaFin: string }>} slots
 */
function matchSlotFromMessage(text, slots) {
  const list = Array.isArray(slots) ? slots : [];
  if (!list.length) return null;

  const times = extractTimesFromMessage(text);
  if (!times.length) return null;

  const range = resolveDateRangeFromMessage(text);
  let candidates = list;
  if (range && range.fechaInicio === range.fechaFin) {
    const daySlots = list.filter((s) => s.fecha === range.fechaInicio);
    if (daySlots.length) candidates = daySlots;
  }

  const matches = candidates.filter((s) => {
    const hi = String(s.horaInicio || '').trim();
    return times.some((t) => hi === t || hi.startsWith(t) || t.startsWith(hi.slice(0, 2)));
  });

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    // Prefer exact HH:MM
    const exact = matches.filter((s) => times.includes(String(s.horaInicio).trim()));
    if (exact.length === 1) return exact[0];
    return null;
  }

  // Index like "el 2" / "opción 1"
  const idxMatch = /\b(?:opcion|opción|el|la|numero|número|#)\s*(\d{1,2})\b/i.exec(
    String(text || '')
  );
  if (idxMatch) {
    const n = Number(idxMatch[1]);
    if (n >= 1 && n <= list.length) return list[n - 1];
  }

  return null;
}

/**
 * @param {object} slot
 */
function slotIdentity(slot) {
  return slotKey(slot.fecha, slot.horaInicio, slot.horaFin);
}

module.exports = {
  TZ,
  todayYmd,
  addDaysYmd,
  looksLikeScheduleIntent,
  shouldOfferSlots,
  resolveDateRangeFromMessage,
  extractTimesFromMessage,
  hasExplicitTimeChoice,
  userMentionsSendingCv,
  matchSlotFromMessage,
  slotIdentity
};
