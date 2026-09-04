const axios = require('axios');
require('dotenv').config();
const { SENDER_PLACEHOLDER } = require('./messageSignature');
const ollamaService = require('./ollamaService');
const { preferredFirstName, phraseWithName } = require('./preferredContactName');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const API_KEY = process.env.DEEPSEEK_API_KEY;

function getReplyProvider() {
  const explicit = String(process.env.AI_REPLY_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'ollama') return 'ollama';
  if (explicit === 'deepseek') return 'deepseek';
  if (ollamaService.isConfigured()) return 'ollama';
  return 'deepseek';
}

function hasDeepSeekKey() {
  return Boolean(
    API_KEY && !String(API_KEY).includes('test') && !String(API_KEY).includes('tu_api_key')
  );
}

/** @param {string} message */
function cleanReplyText(message) {
  let text = String(message || '').trim();
  const separators = ['---', '***', '===', '\n\n\n'];
  for (const separator of separators) {
    if (text.includes(separator)) {
      text = text.split(separator)[0].trim();
      break;
    }
  }
  return text.replace(/\n*\s*Atte:\s*\n?[\s\S]*$/i, '').trim();
}

const GREETING_TEMPLATES = [
  (name) => `Hola ${name}`,
  (name) => `Qué tal ${name}`,
  (name) => `Buen día ${name}`
];

/**
 * Capitaliza un nombre: primera letra mayúscula, resto minúsculas.
 * @param {string} word
 * @returns {string}
 */
function capitalizeName(word) {
  const s = String(word || '').trim();
  if (!s) return s;
  return s.charAt(0).toLocaleUpperCase('es') + s.slice(1).toLocaleLowerCase('es');
}

/**
 * Extrae solo el primer nombre (sin apellidos), capitalizado.
 * @param {string} fullName
 * @returns {string}
 */
function extractFirstName(fullName) {
  const cleaned = String(fullName || '')
    .trim()
    .replace(/^No encontrado$/i, '');
  if (!cleaned) return 'amigo';
  return capitalizeName(cleaned.split(/\s+/)[0]);
}

/**
 * Saludo corto aleatorio con el primer nombre.
 * @param {string} nombre
 * @returns {string}
 */
function buildGreeting(nombre) {
  const firstName = extractFirstName(nombre);
  const template = GREETING_TEMPLATES[Math.floor(Math.random() * GREETING_TEMPLATES.length)];
  return template(firstName);
}

/**
 * Divide el speech en párrafos; la firma "Atte:" queda pegada al último bloque.
 * @param {string} body
 * @returns {string[]}
 */
