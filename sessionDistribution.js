/**
 * Reparto de contactos entre sesiones por cantidad exacta de mensajes
 * (también acepta pesos relativos por compatibilidad).
 */

/**
 * @param {string[]} sessionIds
 * @param {Record<string, number|string>|null|undefined} rawWeights
 * @returns {number[]} valores positivos (0 si inválido)
 */
function readRawValues(sessionIds, rawWeights) {
  return sessionIds.map((id) => {
    const v = rawWeights && rawWeights[id] != null ? Number(rawWeights[id]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
}

/**
 * @param {string[]} sessionIds
 * @param {Record<string, number|string>|null|undefined} rawWeights
 * @returns {number[]} proporciones normalizadas (suman 1)
 */
function parseSessionWeights(sessionIds, rawWeights) {
  const n = sessionIds.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  let values = readRawValues(sessionIds, rawWeights);
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    values = sessionIds.map(() => 1);
  }

  const total = values.reduce((a, b) => a + b, 0);
  return values.map((v) => v / total);
}

/**
 * Calcula cuántos mensajes le tocan a cada sesión (método de restos mayores).
 * @param {number[]} proportions - deben sumar 1
 * @param {number} totalCount
 * @returns {number[]}
 */
function computeDistributionCounts(proportions, totalCount) {
  if (totalCount <= 0) return proportions.map(() => 0);
  if (proportions.length === 0) return [];
  if (proportions.length === 1) return [totalCount];

  const raw = proportions.map((p) => p * totalCount);
  const counts = raw.map((q) => Math.floor(q));
  let leftover = totalCount - counts.reduce((a, b) => a + b, 0);

  const remainders = raw
    .map((q, i) => ({ i, r: q - counts[i] }))
    .sort((a, b) => b.r - a.r || a.i - b.i);

  for (let k = 0; k < leftover; k++) {
    counts[remainders[k % remainders.length].i]++;
  }

  return counts;
}

/**
 * Interpreta sessionWeights como cantidades exactas de mensajes.
 * Si la suma coincide con totalCount, se usan tal cual.
 * Si no, se normalizan proporcionalmente para cubrir totalCount.
 *
 * @param {string[]} sessionIds
 * @param {Record<string, number|string>|null|undefined} rawCounts
 * @param {number} totalCount
 * @returns {number[]}
 */
function resolveExactCounts(sessionIds, rawCounts, totalCount) {
  const n = sessionIds.length;
  if (n === 0) return [];
  if (totalCount <= 0) return sessionIds.map(() => 0);
  if (n === 1) return [totalCount];

  let values = readRawValues(sessionIds, rawCounts).map((v) => Math.floor(v));
  const sum = values.reduce((a, b) => a + b, 0);

  if (sum <= 0) {
    return computeDistributionCounts(
      sessionIds.map(() => 1 / n),
      totalCount
    );
  }

  // Cantidades exactas: si suman el total, respetarlas al 100%.
  if (sum === totalCount) {
    return values;
  }

  // Compatibilidad / ajuste: repartir el total en proporción a los números dados.
  return computeDistributionCounts(
    values.map((v) => v / sum),
    totalCount
  );
}

/**
 * @param {string[]} sessionOrder
 * @param {Array} contacts
 * @param {number[]} counts - mensajes por sesión (deben sumar contacts.length)
 * @returns {Map<string, Array<{ contact: *, globalIndex: number }>>}
 */
function buildQueuesFromCounts(sessionOrder, contacts, counts) {
  const queues = new Map(sessionOrder.map((sId) => [sId, []]));
  if (sessionOrder.length === 0 || contacts.length === 0) return queues;

  let contactIdx = 0;
  for (let s = 0; s < sessionOrder.length; s++) {
    const sId = sessionOrder[s];
    const take = Math.max(0, counts[s] || 0);
    for (let c = 0; c < take && contactIdx < contacts.length; c++) {
      queues.get(sId).push({
        contact: contacts[contactIdx],
        globalIndex: contactIdx
      });
      contactIdx++;
    }
  }

  return queues;
}

/**
 * @param {string[]} sessionOrder
 * @param {Array} contacts
 * @param {number[]} proportions - normalizadas, suman 1
 * @returns {Map<string, Array<{ contact: *, globalIndex: number }>>}
 */
function buildWeightedQueues(sessionOrder, contacts, proportions) {
  const counts = computeDistributionCounts(proportions, contacts.length);
  return buildQueuesFromCounts(sessionOrder, contacts, counts);
}

/**
 * @param {string[]} sessionOrder
 * @param {Record<string, number|string>|null|undefined} rawWeights
 * @param {number} totalCount
 * @returns {{ proportions: number[], counts: number[] }}
 */
function previewDistribution(sessionOrder, rawWeights, totalCount) {
  const counts = resolveExactCounts(sessionOrder, rawWeights, totalCount);
  const sum = counts.reduce((a, b) => a + b, 0) || 1;
  const proportions = counts.map((c) => c / sum);
  return { proportions, counts };
}

module.exports = {
  parseSessionWeights,
  computeDistributionCounts,
  resolveExactCounts,
  buildQueuesFromCounts,
  buildWeightedQueues,
  previewDistribution
};
