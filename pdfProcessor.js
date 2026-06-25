const pdfParse = require('pdf-parse');

/**
 * Extrae texto de un PDF desde un buffer
 * @param {Buffer} buffer - Buffer del archivo PDF
 * @returns {Promise<string>} - Texto extraído del PDF
 */
async function extractTextFromPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text.trim();
  } catch (error) {
    console.error('Error extrayendo texto del PDF:', error);
    throw new Error(`Error procesando PDF: ${error.message}`);
  }
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
  extractTextFromPDF,
  extractCVData
};
