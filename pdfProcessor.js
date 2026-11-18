const pdfParse = require('pdf-parse');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const ocrService = require('./ocrService');

pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve(
  'pdfjs-dist/legacy/build/pdf.worker.js'
);

/**
 * Copia exacta de los bytes del PDF. pdf.js 1.10 (pdf-parse) lee
 * `buffer.buffer` y si el Buffer de Node está pooled (byteOffset !== 0)
 * interpreta basura → "bad XRef entry".
 * @param {Buffer|Uint8Array} input
 * @returns {Uint8Array}
 */
function toExactPdfBytes(input) {
  if (!input || input.length < 5) {
    return new Uint8Array(0);
  }
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const start = buf.indexOf(Buffer.from('%PDF-', 'ascii'));
  if (start < 0) return new Uint8Array(0);
  const sliced = start > 0 ? buf.subarray(start) : buf;
  const bytes = new Uint8Array(sliced.length);
  bytes.set(sliced);
  return bytes;
}

/**
 * Último recurso: literales (...) de streams sin comprimir.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function extractRawPdfStrings(bytes) {
  const raw = Buffer.from(bytes).toString('latin1');
  const chunks = [];
  const re = /\((?:\\.|[^\\)]){2,}\)/g;
  let match;
  while ((match = re.exec(raw))) {
    let s = match[0].slice(1, -1);
    s = s
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '')
      .replace(/\\t/g, '\t')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
    if (/[A-Za-zÁÉÍÓÚáéíóúñÑ]/.test(s)) chunks.push(s);
  }
  return chunks.join(' ').replace(/[ \t]+/g, ' ').trim();
}

const LETTER_RE = /[A-Za-zÁÉÍÓÚÜáéíóúüÑñ]/g;
// Controles, carácter de reemplazo y símbolos latin-1 raros que salen de streams binarios.
const GARBAGE_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f�¢-©«-®±-¶¸-»¾Ð×Þð÷þ]/g;
const PDF_SYNTAX_RE = /\b(endstream|endobj|xref|startxref)\b|\/(Type|MediaBox|Resources|Contents|FontFile\d?)\b|\\\d{3}|\(cid:\d+\)/g;
const MIN_PAGE_LETTERS = 40;

/**
 * Evalúa si un texto extraído es legible o basura (PDF escaneado, fuentes sin mapa, streams binarios).
 * @param {string} text
 * @returns {{ letters: number, garbageRatio: number, syntaxHits: number, ok: boolean }}
 */
function assessTextQuality(text) {
  const s = String(text || '');
  const nonSpace = s.replace(/\s+/g, '').length || 1;
  const letters = (s.match(LETTER_RE) || []).length;
  const garbage = (s.match(GARBAGE_CHAR_RE) || []).length;
  const syntaxHits = (s.match(PDF_SYNTAX_RE) || []).length;
  const garbageRatio = garbage / nonSpace;
  const letterRatio = letters / nonSpace;
  const ok = garbageRatio < 0.03 && syntaxHits < 3 && (letters < 20 || letterRatio > 0.45);
  return { letters, garbageRatio, syntaxHits, ok };
}

/**
 * Une palabras con letras separadas por espacios ("E X P E R I E N C I A" → "EXPERIENCIA").
 * @param {string} text
 */
function collapseLetterSpacing(text) {
  return String(text || '').replace(
    /(?:^|(?<=\s))((?:[A-Za-zÁÉÍÓÚÜáéíóúüÑñ] ){3,}[A-Za-zÁÉÍÓÚÜáéíóúüÑñ])(?=\s|$|[.,:;|/])/gm,
    (run) => run.replace(/ /g, '')
  );
}

/**
 * Página con poco texto extraíble pero que sí pinta contenido: imagen escaneada,
 * o texto con fuentes sin mapa Unicode (pdf.js dibuja glifos pero extrae vacío).
 */
