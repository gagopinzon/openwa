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

/** Interés explícito en agendar (no un "ok" genérico a otra pregunta). */
const BOOKING_INTEREST_RE =
  /\b(me interesa|si me interesa|sí me interesa|claro que si|claro que sí|quiero agendar|me gustaria agendar|me gustaría agendar|agendemos|cuando pueden|cuando podemos|cuándo pueden|cuándo podemos|quiero la sesion|quiero la sesión|me gustaria la sesion|me gustaría la sesión)\b/i;

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
 * El lead muestra interés concreto en agendar (no solo afirmación genérica).
 * @param {string} text
 */
function looksLikeBookingInterest(text) {
  return BOOKING_INTEREST_RE.test(foldAgendaText(text));
}

/**
 * ¿Debemos inyectar horarios reales en el prompt?
 * Solo cuando el lead pide agenda, confirma hora o dice explícitamente que le interesa agendar.
 * @param {string} text
 */
function shouldOfferSlots(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (REJECT_RE.test(raw)) return false;
  if (looksLikeScheduleIntent(raw)) return true;
  if (hasExplicitTimeChoice(raw)) return true;
  if (looksLikeBookingInterest(raw)) return true;
  return false;
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

function foldAgendaText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function formatHhMm(hour, minute) {
  const h = Number(hour);
  const min = minute == null || minute === '' ? '00' : String(minute).padStart(2, '0');
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  return `${String(h).padStart(2, '0')}:${min}`;
}

/**
 * @param {number} hour
 * @param {string} minute
 * @param {'manana'|'tarde'|'noche'} period
 */
function applyDayPeriod(hour, minute, period) {
  let h = Number(hour);
  if (!Number.isFinite(h)) return null;
  if (period === 'manana') {
    if (h === 12) h = 0;
  } else if (period === 'tarde' || period === 'noche') {
    if (h === 12 && period === 'noche') h = 0;
    else if (h > 0 && h < 12) h += 12;
  }
  return formatHhMm(h, minute);
}

/**
 * Normaliza "10", "10:00", "10 am", "5 de la tarde" → "10:00" / "17:00"
 * @param {string} text
 * @returns {string[]}
 */
function extractTimesFromMessage(text) {
  const raw = foldAgendaText(text);
  const out = new Set();
  const consumed = [];

  function overlaps(index, length) {
    const end = index + length;
    return consumed.some((c) => index < c.end && end > c.start);
  }

  function consume(index, length) {
    consumed.push({ start: index, end: index + length });
  }

  const withMeridiem =
    /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)\b/gi;
  let m;
  while ((m = withMeridiem.exec(raw))) {
    let h = Number(m[1]);
    const min = m[2] != null ? m[2] : '00';
    const mer = m[3].replace(/\./g, '').replace(/\s/g, '').toLowerCase();
    if (mer.startsWith('p') && h < 12) h += 12;
    if (mer.startsWith('a') && h === 12) h = 0;
    const hhmm = formatHhMm(h, min);
    if (hhmm) {
      out.add(hhmm);
      consume(m.index, m[0].length);
    }
  }

  const withPeriod =
    /\b(?:a\s+las\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:hrs?|horas?)?\s*(?:de\s+la|en\s+la|por\s+la)\s+(tarde|manana|noche)\b/gi;
  while ((m = withPeriod.exec(raw))) {
    if (overlaps(m.index, m[0].length)) continue;
    const hhmm = applyDayPeriod(Number(m[1]), m[2], m[3]);
    if (hhmm) {
      out.add(hhmm);
      consume(m.index, m[0].length);
    }
  }

  const hhmmRe = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
  while ((m = hhmmRe.exec(raw))) {
    if (overlaps(m.index, m[0].length)) continue;
    const hhmm = formatHhMm(m[1], m[2]);
    if (hhmm) out.add(hhmm);
  }

  const bare = /\ba\s+las\s+(\d{1,2})\b/gi;
  while ((m = bare.exec(raw))) {
    if (overlaps(m.index, m[0].length)) continue;
    const hhmm = formatHhMm(m[1], '00');
    if (hhmm) out.add(hhmm);
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
 * Confirmación corta de un horario ya propuesto ("sí", "está perfecto").
 * No cubre "sí me interesa" (interés inicial).
 * @param {string} text
 */
function looksLikeTimeConfirmYes(text) {
  const raw = foldAgendaText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return false;
  if (resolveDateRangeFromMessage(raw)) return false;
  if (hasExplicitTimeChoice(raw)) return false;

  if (
    /^(si|sip|ok|okay|vale|listo|perfecto|va|dale|claro|de acuerdo|confirmo|excelente)([.!\s]*)$/.test(
      raw
    )
  ) {
    return true;
  }
  if (
    /^(si|ok|vale)\s+(esta\s+)?(perfecto|bien|ok|va|genial|excelente|me\s+(queda|sirve|parece)|confirmo)\b/.test(
      raw
    )
  ) {
    return true;
  }
  if (/^(esta|ta)\s+(perfecto|bien|ok)([.!\s]*)$/.test(raw)) return true;
  return false;
}

/**
 * Hora que el bot acaba de proponer ("¿te funciona a las 17:00?"),
 * no los extremos de un rango de disponibilidad.
 * @param {string} text
 * @returns {string[]}
 */
function extractProposedTimesFromBotText(text) {
  const raw = foldAgendaText(text);
  if (!raw.trim()) return [];
  const out = [];
  const aLas = [...raw.matchAll(/a\s+las\s+(\d{1,2}(?::\d{2})?)/gi)];
  for (const m of aLas) {
    for (const t of extractTimesFromMessage(m[0])) out.push(t);
  }
  if (out.length) return [...new Set(out)];

  const hrs = [...raw.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\s*hrs?\b/gi)];
  for (const m of hrs) {
    const hhmm = formatHhMm(m[1], m[2]);
    if (hhmm) out.push(hhmm);
  }
  return [...new Set(out)];
}

/**
 * @param {Array<{ body?: string, fromMe?: boolean, timestamp?: number }>} messages
 */
function lastFromMeBody(messages) {
  const list = Array.isArray(messages) ? [...messages] : [];
  list.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const body = String((list[i] && list[i].body) || '').trim();
    if (list[i] && list[i].fromMe && body) return body;
  }
  return '';
}

