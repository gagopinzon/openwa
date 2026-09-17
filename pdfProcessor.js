const pdfParse = require('pdf-parse');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

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

async function extractWithPdfJs(bytes, maxPages) {
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    stopAtErrors: false,
    verbosity: 0
  });
  const doc = await loadingTask.promise;
  try {
    const n = maxPages > 0 ? Math.min(doc.numPages, maxPages) : doc.numPages;
    const parts = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
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
    const text = await extractTextFromPDF(buffer, { silent: true, maxPages: 1 });
    return Boolean(text);
  } catch {
    const bytes = toExactPdfBytes(buffer);
    return bytes.length >= 64 && Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
  }
}

/**
 * Extrae texto de un PDF desde un buffer
 * @param {Buffer|Uint8Array} buffer - Buffer del archivo PDF
 * @param {{ silent?: boolean, maxPages?: number }} [opts]
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
    const text = await extractWithPdfJs(bytes, maxPages);
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
    const text = data && data.text ? String(data.text).trim() : '';
    if (text) return text;
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
  if (raw) {
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
  const correo = header.correo || '';

  return {
    nombre,
    telefono,
    experiencia,
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

module.exports = {
  verifyPdfReadable,
  extractTextFromPDF,
  extractCVData
};