function splitSpeechParts(body) {
  const raw = String(body || '').trim();
  if (!raw) return [];

  const chunks = raw
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const merged = [];
  for (const chunk of chunks) {
    if (/^Atte:\s*/i.test(chunk) && merged.length) {
      merged[merged.length - 1] += `\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }
  return merged.length ? merged : [raw];
}

/**
 * Arma 1 mensaje de WhatsApp: saludo + speech completo (un solo bubble).
 * @param {{ saludo?: string, nombre?: string, mensajeIA?: string }} contact
 * @returns {string[]} siempre length 1
 */
function buildOutboundMessageParts(contact) {
  const saludo =
    (contact.saludo && String(contact.saludo).trim()) ||
    buildGreeting(contact.nombre);

  let body = String(contact.mensajeIA || '').trim();
  body = body
    .replace(
      /^(Hola|Qué tal|Que tal|Buen[oa]s?\s+d[ií]as?)\s+[\wÁÉÍÓÚáéíóúÑñüÜ.'-]+[,!]?\s*\n+/i,
      ''
    )
    .trim();

  if (!body) return [saludo];
  return [`${saludo}\n\n${body}`];
}

/**
 * Parsea la respuesta de DeepSeek en saludo + cuerpo.
 * @param {string} raw
 * @param {string} nombre
 * @returns {{ saludo: string, mensajeIA: string }}
 */
function parseSaludoAndMessage(raw, nombre) {
  const fallbackSaludo = buildGreeting(nombre);
  let text = String(raw || '').trim();

  const saludoMatch = text.match(/^\s*SALUDO:\s*(.+?)\s*(?:\n|$)/i);
  let saludo = saludoMatch ? saludoMatch[1].trim() : null;

  let body = text;
  if (/MENSAJE:\s*/i.test(text)) {
    body = text.split(/MENSAJE:\s*/i).slice(1).join('MENSAJE:').trim();
  } else if (saludoMatch) {
    body = text.replace(saludoMatch[0], '').trim();
  }

  // Si el modelo metió el saludo dentro del cuerpo, separarlo
  if (!saludo) {
    const inlineGreeting = body.match(
      /^(Hola|Qué tal|Que tal|Buen[oa]s?\s+d[ií]as?)\s+[\wÁÉÍÓÚáéíóúÑñüÜ.'-]+[,!]?\s*\n+/i
    );
    if (inlineGreeting) {
      saludo = inlineGreeting[0].replace(/[,!]?\s*$/, '').trim().replace(/,$/, '');
      body = body.slice(inlineGreeting[0].length).trim();
    }
  }

  // Quitar saludo residual al inicio del cuerpo (evitar repetir el nombre)
  body = body
    .replace(
      /^(Hola|Qué tal|Que tal|Buen[oa]s?\s+d[ií]as?)\s+[\wÁÉÍÓÚáéíóúÑñüÜ.'-]+[,!]?\s*\n*/i,
      ''
    )
    .trim();

  if (!saludo) saludo = fallbackSaludo;

  // Forzar capitalización del nombre en el saludo (evitar TODO MAYÚSCULAS)
  const firstName = extractFirstName(nombre);
  saludo = saludo.replace(
    /^(Hola|Qué tal|Que tal|Buen[oa]s?\s+d[ií]as?)\s+[\wÁÉÍÓÚáéíóúÑñüÜ.'-]+/i,
    (_, greeting) => `${greeting} ${firstName}`
  );

  if (!body) {
    body = `Vi tu perfil y me pareció muy sólido tu expertise profesional.

En Pro Talent ayudamos a perfiles como el tuyo a escalar profesionalmente, conectándolos con vacantes clave y fortaleciendo su posicionamiento con estrategias activas que resaltan resultados y liderazgo.

¿Te interesaría una sesión gratuita de diagnóstico para revisar tu perfil y explicarte cómo podemos ayudarte a llegar a tu siguiente nivel?

Atte:
${SENDER_PLACEHOLDER}`;
  }

  return { saludo, mensajeIA: body };
}

/**
 * Genera un mensaje básico sin IA cuando no hay API key
 * @param {string} nombre - Nombre de la persona
 * @param {string} experiencia - Experiencia profesional
 * @returns {{ saludo: string, mensajeIA: string }}
 */
function generateBasicMessage(nombre, experiencia) {
  let expertise = 'profesional';
  let puestoClave = 'dirección comercial'; // Default
  
  // Buscar patrones comunes para expertise
  if (experiencia.toLowerCase().includes('gerente')) {
    expertise = 'como Gerente';
    if (experiencia.toLowerCase().includes('producción')) {
      puestoClave = 'Gerencia de Producción';
    } else if (experiencia.toLowerCase().includes('ventas')) {
      puestoClave = 'Gerencia de Ventas';
    } else if (experiencia.toLowerCase().includes('operaciones')) {
      puestoClave = 'Gerencia de Operaciones';
    } else {
      puestoClave = 'Gerencia';
    }
  } else if (experiencia.toLowerCase().includes('supervisor')) {
    expertise = 'como Supervisor';
    puestoClave = 'Supervisión';
  } else if (experiencia.toLowerCase().includes('director')) {
    expertise = 'como Director';
    puestoClave = 'Dirección';
  } else if (experiencia.toLowerCase().includes('producción')) {
    expertise = 'en Producción';
    puestoClave = 'Producción';
  } else if (experiencia.toLowerCase().includes('ventas')) {
    expertise = 'en Ventas';
    puestoClave = 'Ventas';
  } else if (experiencia.toLowerCase().includes('marketing')) {
    expertise = 'en Marketing';
    puestoClave = 'Marketing';
  } else if (experiencia.toLowerCase().includes('finanzas')) {
    expertise = 'en Finanzas';
    puestoClave = 'Finanzas';
  } else if (experiencia.toLowerCase().includes('recursos humanos')) {
    expertise = 'en Recursos Humanos';
    puestoClave = 'Recursos Humanos';
  }

  const openerVariants = [
    (e) => `Vi tu perfil y me pareció muy sólido tu expertise ${e}.`,
    (e) => `Revisé tu trayectoria y destaca tu expertise ${e}.`,
    (e) => `Tu perfil se ve muy interesante; resalta tu expertise ${e}.`
  ];
  const bodyVariants = [
    (p) =>
      `En Pro Talent ayudamos a perfiles como el tuyo a escalar profesionalmente, conectándolos con vacantes clave en ${p} y fortaleciendo su posicionamiento con estrategias activas que resaltan resultados y liderazgo.`,
    (p) =>
      `En Pro Talent acompañamos a perfiles como el tuyo a crecer, vinculándolos con oportunidades clave en ${p} y reforzando su posicionamiento con estrategias que destacan resultados y liderazgo.`,
    (p) =>
      `Desde Pro Talent impulsamos a profesionales como tú, acercándolos a vacantes relevantes en ${p} y potenciando su posicionamiento con estrategias activas de resultados y liderazgo.`
  ];
  const ctaVariants = [
    '¿Te interesaría una sesión gratuita de diagnóstico para revisar tu perfil y explicarte cómo podemos ayudarte a llegar a tu siguiente nivel?',
    '¿Te gustaría una sesión gratuita de diagnóstico para revisar tu perfil y contarte cómo podemos apoyarte a dar el siguiente paso?',
    '¿Qué te parecería una sesión gratuita de diagnóstico para analizar tu perfil y mostrarte cómo podemos ayudarte a avanzar?'
  ];

  const opener = openerVariants[Math.floor(Math.random() * openerVariants.length)](expertise);
  const mid = bodyVariants[Math.floor(Math.random() * bodyVariants.length)](puestoClave);
  const cta = ctaVariants[Math.floor(Math.random() * ctaVariants.length)];

  return {
    saludo: buildGreeting(nombre),
    mensajeIA: `${opener}

${mid}

${cta}

Atte:
${SENDER_PLACEHOLDER}`
  };
}

/**
 * Genera un mensaje personalizado usando la API de DeepSeek
 * @param {string} nombre - Nombre de la persona
 * @param {string} experiencia - Experiencia profesional de la persona
 * @returns {Promise<{ saludo: string, mensajeIA: string }>}
 */
async function generatePersonalizedMessage(nombre, experiencia) {
  // Si no hay API key o es de prueba, generar mensaje básico
  if (!API_KEY || API_KEY.includes('test') || API_KEY.includes('tu_api_key')) {
    console.log('⚠️  API key no configurada o de prueba. Generando mensaje básico...');
    return generateBasicMessage(nombre, experiencia);
  }

  const firstName = extractFirstName(nombre);

  const prompt = `Eres un experto en reclutamiento. Genera un saludo corto y un mensaje profesional para ${firstName}.

Experiencia profesional de ${firstName}:
${experiencia}

INSTRUCCIONES:
1. Lee cuidadosamente la experiencia profesional
2. Identifica el PUESTO CLAVE más relevante (ej: Gerencia de Producción, Supervisión de Calidad, Dirección de Operaciones)
3. Identifica un logro, rol o industria para personalizar
4. Usa solo el primer nombre ("${firstName}"), sin apellidos
5. VARIACIÓN OBLIGATORIA: reescribe con otras palabras manteniendo la MISMA estructura e idea (4 bloques). No copies el texto plantilla palabra por palabra. Cambia verbos, adjetivos y formulaciones; conserva el sentido Pro Talent + diagnóstico gratuito.

ESTRUCTURA FIJA DEL MENSAJE (4 bloques separados por línea en blanco):
1) Reconocimiento del perfil / expertise (1-2 frases, personalizado, máx ~90 caracteres en la parte personalizada)
2) Qué hace Pro Talent por perfiles como el suyo + vacantes en el PUESTO CLAVE
3) Pregunta/CTA ofreciendo sesión gratuita de diagnóstico
4) Firma exacta:
Atte:
${SENDER_PLACEHOLDER}

