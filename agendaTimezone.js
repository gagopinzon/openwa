'use strict';

const CENTRO_TZ = 'America/Mexico_City';

/** @type {Array<{ keys: string[], timeZone: string, label: string }>} */
const TZ_REGIONS = [
  {
    keys: [
      'hermosillo',
      'sonora',
      'ciudad obregon',
      'obregon',
      'nogales',
      'guaymas',
      'navojoa',
      'caborca'
    ],
    timeZone: 'America/Hermosillo',
    label: 'Hermosillo'
  },
  {
    keys: [
      'cancun',
      'cancún',
      'quintana roo',
      'playa del carmen',
      'tulum',
      'chetumal',
      'cozumel'
    ],
    timeZone: 'America/Cancun',
    label: 'Cancún'
  },
  {
    keys: [
      'tijuana',
      'mexicali',
      'ensenada',
      'baja california',
      'bcn',
      'rosarito'
    ],
    timeZone: 'America/Tijuana',
    label: 'Tijuana'
  },
  {
    keys: [
      'culiacan',
      'culiacán',
      'mazatlan',
      'mazatlán',
      'sinaloa',
      'la paz',
      'los cabos',
      'cabo san lucas',
      'baja california sur',
      'bcs',
      'tepíc',
      'tepic',
      'nayarit'
    ],
    timeZone: 'America/Mazatlan',
    label: 'Mazatlán'
  },
  {
    keys: [
      'monterrey',
      'guadalajara',
      'zapopan',
      'cdmx',
      'ciudad de mexico',
      'ciudad de méxico',
      'mexico city',
      'df',
      'jalisco',
      'nuevo leon',
      'nuevo león',
      'centro',
      'hora centro',
      'hora del centro',
      'zona centro'
    ],
    timeZone: CENTRO_TZ,
    label: 'hora del centro'
  }
];

const PERIOD_WORDS = new Set(['tarde', 'manana', 'mañana', 'noche', 'madrugada', 'manana']);

/**
 * @param {string} text
 */
function foldTzText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} folded
 * @param {string} key
 */
function hasKey(folded, key) {
  const k = foldTzText(key);
  if (!k) return false;
  if (k.includes(' ')) return folded.includes(k);
  return new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(folded);
}

/**
 * @param {string} text
 * @returns {{ timeZone: string, label: string, key: string } | null}
 */
function detectTimezoneMention(text) {
  const folded = foldTzText(text);
  if (!folded) return null;

  // Evitar "de la tarde/mañana/noche"
  const cleaned = folded.replace(
    /\b(?:de\s+la|en\s+la|por\s+la)\s+(tarde|manana|noche|madrugada)\b/g,
    ' '
  );

  for (const region of TZ_REGIONS) {
    for (const key of region.keys) {
      if (hasKey(cleaned, key)) {
        if (PERIOD_WORDS.has(foldTzText(key))) continue;
        return {
          timeZone: region.timeZone,
          label: region.label,
          key
        };
      }
    }
  }
  return null;
}

/**
 * @param {Date} date
 * @param {string} timeZone
 */