/**
 * Último mensaje propio que sí propone una hora ("a las 17:00"),
 * aunque después el bot se haya desviado a preguntar el día otra vez.
 * @param {Array<{ body?: string, fromMe?: boolean, timestamp?: number }>} messages
 */
function lastBotProposalText(messages) {
  const list = Array.isArray(messages) ? [...messages] : [];
  list.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i] || !list[i].fromMe) continue;
    const body = String(list[i].body || '').trim();
    if (!body) continue;
    if (extractProposedTimesFromBotText(body).length) return body;
  }
  return lastFromMeBody(list);
}

/**
 * Si pidió las 5 y no hay 05:00 pero sí 17:00, usa la tarde.
 * @param {string[]} times
 * @param {Set<string>} slotStarts
 */
function expandTimesAgainstSlots(times, slotStarts) {
  const out = new Set(times);
  for (const t of times) {
    const [hs, ms] = String(t).split(':');
    const h = Number(hs);
    if (h >= 1 && h <= 11) {
      const pm = formatHhMm(h + 12, ms);
      if (pm && !slotStarts.has(t) && slotStarts.has(pm)) out.add(pm);
    }
  }
  return [...out];
}

/**
 * @param {string[]} times
 * @param {Array<{ fecha: string, horaInicio: string, horaFin: string }>} candidates
 */