FORMATO EXACTO (sin texto extra fuera de esto):
SALUDO: [UNA variante: "Hola ${firstName}" | "Qué tal ${firstName}" | "Buen día ${firstName}"]
MENSAJE:
[bloque 1]

[bloque 2]

[bloque 3]

Atte:
${SENDER_PLACEHOLDER}

IMPORTANTE - SALUDO Y NOMBRE:
- SALUDO = solo esa línea corta
- El MENSAJE NO debe empezar con Hola/Qué tal ni repetir el nombre
- El nombre "${firstName}" solo en SALUDO

IMPORTANTE - VARIACIÓN:
- Sí varía redacción; no inventes otra estructura ni agregues bloques extra
- No uses listas, emojis ni hashtags
- GENERA UNA sola respuesta SALUDO + MENSAJE
- NO uses separadores --- *** ni múltiples versiones`;

  try {
    const response = await axios.post(DEEPSEEK_API_URL, {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.95,
      max_tokens: 550
    }, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 segundos timeout
    });

    if (response.data && response.data.choices && response.data.choices.length > 0) {
      let message = response.data.choices[0].message.content.trim();
      
      // Limpiar la respuesta: si contiene múltiples mensajes separados por "---" o "***", tomar solo el primero
      const separators = ['---', '***', '==='];
      for (const separator of separators) {
        if (message.includes(separator)) {
          console.log(`⚠️ Se detectaron múltiples mensajes separados por "${separator}". Tomando solo el primero.`);
          message = message.split(separator)[0].trim();
          break;
        }
      }

      return parseSaludoAndMessage(message, nombre);
    } else {
      throw new Error('Respuesta inválida de la API de DeepSeek');
    }

  } catch (error) {
    console.error('Error llamando a DeepSeek API:', error.message);
    
    if (error.response) {
      console.error('Respuesta del servidor:', error.response.status, error.response.data);
    }
    
    // Mensaje de fallback en caso de error - intentar extraer puesto básico
    let puestoClave = 'dirección comercial';
    const expLower = experiencia.toLowerCase();
    if (expLower.includes('gerente') && expLower.includes('producción')) {
      puestoClave = 'Gerencia de Producción';
    } else if (expLower.includes('gerente')) {
      puestoClave = 'Gerencia';
    } else if (expLower.includes('supervisor')) {
      puestoClave = 'Supervisión';
    } else if (expLower.includes('director')) {
      puestoClave = 'Dirección';
    } else if (expLower.includes('producción')) {
      puestoClave = 'Producción';
    } else if (expLower.includes('ventas')) {
      puestoClave = 'Ventas';
    } else if (expLower.includes('operaciones')) {
      puestoClave = 'Operaciones';
    }
    
    return {
      saludo: buildGreeting(nombre),
      mensajeIA: `Vi tu perfil y me pareció muy sólido tu expertise profesional.

