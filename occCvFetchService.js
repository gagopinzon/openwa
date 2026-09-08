const fs = require('fs');
const path = require('path');

const OCC_SESSION_DIR = path.join(__dirname, 'data', 'occ-session');
const STORAGE_STATE_PATH = path.join(OCC_SESSION_DIR, 'storageState.json');
const OCC_EMPRESAS_URL = 'https://www.occ.com.mx/empresas/';
const MAX_RETRIES = 2;
const NAV_TIMEOUT_MS = 60000;
const DOWNLOAD_TIMEOUT_MS = 90000;

const OCC_CV_URL_RE =
  /https?:\/\/(?:www\.)?occ\.com\.mx\/[^\s"'<>]*?\/cv\/\d+[^\s"'<>]*/i;

let chain = Promise.resolve();
let browserPromise = null;

/**
 * Extrae la primera URL de CV de OCC del texto (p. ej. pie del PDF).
 * @param {string} text
 * @returns {string|null}
 */
function extractOccCvUrl(text) {
  const raw = String(text || '');
  const match = raw.match(OCC_CV_URL_RE);
  if (!match) return null;
  return match[0].replace(/[),.;]+$/, '').trim() || null;
}

function credentialsConfigured() {
  const user = String(process.env.OCC_USER || '').trim();
  const pass = String(process.env.OCC_PASSWORD || '').trim();
  return Boolean(user && pass);
}

function getCredentials() {
  return {
    user: String(process.env.OCC_USER || '').trim(),
    password: String(process.env.OCC_PASSWORD || '').trim()
  };
}

function ensureSessionDir() {
  if (!fs.existsSync(OCC_SESSION_DIR)) {
    fs.mkdirSync(OCC_SESSION_DIR, { recursive: true });
  }
}

function hasStoredSession() {
  try {
    return fs.existsSync(STORAGE_STATE_PATH) && fs.statSync(STORAGE_STATE_PATH).size > 20;
  } catch {
    return false;
  }
}

function isPdfBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 5) return false;
  return buf.subarray(0, 5).toString('ascii') === '%PDF-';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serializa operaciones OCC (un context a la vez).
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withOccLock(fn) {
  const run = chain.then(() => fn());
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function getBrowser() {
  if (!browserPromise) {
    const { chromium } = require('playwright');
    browserPromise = chromium
      .launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
      })
      .catch((err) => {
        browserPromise = null;
        const msg = err && err.message ? String(err.message) : String(err);
        if (/libnspr4|shared libraries|cannot open shared object/i.test(msg)) {
          console.error(
            '[occ-cv] Chromium no puede arrancar: faltan dependencias del sistema. ' +
              'En el servidor ejecuta (con sudo): npx playwright install-deps chromium'
          );
        }
        throw err;
      });
  }
  return browserPromise;
}

/**
 * @param {import('playwright').Browser} browser
 * @param {{ storageState?: string }} [opts]
 */
