/**
 * Cola global para llamadas a OpenWA: una a la vez, hueco mínimo
 * entre peticiones, y cooldown compartido cuando llega un 429.
 */

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createOpenWAThrottle(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepMs;
  const minGap =
    Number.isFinite(opts.minGapMs) && opts.minGapMs >= 0
      ? opts.minGapMs
      : 400;

  let lastEndedAt = null;
  let cooldownUntil = 0;
  let tail = Promise.resolve();
  const inflightGets = new Map();

  function minGapMs() {
    if (Number.isFinite(opts.minGapMs) && opts.minGapMs >= 0) return minGap;
    const env = parseInt(process.env.OPENWA_MIN_GAP_MS, 10);
    return Number.isFinite(env) && env >= 0 ? env : 400;
  }

  function noteRateLimited({ retryAfterMs, retryAfterHeader } = {}) {
    let ms = Number(retryAfterMs);
    if (!Number.isFinite(ms) || ms <= 0) {
      const sec = parseInt(retryAfterHeader, 10);
      ms = Number.isFinite(sec) ? sec * 1000 : 8000;
    }
    ms = Math.min(Math.max(ms, 3000), 30000);
    const jitter = Math.round(ms * 0.15 * Math.random());
    const until = now() + ms + jitter;
    if (until > cooldownUntil) cooldownUntil = until;
  }

  async function waitForSlot() {
    for (;;) {
      const gapWait =
        lastEndedAt == null ? 0 : Math.max(0, lastEndedAt + minGapMs() - now());
      const wait = Math.max(0, cooldownUntil - now(), gapWait);
      if (wait <= 0) return;
      await sleep(wait);
    }
  }

  function enqueue(fn) {
    const run = tail.then(async () => {
      await waitForSlot();
      try {
        return await fn();
      } finally {
        lastEndedAt = now();
      }
    });
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * GET idénticos en vuelo comparten la misma promesa.
   * @param {string} key
   * @param {() => Promise<any>} fn
   */
  function coalesceGet(key, fn) {
    const existing = inflightGets.get(key);
    if (existing) return existing;
    const p = enqueue(fn);
    inflightGets.set(key, p);
    const clear = () => {
      if (inflightGets.get(key) === p) inflightGets.delete(key);
    };
    p.then(clear, clear);
    return p;
  }

  return {
    enqueue,
    coalesceGet,
    noteRateLimited,
    waitForSlot
  };
}

const defaultThrottle = createOpenWAThrottle();

module.exports = {
  createOpenWAThrottle,
  defaultThrottle
};
