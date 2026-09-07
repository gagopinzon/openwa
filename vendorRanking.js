/**
 * Ranking de vendedores para auto-agenda:
 * menor carga relativa (totalCitas / ponderacionReuniones),
 * luego mayor ponderación, luego menos citas, luego vendedorId.
 */

/**
 * @param {unknown} n
 * @returns {number} 1..5
 */
function normalizePonderacion(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return Math.min(5, Math.max(1, Math.round(v)));
}

/**
 * @param {unknown} n
 * @returns {number} >= 0
 */
function normalizeTotalCitas(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

/**
 * @param {unknown} totalCitas
 * @param {unknown} ponderacion
 */
function loadRatio(totalCitas, ponderacion) {
  return normalizeTotalCitas(totalCitas) / normalizePonderacion(ponderacion);
}

/**
 * @param {{
 *   vendedorId?: string,
 *   ponderacionReuniones?: number,
 *   totalCitas?: number
 * }} a
 * @param {{
 *   vendedorId?: string,
 *   ponderacionReuniones?: number,
 *   totalCitas?: number
 * }} b
 */
function compareVendorsForSlot(a, b) {
  const ratioA = loadRatio(a && a.totalCitas, a && a.ponderacionReuniones);
  const ratioB = loadRatio(b && b.totalCitas, b && b.ponderacionReuniones);
  if (ratioA !== ratioB) return ratioA - ratioB;

  const pondA = normalizePonderacion(a && a.ponderacionReuniones);
  const pondB = normalizePonderacion(b && b.ponderacionReuniones);
  if (pondA !== pondB) return pondB - pondA;

  const citasA = normalizeTotalCitas(a && a.totalCitas);
  const citasB = normalizeTotalCitas(b && b.totalCitas);
  if (citasA !== citasB) return citasA - citasB;

  return String((a && a.vendedorId) || '').localeCompare(
    String((b && b.vendedorId) || '')
  );
}

/**
 * @param {string} gerenteEmail
 * @param {string} vendedorId
 */
function panelVendorKey(gerenteEmail, vendedorId) {
  return `${String(gerenteEmail || '').trim().toLowerCase()}|${String(vendedorId || '').trim()}`;
}

/**
 * @param {object} vendor panel vendedor
 * @param {string} fecha
 * @param {string} horaInicio
 * @param {string} horaFin
 */
function vendorHasSlot(vendor, fecha, horaInicio, horaFin) {
  const f = String(fecha || '').trim();
  const hi = String(horaInicio || '').trim();
  const hf = String(horaFin || '').trim();
  const slots = Array.isArray(vendor && vendor.disponibilidad)
    ? vendor.disponibilidad
    : [];
  return slots.some(
    (s) =>
      String(s.fecha || '').trim() === f &&
      String(s.horaInicio || '').trim() === hi &&
      String(s.horaFin || '').trim() === hf
  );
}

/**
 * @param {Array<{ gerenteEmail: string, data?: object, error?: unknown }>} responses
 * @returns {Map<string, {
 *   ponderacionReuniones: number,
 *   totalCitas: number,
 *   disponibilidad: Array<object>,
 *   nombre: string|null
 * }>}
 */
function indexPanelVendors(responses) {
  /** @type {Map<string, { ponderacionReuniones: number, totalCitas: number, disponibilidad: Array<object>, nombre: string|null }>} */
  const map = new Map();
  for (const row of responses || []) {
    if (row.error || !row.data) continue;
    const gerenteEmail = String(row.gerenteEmail || '')
      .trim()
      .toLowerCase();
    const vendedores = Array.isArray(row.data.vendedores)
      ? row.data.vendedores
      : [];
    for (const v of vendedores) {
      const vendedorId = String(v.id || v.vendedorId || '').trim();
      if (!vendedorId) continue;
      map.set(panelVendorKey(gerenteEmail, vendedorId), {
        ponderacionReuniones: normalizePonderacion(v.ponderacionReuniones),
        totalCitas: normalizeTotalCitas(v.totalCitas),
        disponibilidad: Array.isArray(v.disponibilidad) ? v.disponibilidad : [],
        nombre: v.nombre || v.correo || null
      });
    }
  }
  return map;
}

/**
 * Ordena candidatos por carga relativa / ponderación.
 * Si hay dato de panel y el vendedor ya no tiene el slot, se excluye.
 * Sin dato de panel para un candidato → defaults (pond 1, citas 0) y se mantiene.
 *
 * @param {{
 *   candidates: Array<{ vendedorId: string, gerenteEmail?: string|null }>,
 *   panelIndex?: Map<string, object>|null,
 *   fecha: string,
 *   horaInicio: string,
 *   horaFin: string
 * }} opts
 */
function rankVendorsForSlot(opts = {}) {
  const candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
  const panelIndex = opts.panelIndex;
  const fecha = String(opts.fecha || '').trim();
  const horaInicio = String(opts.horaInicio || '').trim();
  const horaFin = String(opts.horaFin || '').trim();
  const hasIndex = panelIndex && typeof panelIndex.get === 'function' && panelIndex.size > 0;

  /** @type {Array<{ vendedorId: string, gerenteEmail: string|null, ponderacionReuniones: number, totalCitas: number, nombre?: string|null }>} */
  const enriched = [];

  for (const c of candidates) {
    const vendedorId = String(c && c.vendedorId ? c.vendedorId : '').trim();
    if (!vendedorId) continue;
    const gerenteEmail =
      String((c && c.gerenteEmail) || '')
        .trim()
        .toLowerCase() || null;

    let ponderacionReuniones = 1;
    let totalCitas = 0;
    let nombre = null;

    if (hasIndex) {
      const key = panelVendorKey(gerenteEmail || '', vendedorId);
      const panel = panelIndex.get(key);
      if (panel) {
        if (fecha && horaInicio && horaFin && !vendorHasSlot(panel, fecha, horaInicio, horaFin)) {
          continue;
        }
        ponderacionReuniones = normalizePonderacion(panel.ponderacionReuniones);
        totalCitas = normalizeTotalCitas(panel.totalCitas);
        nombre = panel.nombre || null;
      }
    }

    enriched.push({
      vendedorId,
      gerenteEmail,
      ponderacionReuniones,
      totalCitas,
      nombre
    });
  }

  return enriched.sort(compareVendorsForSlot);
}

module.exports = {
  normalizePonderacion,
  normalizeTotalCitas,
  loadRatio,
  compareVendorsForSlot,
  panelVendorKey,
  vendorHasSlot,
  indexPanelVendors,
  rankVendorsForSlot
};