async function newContext(browser, opts = {}) {
  const contextOpts = {
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    locale: 'es-MX',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  if (opts.storageState && fs.existsSync(opts.storageState)) {
    contextOpts.storageState = opts.storageState;
  }
  return browser.newContext(contextOpts);
}

async function persistStorageState(context) {
  ensureSessionDir();
  await context.storageState({ path: STORAGE_STATE_PATH });
}

/**
 * @param {import('playwright').Page} page
 */
async function looksLikeLoginPage(page) {
  const url = page.url();
  if (/login|iniciar|signin|auth/i.test(url)) return true;
  const password = page.locator('input[type="password"]');
  try {
    return await password.first().isVisible({ timeout: 1500 });
  } catch {
    return false;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {{ user: string, password: string }} creds
 */
async function performLogin(page, creds) {
  await page.goto(OCC_EMPRESAS_URL, {
    waitUntil: 'domcontentloaded',
    timeout: NAV_TIMEOUT_MS
  });

  const loginTriggers = [
    page.getByRole('link', { name: /inicia\s*sesi[oó]n/i }),
    page.getByRole('button', { name: /inicia\s*sesi[oó]n/i }),
    page.locator('a, button').filter({ hasText: /inicia\s*sesi[oó]n/i })
  ];
  for (const trigger of loginTriggers) {
    try {
      if (await trigger.first().isVisible({ timeout: 2000 })) {
        await Promise.all([
          page
            .waitForURL(/secure\.occ\.com\.mx|Account\/Login|empresa\.occ/i, {
              timeout: NAV_TIMEOUT_MS
            })
            .catch(() => undefined),
          trigger.first().click({ timeout: 5000 })
        ]);
        break;
      }
    } catch {
      /* try next */
    }
  }

  // Login reclutador: secure.occ.com.mx → #Email / #Password / #submitBtn
  // (evitar selectores amplios: existen inputs hidden tipo NoValidateEmail)
  const userInput = page.locator('#Email:visible, input#Email[type="email"]').first();
  const passInput = page.locator('#Password:visible, input#Password[type="password"]').first();

  await userInput.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
  await passInput.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
  await userInput.fill(creds.user);
  await passInput.fill(creds.password);

  const submit = page
    .locator('#submitBtn, #btnSubmitPass, button:has-text("Iniciar sesión")')
    .filter({ hasNot: page.locator('[hidden], [aria-hidden="true"]') })
    .first();
  await Promise.all([
    page
      .waitForURL(/empresa\.occ\.com\.mx|occ\.com\.mx\/empresas/i, {
        timeout: NAV_TIMEOUT_MS
      })
      .catch(() => undefined),
    submit.click({ timeout: 10000 })
  ]);

  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS });
  await sleep(1500);

  if (await looksLikeLoginPage(page)) {
    const err = new Error('Login OCC falló (sigue en pantalla de credenciales)');
    err.code = 'occ_login_failed';
    throw err;
  }
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {string} cvUrl
 * @returns {Promise<Buffer>}
 */
async function downloadFromCvPage(context, cvUrl) {
  const page = await context.newPage();
  try {
    await page.goto(cvUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await sleep(800);

    if (await looksLikeLoginPage(page)) {
      const err = new Error('Sesión OCC inválida o expirada');
      err.code = 'occ_session_expired';
      throw err;
    }

    const downloadBtn = page.locator('#download-cv');
    await downloadBtn.waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS }),
      downloadBtn.click({ timeout: 10000 })
    ]);

    const tmpPath = await download.path();
    let buffer;
    if (tmpPath) {
      buffer = fs.readFileSync(tmpPath);
    } else {
      const stream = download.createReadStream();
      buffer = await new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    }

    if (!isPdfBuffer(buffer)) {
      const err = new Error('La descarga de OCC no es un PDF válido');
      err.code = 'occ_not_pdf';
      throw err;
    }
    return buffer;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Descarga el PDF del CV desde OCC (login + #download-cv).
 * @param {string} cvUrl
 * @returns {Promise<Buffer>}
 */
async function downloadCvPdf(cvUrl) {
  const url = String(cvUrl || '').trim();
  if (!url || !/occ\.com\.mx/i.test(url)) {
    const err = new Error('URL OCC inválida');
    err.code = 'occ_bad_url';
    throw err;
  }
  if (!credentialsConfigured()) {
    const err = new Error('OCC_USER / OCC_PASSWORD no configurados');
    err.code = 'occ_no_credentials';
    throw err;
  }

  return withOccLock(async () => {
    const creds = getCredentials();
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(800 * attempt);
        console.warn(`[occ-cv] reintento ${attempt}/${MAX_RETRIES} url=${url}`);
      }

      let context = null;
      try {
        const browser = await getBrowser();
        const useStored = hasStoredSession() && attempt === 0;
        context = await newContext(browser, {
          storageState: useStored ? STORAGE_STATE_PATH : undefined
        });

        if (!useStored) {
          const loginPage = await context.newPage();
          try {
            await performLogin(loginPage, creds);
            await persistStorageState(context);
            console.log('[occ-cv] sesión OCC guardada en data/occ-session/');
          } finally {
            await loginPage.close().catch(() => {});
          }
        }

        try {
          const pdf = await downloadFromCvPage(context, url);
          await persistStorageState(context);
          return pdf;
        } catch (dlErr) {
          if (dlErr && dlErr.code === 'occ_session_expired' && useStored) {
            await context.close().catch(() => {});
            context = null;
            try {
              fs.unlinkSync(STORAGE_STATE_PATH);
            } catch {
              /* ignore */
            }
            context = await newContext(browser);
            const loginPage = await context.newPage();
            try {
              await performLogin(loginPage, creds);
              await persistStorageState(context);
            } finally {
              await loginPage.close().catch(() => {});
            }
            const pdf = await downloadFromCvPage(context, url);
            await persistStorageState(context);
            return pdf;
          }
          throw dlErr;
        }
      } catch (err) {
        lastError = err;
        console.warn(
          `[occ-cv] intento ${attempt} falló:`,
          err && err.message ? err.message : err
        );
      } finally {
        if (context) await context.close().catch(() => {});
      }
    }

    const err = lastError || new Error('No se pudo descargar CV de OCC');
    err.code = err.code || 'occ_download_failed';
    throw err;
  });
}