En Pro Talent ayudamos a perfiles como el tuyo a escalar profesionalmente, conectándolos con vacantes clave en ${puestoClave} y fortaleciendo su posicionamiento con estrategias activas que resaltan resultados y liderazgo.

¿Te interesaría una sesión gratuita de diagnóstico para revisar tu perfil y explicarte cómo podemos ayudarte a llegar a tu siguiente nivel?

Atte:
${SENDER_PLACEHOLDER}`
    };
  }
}

/**
 * Genera mensajes personalizados para múltiples CVs
 * @param {Array} cvs - Array de objetos CV con nombre y experiencia
 * @returns {Promise<Array>} - Array de mensajes generados
 */
async function generateBulkMessages(cvs, onProgress = null) {
  const messages = [];

  for (let i = 0; i < cvs.length; i++) {
    const cv = cvs[i];
    console.log(`Generando mensaje ${i + 1}/${cvs.length} para ${cv.nombre}`);

    if (onProgress) {
      onProgress({
        current: i,
        total: cvs.length,
        nombre: cv.nombre,
        phase: 'generating'
      });
    }

    try {
      const generated = await generatePersonalizedMessage(cv.nombre, cv.experiencia);
      messages.push({
        ...cv,
        saludo: generated.saludo,
        mensajeIA: generated.mensajeIA
      });

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: cvs.length,
          nombre: cv.nombre,
          phase: 'done'
        });
      }

      // Delay entre llamadas para evitar rate limiting
      if (i < cvs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

    } catch (error) {
      console.error(`Error generando mensaje para ${cv.nombre}:`, error.message);
      messages.push({
        ...cv,
        saludo: buildGreeting(cv.nombre),
        mensajeIA: `Error generando mensaje para ${cv.nombre}`
      });

      if (onProgress) {
        onProgress({
          current: i + 1,
          total: cvs.length,
          nombre: cv.nombre,
          phase: 'error'
        });
      }
    }
  }

  return messages;
}

function generateBasicReply({ contactName, incomingBody, matchedRule, senderName, agendaContext }) {
  const name = preferredFirstName(contactName);
  const hi = name ? `Hola ${name}` : 'Hola';
  const withName = (lead) => (name ? `${lead}, ${name}` : lead);
  if (matchedRule) {
    if (matchedRule.id === 'interes') {
      if (agendaContext && String(agendaContext).startsWith('PREGUNTA_HORA:')) {
        return `¡${withName('Qué bien')}! ¿Qué horario te acomoda mejor?`;
      }
      if (agendaContext) {
        return `¡${withName('Qué bien')}! Te comparto los espacios disponibles:\n${agendaContext}\n¿Cuál te acomoda mejor? ☺️`;
      }
      return `¡Me da gusto${name ? `, ${name}` : ''}! Cuando quieras podemos agendar una sesión gratuita de diagnóstico. ¿Te gustaría ver horarios disponibles? ☺️`;
    }
    if (matchedRule.id === 'precio') {
      return `${hi}, la sesión de diagnóstico es completamente gratuita y sin compromiso. ¿Te gustaría que sigamos platicando o prefieres que veamos horarios con un asesor? ☺️`;
    }
    if (matchedRule.id === 'no') {
      return `Entendido${name ? `, ${name}` : ''}. Gracias por tu tiempo. ¡Mucho éxito!\n\nAtte:\n${senderName}`;
    }
  }
  return `${hi}, gracias por tu mensaje. Cuéntame, ¿en qué te puedo ayudar? Si te late, podemos seguir por aquí o agendar una sesión breve con un asesor. ☺️`;
}

/**
 * Contexto de CV para el prompt: deja explícito que el PDF ya está en el sistema.
 * @param {{ nombre?: string, experiencia?: string }|null} cv
 */
function formatStoredCvContext(cv) {
  if (!cv || typeof cv !== 'object') return null;
  const name = String(cv.nombre || '').trim();
  const exp = String(cv.experiencia || '').trim().slice(0, 500);
  const hasFile = Boolean(String(cv.cvId || '').trim());
  if (!name && !exp && !hasFile) return null;
  const lines = [];
  if (name) lines.push(`Nombre: ${name}`);
  if (exp) lines.push(`Experiencia: ${exp}`);
  lines.push(
    'El PDF de este candidato YA está cargado en el sistema (Cargar CVs). NO pidas el CV ni un currículum.'
  );
  return lines.join('\n');
}

/**
 * @param {boolean} hasStoredCv
 */
function replyCvPolicyInstructions(hasStoredCv) {
  if (hasStoredCv) {
    return (
      'REGLA CRÍTICA — CV DEL LEAD:\n' +
      '- El PDF del CV de este lead YA está cargado en el sistema (mesa "Cargar CVs").\n' +
      '- NUNCA pidas CV, currículum, curriculum, curriculo, PDF, hoja de vida ni "documento".\n' +
      '- NO digas "envíame", "mándame", "compárteme", "necesito", "pásame", "¿podrías enviarme?" refiriéndote al CV.\n' +
      '- Cuando confirme un horario, el sistema usa el CV ya cargado; tú no lo pidas ni lo menciones.'
    );
  }
  return (
    'REGLA CRÍTICA — CV DEL LEAD:\n' +
    '- NUNCA pidas CV, currículum, curriculum, curriculo, PDF, hoja de vida ni "documento" en esta respuesta.\n' +
    '- El sistema toma el archivo de los CVs ya cargados si existe. Tú no lo solicitas.\n' +
    '- Enfócate en la duda o intención del lead y, si aplica, en horarios.'
  );
}

const CV_WORD = '(cv|curriculum|curriculo|curriculumvitae|hoja\\s+de\\s+vida)';
const CV_SEND_VERB = '(envi\\w*|mand\\w*|compart\\w*|pas\\w*|adjunt\\w*|reenvi\\w*|sub\\w*)';

const CV_ASK_PATTERNS = [
  // "envíame tu cv" / "me compartes tu cv" / "podrías mandarme el pdf"
  new RegExp(`\\b${CV_SEND_VERB}\\b[^.?!\\n]{0,60}\\b${CV_WORD}\\b`, 'i'),
  // "tu cv por aquí" / "cv actualizado" / "cv en pdf"
  new RegExp(
    `\\b${CV_WORD}\\b[^.?!\\n]{0,40}\\b(pdf|actualizad[oa]|reciente|por\\s+aqu[ií]|por\\s+whatsapp|a\\s+la\\s+mano)\\b`,
    'i'
  ),
  // "podrías / me puedes / puedes ... verbo ... cv"
  new RegExp(
    `\\b(podr[ií]as|puedes|puedas|me\\s+puedes|te\\s+parece\\s+bien)\\b[^.?!\\n]{0,40}\\b${CV_SEND_VERB}\\b[^.?!\\n]{0,40}\\b${CV_WORD}\\b`,
    'i'
  ),
  // "necesito / requiero / me hace falta / para agendar ... cv"
  new RegExp(
    `\\b(necesito|requiero|hace\\s+falta|me\\s+hace\\s+falta|para\\s+(esto|eso|agendar|revisar|revisarlo|continuar)[^.?!\\n]{0,20})\\b[^.?!\\n]{0,40}\\b${CV_WORD}\\b`,
    'i'
  ),
  // "¿tienes / cuentas con un cv actualizado?"
  new RegExp(
    `\\b(tienes|cuentas\\s+con|dispones\\s+de|tendrias|tendrías|tuvieras)\\b[^.?!\\n]{0,20}(?:un|el|tu)?\\s*${CV_WORD}\\b`,
    'i'
  ),
  // "quisiera / quiero / gustaría ver tu cv"
  new RegExp(
    `\\b(quisiera|quiero|me\\s+gustar[ií]a|nos\\s+gustar[ií]a|ser[ií]a\\s+ideal|ser[ií]a\\s+bueno|si\\s+puedes)\\b[^.?!\\n]{0,40}\\b${CV_WORD}\\b`,
    'i'
  )
];

const CV_HAVE_PATTERNS = [
  /\bya\s+(lo\s+)?(tenemos|tengo|est[aá]|qued[oó])\b[^.?!\n]{0,30}\b(cv|curr[ií]culum?|curriculo|hoja\s+de\s+vida)\b/i,
  /\bcon\s+el\s+(cv|curr[ií]culum?|curriculo|hoja\s+de\s+vida)\s+que\b/i
];

function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * ¿La respuesta del modelo está pidiendo el CV?
 * @param {string} text
 */
function looksLikeAskingForCv(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const norm = normalizeForMatch(raw);
  if (CV_HAVE_PATTERNS.some((re) => re.test(norm))) return false;
  return CV_ASK_PATTERNS.some((re) => re.test(norm));
}

/**
 * Quita oraciones que piden CV; si toda la respuesta era eso, retorna null.
 * @param {string} text
 * @returns {string|null}
 */
function stripCvRequestFromReply(text) {
  const original = String(text || '');
  if (!original.trim()) return original || null;
  if (!looksLikeAskingForCv(original)) return original;

  const sentences = original
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = sentences.filter((s) => !looksLikeAskingForCv(s));
  const cleaned = kept.join(' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned;
}

/**
 * Formatea los últimos mensajes del chat para el prompt de auto-respuesta.
 * @param {Array<{ body?: string, fromMe?: boolean }>} messages
 * @param {number} [maxLines=6]
 * @returns {string|null}
 */
function formatConversationHistoryForPrompt(messages, maxLines = 6) {
  const limit = Math.min(Math.max(parseInt(maxLines, 10) || 6, 1), 12);
  const list = (Array.isArray(messages) ? [...messages] : [])
    .filter((m) => String((m && m.body) || '').trim())
    .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
  if (!list.length) return null;

  const recent = list.slice(-limit);
  const lines = recent.map((m) => {
    const who = m.fromMe ? 'Tú' : 'Lead';
    const body = String(m.body || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 320);
    return `${who}: ${body}`;
  });
  return lines.join('\n');
}

/**
 * Genera respuesta conversacional a mensaje entrante.
 * @param {object} params
 */
async function generateReplyMessage({
  contactName,
  incomingBody,
  basePrompt,
  matchedRule,
  senderName,
  conversationContext,
  conversationHistory,
  agendaContext,
  allowGreeting = true
}) {
  const sender = senderName || 'Pro Talent';
  const ruleHint = matchedRule
    ? `\nRegla aplicada (${matchedRule.label}): ${matchedRule.instruction}`
    : '';

  const contextBlock = conversationContext
    ? `\nContexto del candidato (CV):\n${conversationContext}`
    : '';
  const hasStoredCv = Boolean(String(conversationContext || '').trim());
  const cvPolicy = replyCvPolicyInstructions(hasStoredCv);

  const agendaBlock = agendaContext
    ? `\nHORARIOS REALES DISPONIBLES (sustituyen cualquier XXXX / XXXXXXX del playbook; NO inventes otros):\n${agendaContext}`
    : '';

  const historyBlock = conversationHistory
    ? `\nHistorial reciente de la conversación (cronológico; "Tú" = mensajes que ya enviaste):\n${conversationHistory}`
    : '';

  const provider = getReplyProvider();
  const canUseDeepSeek = provider === 'deepseek' && hasDeepSeekKey();
  const canUseOllama = provider === 'ollama' && ollamaService.isConfigured();

  const firstName = preferredFirstName(contactName);
  const nameInstruction = firstName
    ? `- Usa solo el primer nombre "${firstName}" si aplica.`
    : `- NO uses nombre de WhatsApp ni inventes un nombre; habla de forma genérica (sin "Hola [nombre]").`;

  function sanitizeAgainstCvAsk(raw) {
    const base = cleanReplyText(raw);
    const cleaned = stripCvRequestFromReply(base);
    if (cleaned && cleaned !== base) {
      console.warn(
        '[auto-reply] modelo pidió CV; se filtró del reply. original=',
        String(raw).slice(0, 200)
      );
    }
    if (cleaned) return cleaned;
    console.warn(
      '[auto-reply] reply completo era pedir CV; se sustituye por fallback sin CV. original=',
      String(raw).slice(0, 200)
    );
    if (hasStoredCv) {
      return `${phraseWithName('Perfecto', firstName)}. Ya tenemos tu CV en el sistema. ¿Qué horario te acomoda mejor, hoy o mañana? ☺️`;
    }
    return `${phraseWithName('Perfecto', firstName)}. ¿Qué horario te acomoda mejor, hoy o mañana? ☺️`;
  }

  if (!canUseDeepSeek && !canUseOllama) {
    if (agendaContext) {
      const hi = allowGreeting ? (firstName ? `Hola ${firstName}, ` : 'Hola, ') : '';
      if (String(agendaContext).startsWith('PREGUNTA_HORA:')) {
        return `${hi}¿Qué horario te acomoda mejor?`;
      }
      return `${hi}te comparto los espacios disponibles:\n${agendaContext}\n¿Cuál de estos horarios te acomoda mejor? ☺️`;
    }
    return sanitizeAgainstCvAsk(
      generateBasicReply({
        contactName,
        incomingBody,
        matchedRule,
        senderName: sender,
        agendaContext
      })
    );
  }

  const agendaInstructions = agendaContext
    ? String(agendaContext).startsWith('PREGUNTA_HORA:')
      ? `