function pickSlotForTimes(times, candidates) {
  const exact = candidates.filter((s) =>
    times.includes(String(s.horaInicio || '').trim())
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const loose = candidates.filter((s) => {
    const hi = String(s.horaInicio || '').trim();
    return times.some(
      (t) => hi === t || hi.startsWith(t) || t.startsWith(hi.slice(0, 2))
    );
  });
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) {
    const exactLoose = loose.filter((s) =>
      times.includes(String(s.horaInicio).trim())
    );
    if (exactLoose.length === 1) return exactLoose[0];
    return null;
  }
  return null;
}

function uniqueWeekdayDateRange(text, now) {
  const raw = foldAgendaText(text);
  if (!raw.trim()) return null;
  const found = new Set();
  const fullNames = [
    'domingo',
    'lunes',
    'martes',
    'miercoles',
    'jueves',
    'viernes',
    'sabado'
  ];
  for (const name of fullNames) {
    if (new RegExp(`\\b${name}\\b`).test(raw)) found.add(WEEKDAY_NAMES[name]);
  }
  if (found.size !== 1) return null;
  return resolveDateRangeFromMessage(text, now);
}

function matchIndexChoice(text, list) {
  const idxMatch = /\b(?:opcion|opción|el|la|numero|número|#)\s*(\d{1,2})\b/i.exec(
    String(text || '')
  );
  if (!idxMatch) return null;
  const n = Number(idxMatch[1]);
  if (n >= 1 && n <= list.length) return list[n - 1];
  return null;
}

/**
 * @param {string} text
 */
function userMentionsSendingCv(text) {
  const raw = foldAgendaText(text);
  return /\b(cv|curriculum|curriculo|hoja\s+de\s+vida)\b/.test(raw);
}

/**
 * @param {string} text
 * @param {Array<{ fecha: string, horaInicio: string, horaFin: string }>} slots
 * @param {{ now?: Date, lastBotText?: string, proposedTimes?: string[] }} [opts]
 */
function matchSlotFromMessage(text, slots, opts = {}) {
  const list = Array.isArray(slots) ? slots : [];
  if (!list.length) return null;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const confirming = looksLikeTimeConfirmYes(text);

  let times = extractTimesFromMessage(text);
  if (!times.length && confirming) {
    const fromBot = extractProposedTimesFromBotText(opts.lastBotText || '');
    const fromOffer = (Array.isArray(opts.proposedTimes) ? opts.proposedTimes : [])
      .map((t) => String(t || '').trim())
      .filter(Boolean);
    times = fromBot.length ? fromBot : fromOffer;
  }

  if (!times.length) return matchIndexChoice(text, list);

  const range =
    resolveDateRangeFromMessage(text, now) ||
    uniqueWeekdayDateRange(opts.lastBotText || '', now);
  let candidates = list;
  if (range && range.fechaInicio === range.fechaFin) {
    const daySlots = list.filter((s) => s.fecha === range.fechaInicio);
    if (daySlots.length) candidates = daySlots;
  }

  const slotStarts = new Set(
    candidates.map((s) => String(s.horaInicio || '').trim())
  );
  times = expandTimesAgainstSlots(times, slotStarts);

  const hit = pickSlotForTimes(times, candidates);
  if (hit) return hit;
  if (confirming && times.length) {
    const allStarts = new Set(list.map((s) => String(s.horaInicio || '').trim()));
    const expanded = expandTimesAgainstSlots(times, allStarts);
    const fallback = pickSlotForTimes(expanded, list);
    if (fallback) return fallback;
  }

  return matchIndexChoice(text, list);
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
  looksLikeBookingInterest,
  shouldOfferSlots,
  resolveDateRangeFromMessage,
  extractTimesFromMessage,
  hasExplicitTimeChoice,
  looksLikeTimeConfirmYes,
  extractProposedTimesFromBotText,
  lastFromMeBody,
  lastBotProposalText,
  userMentionsSendingCv,
  matchSlotFromMessage,
  slotIdentity
};