/**
 * Si el texto trae liga OCC, descarga el PDF real (inyectable para tests).
 * @param {Buffer} originalBuffer
 * @param {string} text
 * @param {{
 *   downloadFn?: (url: string) => Promise<Buffer>,
 *   credentialsOk?: boolean
 * }} [opts]
 * @returns {Promise<{
 *   buffer: Buffer,
 *   text: string|null,
 *   occUrl: string|null,
 *   occFetched: boolean,
 *   occFetchFailed?: boolean,
 *   occFetchError?: string,
 *   skipped?: boolean
 * }>}
 */
async function enrichBufferFromOccIfNeeded(originalBuffer, text, opts = {}) {
  const occUrl = extractOccCvUrl(text);
  if (!occUrl) {
    return {
      buffer: originalBuffer,
      text: null,
      occUrl: null,
      occFetched: false,
      skipped: true
    };
  }

  const credsOk =
    typeof opts.credentialsOk === 'boolean'
      ? opts.credentialsOk
      : credentialsConfigured();
  if (!credsOk) {
    console.warn(
      `[occ-cv] liga detectada pero OCC_USER/OCC_PASSWORD ausentes; se usa PDF original url=${occUrl}`
    );
    return {
      buffer: originalBuffer,
      text: null,
      occUrl,
      occFetched: false,
      occFetchFailed: true,
      occFetchError: 'occ_no_credentials'
    };
  }

  const downloadFn =
    typeof opts.downloadFn === 'function' ? opts.downloadFn : downloadCvPdf;

  try {
    const buffer = await downloadFn(occUrl);
    if (!isPdfBuffer(buffer)) {
      throw Object.assign(new Error('PDF OCC inválido'), { code: 'occ_not_pdf' });
    }
    console.log(`[occ-cv] CV descargado ok bytes=${buffer.length} url=${occUrl}`);
    return {
      buffer,
      text: null,
      occUrl,
      occFetched: true
    };
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    const code = err && err.code ? String(err.code) : 'occ_download_failed';
    console.warn(`[occ-cv] fallback al PDF original: ${code} ${message}`);
    return {
      buffer: originalBuffer,
      text: null,
      occUrl,
      occFetched: false,
      occFetchFailed: true,
      occFetchError: `${code}: ${message}`
    };
  }
}