- PRIORIDAD MÁXIMA: el lead quiere agendar pero AÚN NO dijo una hora.
- NO listes horarios, tramos, ni ejemplos de horas libres.
- Pregunta UNA sola cosa: qué horario le acomoda mejor (hoy o mañana).
- No inventes horas. Sé breve.`
      : `
- PRIORIDAD MÁXIMA: los HORARIOS REALES de arriba sustituyen cualquier XXXX / ejemplo del playbook.
- Si el lead responde "sí", "perfecto" o "está bien" a una hora que TÚ acabas de proponer, NO vuelvas a preguntar el día ni la hora.
- "5 de la tarde" es 17:00; "8 de la noche" es 20:00; "9 de la mañana" es 09:00. "A las 5" (sin am/pm) es 17:00.
- Si el sistema ya envió un PDF de CV para confirmar, no vuelvas a pedir el horario; espera que diga sí o envíe otro PDF.
- Ofrece las horas listadas en HORARIOS REALES tal cual (lista de horas libres, no rangos "de X a Y").
- Si el lead pide algo ENTRE dos horas ofrecidas (ej. "¿tienes entre las 10 y las 11?") y en las notas hay un tramo real que lo cubre, sugiere la media hora (ej. "¿te queda a las 10:30?").
- La sesión es de 15 minutos.
- NUNCA inventes horas ni digas nombres de vendedores.
- Sé breve: una sola pregunta o confirmación por mensaje; evita confirmaciones redundantes.`
    : `