async function pageLooksScannedOrUnmapped(page) {
  try {
    const ops = await page.getOperatorList();
    const { OPS } = pdfjsLib;
    const imageOps = new Set(
      [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintJpegXObject, OPS.paintImageMaskXObject]
        .filter((v) => v != null)
    );
    const textOps = new Set(
      [OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]
        .filter((v) => v != null)
    );
    let textOpCount = 0;
    for (const fn of ops.fnArray) {
      if (imageOps.has(fn)) return true;
      if (textOps.has(fn)) textOpCount += 1;
    }
    return textOpCount >= 10;
  } catch {
    return false;
  }
}

function pageTextFromContent(content) {
  let lastY;
  let text = '';
  for (const item of content.items) {
    if (!item || typeof item.str !== 'string') continue;
    if (lastY != null && item.transform && lastY !== item.transform[5]) {
      text += '\n';
    }
    text += item.str;
    if (item.transform) lastY = item.transform[5];
  }
  return text;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} maxPages
 * @param {{ ocr?: boolean, silent?: boolean, stats?: object }} [opts]
 */
async function extractWithPdfJs(bytes, maxPages, opts = {}) {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    stopAtErrors: false,
    verbosity: 0
  });
  const doc = await loadingTask.promise;
  const ocrAllowed = opts.ocr !== false && ocrService.isEnabled();
  const ocrBudget = ocrAllowed ? ocrService.getMaxPages() : 0;
  let ocrPages = 0;
  try {
    const n = maxPages > 0 ? Math.min(doc.numPages, maxPages) : doc.numPages;
    const parts = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = collapseLetterSpacing(pageTextFromContent(content));

      const quality = assessTextQuality(text);
      const needsOcr =
        ocrPages < ocrBudget &&
        (!quality.ok || (quality.letters < MIN_PAGE_LETTERS && (await pageLooksScannedOrUnmapped(page))));

      if (needsOcr) {
        try {
          const started = Date.now();
          const ocrText = await ocrService.ocrPdfPage(page, { headerPass: i === 1 });
          ocrPages += 1;
          const ocrQuality = assessTextQuality(ocrText);
          if (ocrQuality.letters > quality.letters || !quality.ok) {
            text = ocrText;
            if (opts.stats) opts.stats.ocrPages = (opts.stats.ocrPages || 0) + 1;
          }
          if (!opts.silent) {
            console.log(
              `[ocr] página ${i}/${n}: ${ocrQuality.letters} letras en ${Date.now() - started} ms (texto original: ${quality.letters} letras${quality.ok ? '' : ', ilegible'})`
            );
          }
        } catch (error) {
          console.warn(`[ocr] falló en página ${i}:`, errorMessage(error));
          if (!quality.ok) text = '';
        }
      } else if (!quality.ok) {
        text = '';
      }
      parts.push(text);
    }
    return parts.join('\n').trim();
  } finally {
    if (typeof doc.destroy === 'function') {
      await doc.destroy();
    }
  }
}

function errorMessage(error) {
  return error && error.message ? String(error.message) : String(error || 'Error desconocido');
}

/**
 * Comprueba que el buffer sea un PDF del que se pueda extraer texto.
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<boolean>}
 */
async function verifyPdfReadable(buffer) {
  if (!buffer || buffer.length < 64) return false;
  try {
    const text = await extractTextFromPDF(buffer, { silent: true, maxPages: 1, ocr: false });
    return Boolean(text);
  } catch {
    const bytes = toExactPdfBytes(buffer);
    return bytes.length >= 64 && Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
  }
}

/**
 * Extrae texto de un PDF desde un buffer
 * @param {Buffer|Uint8Array} buffer - Buffer del archivo PDF
 * @param {{ silent?: boolean, maxPages?: number, ocr?: boolean, stats?: object }} [opts]
 *   ocr=false desactiva el OCR de páginas escaneadas; stats.ocrPages reporta cuántas se reconocieron.
 * @returns {Promise<string>} - Texto extraído del PDF
 */
