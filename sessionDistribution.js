/**
 * Reparto de contactos entre sesiones según ponderaciones (porcentajes).
 */

/**
 * @param {string[]} sessionIds
 * @param {Record<string, number|string>|null|undefined} rawWeights
 * @returns {number[]} proporciones normalizadas (suman 1)
 */
function parseSessionWeights(sessionIds, rawWeights) {
  const n = sessionIds.length;
  if (n === 0) return [];
  if (n === 1) return [1];

  let values = sessionIds.map((id) => {
    const v = rawWeights && rawWeights[id] != null ? Number(rawWeights[id]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 0;
  });

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
 * @param {string[]} sessionOrder
 * @param {Array} contacts
 * @param {number[]} proportions - normalizadas, suman 1
 * @returns {Map<string, Array<{ contact: *, globalIndex: number }>>}
 */
function buildWeightedQueues(sessionOrder, contacts, proportions) {
  const queues = new Map(sessionOrder.map((sId) => [sId, []]));
  if (sessionOrder.length === 0 || contacts.length === 0) return queues;

  const counts = computeDistributionCounts(proportions, contacts.length);

  let contactIdx = 0;
  for (let s = 0; s < sessionOrder.length; s++) {
    const sId = sessionOrder[s];
    for (let c = 0; c < counts[s]; c++) {
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
 * @param {Record<string, number|string>|null|undefined} rawWeights
 * @param {number} totalCount
 * @returns {{ proportions: number[], counts: number[] }}
 */
function previewDistribution(sessionOrder, rawWeights, totalCount) {
  const proportions = parseSessionWeights(sessionOrder, rawWeights);
  const counts = computeDistributionCounts(proportions, totalCount);
  return { proportions, counts };
}

module.exports = {
  parseSessionWeights,
  computeDistributionCounts,
  buildWeightedQueues,
  previewDistribution
};
