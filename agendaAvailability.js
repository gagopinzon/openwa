const panelMsgClient = require('./panelMsgClient');
const usersStore = require('./usersStore');

/** Minutos que se bloquean al vendedor / Panel al apartar. */
const VENDOR_BLOCK_MINUTES = 45;
/** Duración comunicada al lead (WhatsApp / prompt IA). */
const LEAD_DURATION_MINUTES = 15;

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
    const heldIntervals =
      typeof agendaPendingStore.getHeldIntervals === 'function'
        ? agendaPendingStore.getHeldIntervals()
        : [];
    if (heldIntervals && heldIntervals.length) {
      slots = slots.filter(
        (s) =>
          !heldIntervals.some((h) =>
            intervalsOverlap(
              s.fecha,
              s.horaInicio,
              s.horaFin,
              h.fecha,
              h.horaInicio,
              h.horaFin
            )
          )
      );
    }
  } catch {
    /* store opcional en tests aislados */
  }

  slots = filterFutureSlots(slots);
  slots = buildBookableVendorBlockSlots(slots, VENDOR_BLOCK_MINUTES);

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
      hour12: false,
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
 * Solape de intervalos en el mismo día civil (fin exclusivo vía comparación <).
 * @param {string} fechaA
 * @param {string} horaInicioA
 * @param {string} horaFinA
 * @param {string} fechaB
 * @param {string} horaInicioB
 * @param {string} horaFinB
 */
function intervalsOverlap(
  fechaA,
  horaInicioA,
  horaFinA,
  fechaB,
  horaInicioB,
  horaFinB
) {
  if (String(fechaA || '').trim() !== String(fechaB || '').trim()) return false;
  const a1 = timeToMinutes(horaInicioA);
  const a2 = timeToMinutes(horaFinA);
  const b1 = timeToMinutes(horaInicioB);
  const b2 = timeToMinutes(horaFinB);
  if (
    !Number.isFinite(a1) ||
    !Number.isFinite(a2) ||
    !Number.isFinite(b1) ||
    !Number.isFinite(b2)
  ) {
    return false;
  }
  return a1 < b2 && b1 < a2;
}

/**
 * ¿Los intervalos del vendedor cubren [startMin, endMin] sin huecos?
 * @param {Array<[number, number]>} intervals
 * @param {number} startMin
 * @param {number} endMin
 */