async function extractTextFromPDF(buffer, opts = {}) {
  const silent = Boolean(opts.silent);
  const maxPages = Number(opts.maxPages) > 0 ? Number(opts.maxPages) : 0;
  const bytes = toExactPdfBytes(buffer);
  if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') {
    throw new Error('Error procesando PDF: no es un PDF válido');
  }

  let lastError = null;
  try {
    const text = await extractWithPdfJs(bytes, maxPages, opts);
    if (text) return text;
  } catch (error) {
    lastError = error;
    if (!silent) {
      console.error('Error extrayendo texto del PDF (pdfjs):', {
        message: errorMessage(error),
        details: error && error.details,
        bytes: bytes.length
      });
    }
  }

  try {
    const parseOpts = maxPages > 0 ? { max: maxPages } : undefined;
    const data = await pdfParse(bytes, parseOpts);
    const text = data && data.text ? collapseLetterSpacing(String(data.text)).trim() : '';
    if (text && assessTextQuality(text).ok) return text;
  } catch (error) {
    lastError = lastError || error;
    if (!silent) {
      console.error('Error extrayendo texto del PDF (pdf-parse):', {
        message: errorMessage(error),
        details: error && error.details,
        bytes: bytes.length
      });
    }
  }

  const raw = extractRawPdfStrings(bytes);
  if (raw && assessTextQuality(raw).ok) {
    if (!silent) {
      console.warn(
        `PDF con tabla XRef dañada o no soportada; texto recuperado en fallback (${raw.length} chars)`
      );
    }
    return raw;
  }

  const reason = lastError ? errorMessage(lastError) : 'sin texto extraíble';
  throw new Error(`Error procesando PDF: ${reason}`);
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+52\s?)?\(?\d{2,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}/;
const MEXICO_STATE_RE =
  /^(estado de|ciudad de m[eé]xico|cdmx|jalisco|nuevo le[oó]n|m[eé]xico|puebla|quer[eé]taro|guanajuato|veracruz|yucat[aá]n|sonora|chihuahua|coahuila|tamaulipas|baja california|quintana roo|morelos|hidalgo|tlaxcala|tabasco|chiapas|oaxaca|guerrero|michoac[aá]n|nayarit|colima|aguascalientes|zacatecas|durango|sinaloa|campeche|baja california sur|san luis potos[ií])\b/i;

function isHeaderNoise(line) {
  return /occ\.com\.mx|^\|?\s*www\./i.test(String(line || ''));
}

function isEmailLine(line) {
  return EMAIL_RE.test(String(line || ''));
}

function isPhoneLine(line) {
  const digits = String(line || '').replace(/\D/g, '');
  if (digits.length >= 10 && digits.length <= 13) return true;
  return PHONE_RE.test(String(line || ''));
}

function isExperienceHeader(line) {
  return /experiencia\s+profesional/i.test(String(line || ''));
}

function looksLikeLocation(line) {
  const s = String(line || '').trim();
  if (!s || isEmailLine(s) || isPhoneLine(s) || isExperienceHeader(s) || isHeaderNoise(s)) {
    return false;
  }
  if (s.includes(',')) return true;
  return MEXICO_STATE_RE.test(s);
}

function parseLocalidad(line) {
  const raw = String(line || '').trim();
  if (!raw) return { ciudad: '', estado: '' };
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return { ciudad: parts[0], estado: parts.slice(1).join(', ') };
  }
  if (MEXICO_STATE_RE.test(raw)) {
    return { ciudad: '', estado: raw };
  }
  return { ciudad: raw, estado: '' };
}