- Si no hay lista de horarios reales inyectada, NO inventes horas concretas ni empujes agendar; responde lo que preguntó el lead y deja la puerta abierta sin presionar.`;

  const greetingInstructions = allowGreeting
    ? `- Puedes abrir con un saludo breve (Hola / gusto saludarte) si encaja.`
    : `- NO saludes de nuevo (nada de "Hola", "gusto saludarte", "buenos días/tardes/noches" al inicio). Esta conversación ya está activa; ve directo a la respuesta.`;

  const prompt = `${cvPolicy}

${basePrompt || 'Eres un asistente de Pro Talent.'}

${firstName ? `Nombre del contacto: ${firstName}` : 'Nombre del contacto: (desconocido — no uses nick de WhatsApp ni inventes nombre)'}
Mensaje que te escribió:
"${incomingBody}"
${ruleHint}${contextBlock}${historyBlock}${agendaBlock}

INSTRUCCIONES DEL SISTEMA (prioritarias, sustituyen al playbook si hay conflicto):
${cvPolicy}
- Responde en español como Mónica: cercana, profesional y relajada; no suenes vendedora ni apresures a agendar.
- Si el lead hace una PREGUNTA (servicio, proceso, costos, tiempos, dudas): responde ESA pregunta primero y completa. No cambies de tema ni metas horarios si no los pidió.
- Tras responder una duda, puedes cerrar con una invitación SUAVE (ej. "¿te gustaría que un asesor te acompañe en una sesión breve?" o "¿quieres que sigamos con esto?"). Sin presionar ni repetirla en cada mensaje.
- No uses cierres agresivos ("¿agendamos ya?", "¿te paso horarios?") si el lead no mostró interés ni lo pidió.
- Puedes ser breve pero humana (1–3 frases); reconoce lo que dijo el lead antes de aportar información.
- Solo ofrece agendar o comparte horarios cuando el lead muestre interés en la sesión o pregunte por disponibilidad/horarios.
- Zona horaria: México (CDMX).
- No firmes con "Atte:" ni con nombre de sesión; ya te presentaste.
- Emojis: solo 💙 y ☺️ si el playbook los usa; no uses otros.
- Responde al mensaje del lead; no reenvíes el pitch frío completo.
- Si hay historial reciente: NO repitas saludos, propuestas, horarios, preguntas ni datos que ya aparecen en mensajes marcados como "Tú". Avanza la conversación con algo nuevo.
${nameInstruction}
- Sé breve: los leads no quieren paredes de texto; resume el playbook.
- Ideal: un solo párrafo corto. Si necesitas 2–3 ideas, sepáralas con una línea en blanco entre párrafos (así se envían como mensajes distintos).
${cvPolicy}
${greetingInstructions}
${agendaInstructions}