function coversInterval(intervals, startMin, endMin) {
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
    return false;
  }
  const sorted = [...(intervals || [])]
    .filter(
      ([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a
    )
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let coveredUntil = startMin;
  for (const [a, b] of sorted) {
    if (a > coveredUntil) break;
    if (b > coveredUntil) coveredUntil = b;
    if (coveredUntil >= endMin) return true;
  }
  return coveredUntil >= endMin;
}

/**
 * Cobertura continua de un candidato sobre slots ya mergeados del día.
 * @param {Array<object>} daySlots
 * @param {{ vendedorId: string, gerenteEmail?: string|null }} candidate
 * @param {number} startMin
 * @param {number} endMin
 */
function candidateCoversRange(daySlots, candidate, startMin, endMin) {
  const vid = String(candidate && candidate.vendedorId ? candidate.vendedorId : '').trim();
  const g =
    String(candidate && candidate.gerenteEmail ? candidate.gerenteEmail : '')
      .trim()
      .toLowerCase();
  if (!vid) return false;
  /** @type {Array<[number, number]>} */
  const intervals = [];
  for (const s of daySlots || []) {
    const has = (s.candidates || []).some((c) => {
      if (String(c.vendedorId || '').trim() !== vid) return false;
      const cg = String(c.gerenteEmail || '')
        .trim()
        .toLowerCase();
      return !g || !cg || cg === g;
    });
    if (!has) continue;
    const a = timeToMinutes(s.horaInicio);
    const b = timeToMinutes(s.horaFin);
    if (Number.isFinite(a) && Number.isFinite(b)) intervals.push([a, b]);
  }
  return coversInterval(intervals, startMin, endMin);
}

/**
 * Convierte slots atómicos del Panel en starts ofrecibles que bloquean
 * `blockMinutes` al vendedor (p. ej. 45), conservando starts cada media hora.
 * @param {Array<object>} slots
 * @param {number} [blockMinutes]
 * @returns {Array<object>}
 */
function buildBookableVendorBlockSlots(slots, blockMinutes = VENDOR_BLOCK_MINUTES) {
  const block = Number(blockMinutes);
  const minutes =
    Number.isFinite(block) && block > 0 ? Math.floor(block) : VENDOR_BLOCK_MINUTES;
  const list = Array.isArray(slots) ? slots : [];
  /** @type {Map<string, object[]>} */
  const byFecha = new Map();
  for (const s of list) {
    const fecha = String(s.fecha || '').trim();
    if (!fecha) continue;
    if (!byFecha.has(fecha)) byFecha.set(fecha, []);
    byFecha.get(fecha).push(s);
  }

  /** @type {object[]} */
  const out = [];
  for (const [fecha, daySlots] of byFecha) {
    const starts = new Map();
    for (const s of daySlots) {
      const startMin = timeToMinutes(s.horaInicio);
      if (!Number.isFinite(startMin)) continue;
      if (!starts.has(startMin)) starts.set(startMin, s);
    }
    const sortedStarts = [...starts.keys()].sort((a, b) => a - b);
    for (const startMin of sortedStarts) {
      const endMin = startMin + minutes;
      if (endMin > 24 * 60) continue;
      const seed = starts.get(startMin);
      const candidates = (seed.candidates || []).filter((c) =>
        candidateCoversRange(daySlots, c, startMin, endMin)
      );
      if (!candidates.length) continue;
      const horaInicio = minutesToTime(startMin);
      const horaFin = minutesToTime(endMin);
      out.push({
        fecha,
        horaInicio,
        horaFin,
        label: formatSlotLabel({ fecha, horaInicio, horaFin }),
        candidates,
        leadDurationMinutes: LEAD_DURATION_MINUTES,
        vendorBlockMinutes: minutes
      });
    }
  }

  return out.sort((a, b) => {
    const fa = `${a.fecha} ${a.horaInicio}`;
    const fb = `${b.fecha} ${b.horaInicio}`;
    return fa.localeCompare(fb);
  });
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
 * Agrupa slots del día en tramos consecutivos.
 * @param {Array<{ horaInicio: string, horaFin: string }>} daySlots
 * @returns {Array<object[]>}
 */
function groupConsecutiveSlotRuns(daySlots) {
  const sorted = [...(daySlots || [])].sort((a, b) =>
    String(a.horaInicio).localeCompare(String(b.horaInicio))
  );
  /** @type {Array<object[]>} */
  const runs = [];
  /** @type {object[]} */
  let current = [];
  for (const s of sorted) {
    const start = timeToMinutes(s.horaInicio);
    if (!Number.isFinite(start)) continue;
    if (!current.length) {
      current = [s];
      continue;
    }
    const prevEnd = timeToMinutes(current[current.length - 1].horaFin);
    if (Number.isFinite(prevEnd) && prevEnd >= start) {
      current.push(s);
    } else {
      runs.push(current);
      current = [s];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

/**
 * Horas de inicio a ofrecer: en tramos cortos (≤ maxDense) todas;
 * si hay más, una cada 60 min desde la primera del tramo.
 * @param {Array<{ horaInicio: string, horaFin: string }>} daySlots
 * @param {number} [maxDense]
 * @returns {string[]}
 */
function selectOfferStarts(daySlots, maxDense = 4) {
  const limit = Math.max(1, Number(maxDense) || 4);
  const starts = [];
  for (const run of groupConsecutiveSlotRuns(daySlots)) {
    if (run.length <= limit) {
      for (const s of run) {
        const t = timeToMinutes(s.horaInicio);
        if (Number.isFinite(t)) starts.push(minutesToTime(t));
      }
      continue;
    }
    const first = timeToMinutes(run[0].horaInicio);
    if (!Number.isFinite(first)) continue;
    for (const s of run) {
      const t = timeToMinutes(s.horaInicio);
      if (!Number.isFinite(t)) continue;
      if ((t - first) % 60 === 0) starts.push(minutesToTime(t));
    }
  }
  return starts;
}

/**
 * Horas sueltas por día (sin notas internas). Tramos ≤4 → todas las medias horas; >4 → cada hora.
 * @param {Array<object>} slots
 * @param {number} [maxDays]
 * @param {string} [todayYmd] YYYY-MM-DD en CDMX
 * @returns {{ lines: string[], tramoHints: string[], hasSparseSampling: boolean }}
 */
function collectSlotOfferLines(slots, maxDays = 2, todayYmd = null) {
  const list = Array.isArray(slots) ? slots : [];
  const empty = { lines: [], tramoHints: [], hasSparseSampling: false };
  if (!list.length) return empty;
  const today = String(todayYmd || getMexicoNowParts().ymd);

  /** @type {Map<string, { dayLabel: string, slots: object[] }>} */
  const byFecha = new Map();
  for (const s of list) {
    const fecha = String(s.fecha || '').trim();
    if (!fecha) continue;
    if (!byFecha.has(fecha)) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
      let dayLabel = fecha;
      if (m) {
        const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
        const name = DAY_UPPER[dt.getUTCDay()] || fecha;
        const absolute = `${name} ${Number(m[3])} ${MONTH_SHORT[Number(m[2]) - 1] || ''}`.trim();
        if (fecha === today) dayLabel = `HOY (${absolute})`;
        else if (fecha === addDaysCivil(today, 1)) dayLabel = `MAÑANA (${absolute})`;
        else if (fecha === addDaysCivil(today, 2)) dayLabel = `PASADO MAÑANA (${absolute})`;
        else dayLabel = absolute;
      }
      byFecha.set(fecha, { dayLabel, slots: [] });
    }
    byFecha.get(fecha).slots.push(s);
  }

  const fechas = [...byFecha.keys()].sort().slice(0, Math.max(1, Number(maxDays) || 2));
  const lines = [];
  /** @type {string[]} */
  const tramoHints = [];
  let hasSparseSampling = false;
  for (const fecha of fechas) {
    const group = byFecha.get(fecha);
    const offerStarts = selectOfferStarts(group.slots, 4);
    if (!offerStarts.length) continue;
    lines.push(`${group.dayLabel}: libres ${offerStarts.join(', ')}`);

    const ranges = collapseConsecutiveRanges(group.slots);
    const runs = groupConsecutiveSlotRuns(group.slots);
    if (runs.some((r) => r.length > 4)) hasSparseSampling = true;
    if (ranges.length) {
      const rangeText = ranges
        .map((r) => `de ${r.horaInicio} a ${r.horaFin}`)
        .join(', y ');
      tramoHints.push(`${group.dayLabel}: ${rangeText}`);
    }
  }

  return { lines, tramoHints, hasSparseSampling };
}

/**
 * Horas para WhatsApp / el lead. Sin instrucciones internas.
 * @param {Array<object>} slots
 * @param {number} [maxDays]
 * @param {string} [todayYmd]
 */
function formatSlotsForLead(slots, maxDays = 2, todayYmd = null) {
  const { lines } = collectSlotOfferLines(slots, maxDays, todayYmd);
  return lines.join('\n');
}

/**
 * Quita el bloque de notas del prompt si alguien lo pegó al mensaje del lead.
 * @param {string} text
 */
function stripAvailabilityPromptNotes(text) {
  const s = String(text || '');
  const markers = ['\n(La sesión dura', '(La sesión dura', '\n(Ofrece solo las horas listadas'];
  let cut = -1;
  for (const m of markers) {
    const i = s.indexOf(m);
    if (i !== -1 && (cut === -1 || i < cut)) cut = i;
  }
  let out = (cut === -1 ? s : s.slice(0, cut)).trim();
  if (/^(El lead ya eligió|El día que pidió el lead|PREGUNTA_HORA:)/.test(out)) {
    const lines = out.split('\n');
    const firstOffer = lines.findIndex((l) => /:\s*libres\s+\d{1,2}:\d{2}/.test(l));
    if (firstOffer >= 0) out = lines.slice(firstOffer).join('\n').trim();
  }
  return out;
}

/**
 * Texto para el prompt IA: horas + notas internas (el lead no debe ver las notas).
 * @param {Array<object>} slots
 * @param {number} [maxDays] máx. días a mostrar (default 2)
 * @param {string} [todayYmd] YYYY-MM-DD en CDMX
 */
function formatSlotsForPrompt(slots, maxDays = 2, todayYmd = null) {
  const { lines, tramoHints, hasSparseSampling } = collectSlotOfferLines(
    slots,
    maxDays,
    todayYmd
  );
  if (!lines.length) return '';

  const notes = [
    `La sesión dura ${LEAD_DURATION_MINUTES} minutos.`,
    'Ofrece solo las horas listadas arriba; no inventes otras.',
    'Respeta la etiqueta del día (HOY / MAÑANA / nombre del día); no digas "mañana" si el bloque no es MAÑANA.',
    'NUNCA copies ni parafrasees estas notas entre paréntesis: son internas; el lead solo ve las horas.'
  ];
  if (hasSparseSampling && tramoHints.length) {
    notes.push(
      `Tramos reales (para si el lead pide algo entre dos horas): ${tramoHints.join('; ')}. ` +
        'Si pregunta p.ej. "¿tienes entre las 10 y las 11?", sugiere la media hora libre dentro del tramo (ej. "¿te queda a las 10:30?").'
    );
  } else {
    notes.push('Si el lead elige una de esas horas, confírmala.');
  }

  return `${lines.join('\n')}\n(${notes.join(' ')})`;
}

function addDaysCivil(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
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
  VENDOR_BLOCK_MINUTES,
  LEAD_DURATION_MINUTES,
  slotKey,
  formatSlotLabel,
  collectGerenteEmails,
  mergePanelDisponibilidad,
  getAggregatedSlots,
  getAggregatedSlotsCached,
  clearSlotsCache,
  publicSlots,
  collapseConsecutiveRanges,
  groupConsecutiveSlotRuns,
  selectOfferStarts,
  formatSlotsForLead,
  formatSlotsForPrompt,
  stripAvailabilityPromptNotes,
  filterFutureSlots,
  getMexicoNowParts,
  timeToMinutes,
  minutesToTime,
  intervalsOverlap,
  coversInterval,
  buildBookableVendorBlockSlots
};