function extractOccHeader(lines) {
  let i = 0;
  if (lines[0] && isHeaderNoise(lines[0])) i += 1;

  const nombre =
    lines[i] && !isExperienceHeader(lines[i]) && !isEmailLine(lines[i]) && !isPhoneLine(lines[i])
      ? lines[i]
      : 'No encontrado';
  i += 1;

  let ciudad = '';
  let estado = '';
  if (lines[i] && looksLikeLocation(lines[i])) {
    const loc = parseLocalidad(lines[i]);
    ciudad = loc.ciudad;
    estado = loc.estado;
  }

  const headerBlob = lines.slice(0, 10).join('\n');
  const emailMatch = headerBlob.match(EMAIL_RE);
  const correo = emailMatch ? emailMatch[0] : '';

  return { nombre, ciudad, estado, correo };
}

/**
 * Extrae datos estructurados de un CV desde el texto
 * @param {string} text - Texto del CV
 * @returns {Object} - Objeto con nombre, teléfono, ciudad y experiencia
 */
function extractCVData(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const header = extractOccHeader(lines);
  const nombre = header.nombre || 'No encontrado';

  const phoneMatch = String(text || '').match(PHONE_RE);
  let telefono = phoneMatch ? phoneMatch[0] : 'No encontrado';

  if (telefono !== 'No encontrado') {
    telefono = telefono.replace(/[\s().-]/g, '');
    if (!telefono.startsWith('+52') && !telefono.startsWith('52')) {
      telefono = '52' + telefono;
    }
    if (!telefono.startsWith('+')) {
      telefono = '+' + telefono;
    }
  }

  const experiencia = extractExperienciaProfesional(text);
  const ultimoTrabajo = extractUltimoTrabajo(text);
  const correo = header.correo || '';

  return {
    nombre,
    telefono,
    experiencia,
    ultimoTrabajo,
    textoCompleto: text,
    ciudad: header.ciudad || '',
    estado: header.estado || '',
    leadCiudad: header.ciudad || '',
    leadEstado: header.estado || '',
    correo,
    email: correo,
    leadCorreo: correo
  };
}

/**
 * Extrae la sección de experiencia profesional del texto
 * @param {string} text - Texto completo del CV
 * @returns {string} - Experiencia profesional extraída
 */
function extractExperienciaProfesional(text) {
  // Buscar sección de experiencia profesional
  const experienciaRegex = /experiencia\s+profesional[\s\S]*?(?=objetivo\s+profesional|educaci[oó]n|idiomas|liga\s+de\s+curr[ií]culo|$)/i;
  const match = text.match(experienciaRegex);

  if (match) {
    let experiencia = match[0];
    // Limpiar el texto extraído
    experiencia = experiencia
      .replace(/experiencia\s+profesional[\s-]*/i, '')
      .trim();

    // Limitar a un máximo de 1000 caracteres para evitar mensajes muy largos
    if (experiencia.length > 1000) {
      experiencia = experiencia.substring(0, 1000) + '...';
    }

    return experiencia;
  }

  // Si no encuentra la sección específica, buscar patrones de trabajo
  const trabajoRegex = /([a-zA-ZñÑáéíóúÁÉÍÓÚ\s]+)\s+en\s+([a-zA-ZñÑáéíóúÁÉÍÓÚ\s]+)\s*([a-z]+ \d{4}\s*-\s*[a-z]+ \d{4}|[a-z]+ \d{4}\s*-\s*(actual|presente))/gi;
  const trabajos = [];
  let matchTrabajo;

  while ((matchTrabajo = trabajoRegex.exec(text)) !== null) {
    trabajos.push(matchTrabajo[0]);
  }

  if (trabajos.length > 0) {
    return trabajos.join(' ');
  }

  return 'Experiencia no encontrada';
}