Genera SOLO el texto del mensaje de WhatsApp, sin explicaciones ni alternativas.`;

  if (canUseOllama) {
    try {
      const message = await ollamaService.chatReply(prompt, {
        basePrompt: basePrompt || undefined,
        systemExtra: `${cvPolicy}\n${agendaInstructions}`
      });
      return sanitizeAgainstCvAsk(message);
    } catch (error) {
      console.error(
        `[auto-reply] Ollama (${ollamaService.getModel()}):`,
        error.message
      );
      return sanitizeAgainstCvAsk(
        generateBasicReply({
          contactName,
          incomingBody,
          matchedRule,
          senderName: sender,
          agendaContext
        })
      );
    }
  }

  try {
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: cvPolicy },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 450
      },
      {
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    if (response.data?.choices?.length > 0) {
      return sanitizeAgainstCvAsk(response.data.choices[0].message.content);
    }
    throw new Error('Respuesta inválida de DeepSeek');
  } catch (error) {
    console.error('Error generando auto-respuesta:', error.message);
    return sanitizeAgainstCvAsk(
      generateBasicReply({
        contactName,
        incomingBody,
        matchedRule,
        senderName: sender,
        agendaContext
      })
    );
  }
}

module.exports = {
  generatePersonalizedMessage,
  generateBulkMessages,
  generateReplyMessage,
  formatConversationHistoryForPrompt,
  getReplyProvider,
  buildGreeting,
  buildOutboundMessageParts,
  splitSpeechParts,
  extractFirstName,
  parseSaludoAndMessage,
  formatStoredCvContext,
  replyCvPolicyInstructions,
  looksLikeAskingForCv,
  stripCvRequestFromReply
};