function partsInZone(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value])
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hhmm: `${String(hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    minutes: hour * 60 + Number(parts.minute)
  };
}

/**
 * Instante UTC cuyo reloj civil en `timeZone` es ymd + hhmm.
 * @param {string} ymd
 * @param {string} hhmm
 * @param {string} timeZone
 */
function zonedWallTimeToUtcMs(ymd, hhmm, timeZone) {
  const [y, mo, d] = String(ymd).split('-').map(Number);
  const [hh, mi] = String(hhmm).split(':').map(Number);
  if (![y, mo, d, hh, mi].every((n) => Number.isFinite(n))) return NaN;

  let utc = Date.UTC(y, mo - 1, d, hh, mi, 0);
  for (let i = 0; i < 4; i += 1) {
    const asTz = partsInZone(new Date(utc), timeZone);
    const desiredMins = hh * 60 + mi;
    const actualMins = asTz.minutes;
    const [ay, am, ad] = asTz.ymd.split('-').map(Number);
    const dayDiff =
      Math.round(
        (Date.UTC(y, mo - 1, d) - Date.UTC(ay, am - 1, ad)) / 86400000
      ) || 0;
    const diffMs = (dayDiff * 1440 + (desiredMins - actualMins)) * 60 * 1000;
    if (diffMs === 0) break;
    utc += diffMs;
  }
  return utc;
}

/**
 * @param {string} localHhmm
 * @param {string} timeZone
 * @param {string} ymd
 * @returns {{ localHhmm: string, centroHhmm: string, timeZone: string, ymd: string, differs: boolean }}
 */
function localHhmmToCentro(localHhmm, timeZone, ymd) {
  const local = String(localHhmm || '').trim();
  const tz = String(timeZone || CENTRO_TZ).trim() || CENTRO_TZ;
  const day = String(ymd || '').trim();
  if (!/^\d{2}:\d{2}$/.test(local) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return {
      localHhmm: local,
      centroHhmm: local,
      timeZone: tz,
      ymd: day,
      differs: false
    };
  }

  if (tz === CENTRO_TZ) {
    return {
      localHhmm: local,
      centroHhmm: local,
      timeZone: tz,
      ymd: day,
      differs: false
    };
  }

  const utcMs = zonedWallTimeToUtcMs(day, local, tz);
  if (!Number.isFinite(utcMs)) {
    return {
      localHhmm: local,
      centroHhmm: local,
      timeZone: tz,
      ymd: day,
      differs: false
    };
  }

  const centro = partsInZone(new Date(utcMs), CENTRO_TZ);
  return {
    localHhmm: local,
    centroHhmm: centro.hhmm,
    timeZone: tz,
    ymd: day,
    differs: centro.hhmm !== local
  };
}

/**
 * Hora pedida en texto (sin sesgo 1–7→tarde). Usa extract simple.
 * @param {string} text
 * @returns {string|null}
 */
function extractRawPreferredHhmm(text) {
  const agendaIntent = require('./agendaIntent');
  const times = agendaIntent.extractTimesFromMessage(text);
  if (!times.length) return null;

  const raw = foldTzText(text);
  const hasPeriod =
    /(?:de\s+la|en\s+la|por\s+la)\s+(tarde|manana|noche)|\b(?:a\.?\s*m\.?|p\.?\s*m\.?|am|pm)\b/.test(
      raw
    );
  const primary = times[0];
  if (hasPeriod) return primary;

  const m = /^(\d{1,2}):(\d{2})$/.exec(String(primary || '').trim());
  if (!m) return primary;
  const h = Number(m[1]);
  const min = m[2];
  if (h >= 1 && h <= 7) {
    return `${String(h + 12).padStart(2, '0')}:${min}`;
  }
  return primary;
}

/**
 * @param {string} text
 * @param {{ ymd?: string }} [opts]
 */
function resolveLeadTimeRequest(text, opts = {}) {
  const localHhmm = extractRawPreferredHhmm(text);
  if (!localHhmm) return null;

  const mention = detectTimezoneMention(text);
  const timeZone = mention ? mention.timeZone : CENTRO_TZ;
  const label = mention ? mention.label : 'hora del centro';
  const assumedCentro = !mention;
  const ymd =
    String(opts.ymd || '').trim() ||
    require('./agendaIntent').todayYmd(opts.now instanceof Date ? opts.now : new Date());

  const converted = localHhmmToCentro(localHhmm, timeZone, ymd);
  return {
    localHhmm: converted.localHhmm,
    centroHhmm: converted.centroHhmm,
    timeZone: converted.timeZone,
    label,
    ymd,
    differs: Boolean(converted.differs),
    assumedCentro
  };
}

/**
 * @param {{ localHhmm?: string, centroHhmm?: string, label?: string, differs?: boolean, assumedCentro?: boolean }} info
 */
function formatDualTimePhrase(info = {}) {
  const local = String(info.localHhmm || '').trim();
  const centro = String(info.centroHhmm || local).trim();
  if (!centro) return '';

  if (info.differs) {
    const place = String(info.label || 'tu zona').trim();
    return `tus ${local} (${place}), ${centro} hora del centro`;
  }
  return `${centro} hora del centro`;
}

/**
 * Contexto corto para el prompt del LLM.
 * @param {object|null} request
 */
function formatTimezonePromptBlock(request) {
  if (!request || !request.centroHhmm) return '';
  if (request.differs) {
    return (
      `ZONA_HORARIA: el lead pidió ${request.localHhmm} en ${request.label} ` +
      `(${request.timeZone}). Eso equivale a ${request.centroHhmm} hora del centro. ` +
      `Agenda/internal usa SIEMPRE hora del centro (${request.centroHhmm}). ` +
      `Al confirmar, menciona ambas: ${formatDualTimePhrase(request)}.`
    );
  }
  return (
    `ZONA_HORARIA: horarios en hora del centro (CDMX). ` +
    `El lead pidió ${request.centroHhmm}; al confirmar di "hora del centro".`
  );
}

/**
 * Ajusta lista de horas extraídas del mensaje a hora centro si hay mención de zona.
 * @param {string} text
 * @param {string[]} times
 * @param {{ ymd?: string, now?: Date }} [opts]
 * @returns {{ times: string[], timezone: object|null }}
 */
function convertExtractedTimesToCentro(text, times, opts = {}) {
  const list = Array.isArray(times) ? times.filter(Boolean) : [];
  const mention = detectTimezoneMention(text);
  if (!mention || mention.timeZone === CENTRO_TZ || !list.length) {
    return {
      times: list,
      timezone: mention
        ? {
            timeZone: mention.timeZone,
            label: mention.label,
            differs: false,
            assumedCentro: false
          }
        : null
    };
  }

  const ymd =
    String(opts.ymd || '').trim() ||
    require('./agendaIntent').todayYmd(opts.now instanceof Date ? opts.now : new Date());

  const converted = [];
  let last = null;
  for (const t of list) {
    // Sesgo tarde 1–7 si no hay am/pm en el texto
    let local = t;
    const raw = foldTzText(text);
    const hasPeriod =
      /(?:de\s+la|en\s+la|por\s+la)\s+(tarde|manana|noche)|\b(?:a\.?\s*m\.?|p\.?\s*m\.?|am|pm)\b/.test(
        raw
      );
    const m = /^(\d{1,2}):(\d{2})$/.exec(local);
    if (!hasPeriod && m) {
      const h = Number(m[1]);
      if (h >= 1 && h <= 7) local = `${String(h + 12).padStart(2, '0')}:${m[2]}`;
    }
    const c = localHhmmToCentro(local, mention.timeZone, ymd);
    converted.push(c.centroHhmm);
    last = {
      localHhmm: c.localHhmm,
      centroHhmm: c.centroHhmm,
      timeZone: mention.timeZone,
      label: mention.label,
      differs: c.differs,
      assumedCentro: false
    };
  }
  return { times: [...new Set(converted)], timezone: last };
}

module.exports = {
  CENTRO_TZ,
  TZ_REGIONS,
  detectTimezoneMention,
  localHhmmToCentro,
  resolveLeadTimeRequest,
  formatDualTimePhrase,
  formatTimezonePromptBlock,
  convertExtractedTimesToCentro,
  foldTzText
};
