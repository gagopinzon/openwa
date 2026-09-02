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

/**
 * Extrae datos estructurados de un CV desde el texto
 * @param {string} text - Texto del CV
 * @returns {Object} - Objeto con nombre, teléfono y experiencia
 */
function extractCVData(text) {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // Extraer nombre (generalmente la segunda línea)
  const nombre = lines.length > 1 ? lines[1] : 'No encontrado';

  // Extraer teléfono con múltiples patrones
  const phoneRegex = /(?:\+52\s?)?\(?\d{2,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}/;
  const phoneMatch = text.match(phoneRegex);
  let telefono = phoneMatch ? phoneMatch[0] : 'No encontrado';
  
  // Limpiar y formatear teléfono
  if (telefono !== 'No encontrado') {
    // Remover espacios y caracteres especiales
    telefono = telefono.replace(/[\s().-]/g, '');
    // Agregar +52 si no tiene código de país
    if (!telefono.startsWith('+52') && !telefono.startsWith('52')) {
      telefono = '52' + telefono;
    }
    if (!telefono.startsWith('+')) {
      telefono = '+' + telefono;
    }
  }

  // Extraer experiencia profesional
  const experiencia = extractExperienciaProfesional(text);

  return {
    nombre,
    telefono,
    experiencia,
    textoCompleto: text
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
