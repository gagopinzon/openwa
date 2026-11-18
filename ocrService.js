/**
 * OCR para PDFs escaneados / exportados como imagen.
 * Renderiza páginas con pdf.js + canvas y reconoce texto con tesseract.js (WASM, sin binarios del sistema).
 *
 * Env:
 *   OCR_ENABLED=true          (false desactiva OCR por completo)
 *   OCR_LANG=spa              (idiomas tesseract, p. ej. "spa+eng")
 *   OCR_MAX_PAGES=3           (páginas máximas a reconocer por PDF)
 *   OCR_TARGET_WIDTH=2400     (ancho en px al renderizar cada página)
 *   OCR_CACHE_DIR=data/tessdata (cache del modelo de idioma; se descarga 1 vez)
 *   OCR_IDLE_MS=120000        (libera el worker tras este tiempo sin uso)
 */
const path = require('path');
const fs = require('fs');

const DEFAULT_TARGET_WIDTH = 2400;
// Nombres con letra gigante solo los detecta tesseract a baja resolución.
const HEADER_PASS_WIDTH = 700;
const HEADER_PASS_RATIO = 0.3;

let workerPromise = null;
let idleTimer = null;
let queue = Promise.resolve();

function isEnabled() {
  const raw = String(process.env.OCR_ENABLED || '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  try {
    require.resolve('canvas');
    require.resolve('tesseract.js');
    return true;
  } catch {
    return false;
  }
}

function getMaxPages() {
  const v = parseInt(process.env.OCR_MAX_PAGES || '3', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 10) : 3;
}

function getTargetWidth() {
  const v = parseInt(process.env.OCR_TARGET_WIDTH || String(DEFAULT_TARGET_WIDTH), 10);
  return Number.isFinite(v) && v >= 800 ? Math.min(v, 4000) : DEFAULT_TARGET_WIDTH;
}

function getCacheDir() {
  const dir = String(process.env.OCR_CACHE_DIR || '').trim() || path.join(__dirname, 'data', 'tessdata');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* tesseract usará su default si no se puede crear */
  }
  return dir;
}

function getIdleMs() {
  const v = parseInt(process.env.OCR_IDLE_MS || '120000', 10);
  return Number.isFinite(v) && v >= 5000 ? v : 120000;
}

async function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    const lang = String(process.env.OCR_LANG || 'spa').trim() || 'spa';
    workerPromise = createWorker(lang.split('+'), 1, {
      cachePath: getCacheDir(),
      errorHandler: (err) => console.warn('[ocr] worker error:', err && err.message ? err.message : err)
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function scheduleIdleTerminate() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    const pending = workerPromise;
    workerPromise = null;
    if (!pending) return;
    try {
      const w = await pending;
      await w.terminate();
    } catch {
      /* ignore */
    }
  }, getIdleMs());
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

/**
 * Serializa los trabajos de OCR (un worker = un trabajo a la vez) y mantiene vivo el worker.
 * @template T
 * @param {(worker: any) => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withWorker(fn) {
  const run = queue.then(async () => {
    if (idleTimer) clearTimeout(idleTimer);
    try {
      const worker = await getWorker();
      return await fn(worker);
    } finally {
      scheduleIdleTerminate();
    }
  });
  queue = run.catch(() => {});
  return run;
}

/**
 * @param {any} page - página pdf.js
 * @param {number} width - ancho deseado en px
 * @param {number} [heightRatio=1] - fracción superior de la página a renderizar
 * @returns {Promise<Buffer>} PNG
 */
async function renderPageToPng(page, width, heightRatio = 1) {
  const { createCanvas } = require('canvas');
  const base = page.getViewport({ scale: 1 });
  const scale = width / base.width;
  const viewport = page.getViewport({ scale });
  const w = Math.ceil(viewport.width);
  const h = Math.ceil(viewport.height * heightRatio);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer('image/png');
}

/**
 * Corrige errores típicos de OCR en correos: la "@" se lee como "(O", "©", "e", "Q", "G"...
 * @param {string} text
 */
const OCR_EMAIL_RE =
  /([A-Za-z0-9._%+-]{2,})(\(O|\(0|\(o|\(@|©|®|\s?@\s?)?(gmail|hotmail|outlook|yahoo|live|icloud|protonmail|msn|prodigy)\s?[.,]\s?(com\.mx|com|mx|es|net)\b/gi;

function fixOcrEmails(text) {
  return String(text || '').replace(OCR_EMAIL_RE, (match, user, sep, domain, tld) => {
    let local = user;
    if (!sep) {
      // tesseract suele SUSTITUIR la "@" por un carácter parecido (e, G, Q, O, 0)
      if (/[eGQOo0]$/.test(local) && local.length > 2) local = local.slice(0, -1);
    }
    return `${local}@${domain}.${tld}`.toLowerCase();
  });
}

function cleanOcrText(text) {
  return fixOcrEmails(
    String(text || '')
      // Íconos de contacto leídos como basura al inicio de línea: "[in) ", "[m=) ", "(Y ", "O) "
      .replace(/^[ \t]*(?:[\[(][^\s\])]{0,3}[\])]?|[A-Za-z0-9]?\))[ \t]+(?=\S)/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function wordsOf(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-zñ]{2,}/g) || [];
}

/**
 * Del paso a baja resolución solo conserva líneas cortas (nombre / título grande)
 * cuyas palabras el paso principal NO reconoció. Evita meter ruido de baja resolución.
 * @param {string} headerText
 * @param {string} mainText
 */
function pickHeaderOnlyLines(headerText, mainText) {
  const mainWords = new Set(wordsOf(mainText));
  return String(headerText || '')
    .split('\n')
    .map((l) => l.replace(/^[|\s]+|[|\s]+$/g, '').trim())
    .filter((line) => {
      const words = wordsOf(line).filter((w) => w.length >= 3);
      if (!words.length || words.length > 5) return false;
      const unseen = words.filter((w) => !mainWords.has(w));
      return unseen.length / words.length >= 0.5;
    })
    .join('\n');
}

/**
 * Reconoce el texto de una página pdf.js.
 * @param {any} page
 * @param {{ headerPass?: boolean }} [opts]
 * @returns {Promise<string>}
 */
async function ocrPdfPage(page, opts = {}) {
  const mainPng = await renderPageToPng(page, getTargetWidth());
  const headerPng = opts.headerPass
    ? await renderPageToPng(page, HEADER_PASS_WIDTH, HEADER_PASS_RATIO)
    : null;

  return withWorker(async (worker) => {
    const main = await worker.recognize(mainPng);
    let header = '';
    if (headerPng) {
      const h = await worker.recognize(headerPng);
      header = pickHeaderOnlyLines(h.data.text, main.data.text);
    }
    return cleanOcrText([header, main.data.text].filter(Boolean).join('\n'));
  });
}

module.exports = {
  isEnabled,
  getMaxPages,
  ocrPdfPage,
  renderPageToPng,
  fixOcrEmails,
  cleanOcrText,
  pickHeaderOnlyLines
};