const EXPERIENCE_HEADER_RE = /experiencia\s+profesional[\s\S]*?(?=objetivo\s+profesional|educaci[oó]n|idiomas|liga\s+de\s+curr[ií]culo|cursos|certificaci|habilidades|referencias|$)/i;
const MONTH_NAMES =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';
const DATE_RANGE_RE = new RegExp(
  `\\b(?:${MONTH_NAMES})\\s+\\d{4}\\s*[-—]\\s*(?:${MONTH_NAMES}|actual|presente|actualidad)\\b`,
  'i'
);
const STANDALONE_YEAR_RE = /\b(19|20)\d{2}\b/;

function looksLikeJobTitle(line) {
  const s = String(line || '').trim();
  if (!s || s.length < 3) return false;
  if (/^experiencia\s+profesional/i.test(s)) return false;
  if (/^objetivo\s+profesional/i.test(s)) return false;
  if (/^educaci[oó]n/i.test(s)) return false;
  if (/^idiomas/i.test(s)) return false;
  if (/^habilidades/i.test(s)) return false;
  if (/^cursos|certificaci/i.test(s)) return false;
  if (/^referencias/i.test(s)) return false;
  if (/^liga\s+de\s+curr[ií]culo/i.test(s)) return false;
  if (/^\d{10,}$/.test(s.replace(/\D/g, ''))) return false;
  if (EMAIL_RE.test(s)) return false;
  if (/https?:|www\.|\.(com|mx|net|org|io)\b|linkedin/i.test(s)) return false;
  if (isPhoneLine(s)) return false;
  if (looksLikeLocation(s)) return false;
  if (DATE_RANGE_RE.test(s) && s.split(/\s+/).length <= 4) return false;
  return /[a-zA-ZÁÉÍÓÚáéíóúÑñ]/.test(s);
}

function normalizeJobTitle(line) {
  let s = String(line || '').trim();
  // Quitar viñetas y numeración inicial
  s = s.replace(/^[\-•·\*\d]+\s*[.)-]?\s*/, '');
  // Quitar ubicaciones al final entre paréntesis o después de |
  s = s.replace(/\s*[|\\/].*/, '');
  s = s.replace(/\s*\([^)]*\)\s*$/, '');
  // Si tiene " en Empresa", quedarse solo con el puesto
  const enIdx = s.toLowerCase().indexOf(' en ');
  if (enIdx > 0) {
    s = s.slice(0, enIdx).trim();
  }
  // Quitar fechas sueltas
  s = s.replace(DATE_RANGE_RE, '').trim();
  s = s.replace(STANDALONE_YEAR_RE, '').trim();
  // Limpiar caracteres raros
  s = s.replace(/\s+/g, ' ').trim();
  // Capitalizar
  return s
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toLocaleUpperCase('es') + w.slice(1).toLocaleLowerCase('es') : ''))
    .join(' ');
}

/**
 * Extrae el título del último trabajo/puesto del CV.
 * @param {string} text - Texto completo del CV
 * @returns {string} - Último puesto extraído o cadena vacía
 */
function extractUltimoTrabajo(text) {
  const raw = String(text || '');
  const sectionMatch = raw.match(EXPERIENCE_HEADER_RE);

  if (sectionMatch) {
    const lines = sectionMatch[0]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (!looksLikeJobTitle(line)) continue;
      const title = normalizeJobTitle(line);
      if (title.length >= 3 && title.length <= 80) return title;
    }
  }

  // Fallback: buscar patrón explícito "Cargo en Empresa" en todo el texto
  const fallbackRe = /([a-zA-ZÁÉÍÓÚáéíóúÑñ\s]+)\s+en\s+[a-zA-ZÁÉÍÓÚáéíóúÑñ\s&]+/i;
  const fallbackMatch = raw.match(fallbackRe);
  if (fallbackMatch) {
    const title = normalizeJobTitle(fallbackMatch[1]);
    if (title.length >= 3 && title.length <= 80) return title;
  }

  return '';
}

module.exports = {
  verifyPdfReadable,
  extractTextFromPDF,
  extractCVData,
  extractUltimoTrabajo,
  assessTextQuality,
  collapseLetterSpacing
};