/**
 * Antes de agendar/enviar a Panel: si el PDF tiene liga OCC, descarga el CV real
 * y reemplaza el archivo en disco (mismo cvId). Idempotente si ya se descargó.
 *
 * @param {string} cvId
 * @param {{
 *   downloadFn?: (url: string) => Promise<Buffer>,
 *   credentialsOk?: boolean,
 *   extractTextFn?: (buf: Buffer) => Promise<string>,
 *   force?: boolean
 * }} [opts]
 */
async function ensureOccCvFetched(cvId, opts = {}) {
  const id = String(cvId || '').trim();
  if (!id) {
    return { skipped: true, reason: 'no_cv_id' };
  }

  const cvFileStore = require('./cvFileStore');
  const entry =
    (cvFileStore.loadCvsManifest() || []).find((c) => c && c.cvId === id) || null;

  if (entry?.occFetched && !opts.force) {
    return {
      skipped: true,
      reason: 'already_fetched',
      occFetched: true,
      occUrl: entry.occUrl || null
    };
  }
  if (entry?.occChecked && !entry?.occUrl && !opts.force) {
    return { skipped: true, reason: 'no_occ_link', occFetched: false };
  }

  const buffer = cvFileStore.readCvFileBuffer(id);
  if (!buffer) {
    return { skipped: true, reason: 'no_file' };
  }

  const extractTextFn =
    typeof opts.extractTextFn === 'function'
      ? opts.extractTextFn
      : async (buf) => {
          const { extractTextFromPDF } = require('./pdfProcessor');
          return extractTextFromPDF(buf);
        };

  let text = '';
  try {
    text = await extractTextFn(buffer);
  } catch (err) {
    console.warn(
      `[occ-cv] no se pudo leer texto del PDF cvId=${id}:`,
      err && err.message ? err.message : err
    );
    return {
      skipped: true,
      reason: 'text_extract_failed',
      occFetchFailed: true,
      occFetchError: 'occ_text_extract_failed'
    };
  }

  const enrich = await enrichBufferFromOccIfNeeded(buffer, text, opts);

  if (!enrich.occUrl) {
    cvFileStore.updateCvEntry(id, {
      occChecked: true,
      occFetched: false,
      occUrl: null,
      occFetchFailed: false,
      occFetchError: undefined
    });
    return { ...enrich, skipped: true, reason: 'no_occ_link' };
  }

  if (enrich.occFetched && enrich.buffer && enrich.buffer !== buffer) {
    const replaced = cvFileStore.replaceCvFileBuffer(id, enrich.buffer);
    if (!replaced) {
      console.warn(`[occ-cv] no se pudo reemplazar PDF en disco cvId=${id}`);
      cvFileStore.updateCvEntry(id, {
        occUrl: enrich.occUrl,
        occFetched: false,
        occFetchFailed: true,
        occFetchError: 'occ_replace_failed',
        occChecked: true
      });
      return {
        ...enrich,
        occFetched: false,
        occFetchFailed: true,
        occFetchError: 'occ_replace_failed'
      };
    }
    cvFileStore.updateCvEntry(id, {
      occUrl: enrich.occUrl,
      occFetched: true,
      occFetchFailed: false,
      occFetchError: undefined,
      occChecked: true
    });
    console.log(`[occ-cv] PDF reemplazado para agenda cvId=${id} url=${enrich.occUrl}`);
    return { ...enrich, replaced: true };
  }

  if (enrich.occFetchFailed) {
    cvFileStore.updateCvEntry(id, {
      occUrl: enrich.occUrl,
      occFetched: false,
      occFetchFailed: true,
      occFetchError: enrich.occFetchError,
      occChecked: true
    });
  }

  return enrich;
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    /* ignore */
  }
  browserPromise = null;
}

module.exports = {
  extractOccCvUrl,
  credentialsConfigured,
  downloadCvPdf,
  enrichBufferFromOccIfNeeded,
  ensureOccCvFetched,
  closeBrowser,
  OCC_SESSION_DIR,
  STORAGE_STATE_PATH
};
