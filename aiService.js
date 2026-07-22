const axios = require('axios');
require('dotenv').config();
const { SENDER_PLACEHOLDER } = require('./messageSignature');

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const API_KEY = process.env.DEEPSEEK_API_KEY;

if (!API_KEY) {
  console.error('Error: DEEPSEEK_API_KEY no está configurada en el archivo .env');
}

const GREETING_TEMPLATES = [
  (name) => `Hola ${name}`,
  (name) => `Qué tal ${name}`,
  (name) => `Buen día ${name}`
];

/**
 * Extrae solo el primer nombre (sin apellidos).
 * @param {string} fullName
 * @returns {string}
 */
function extractFirstName(fullName) {
  const cleaned = String(fullName || '')
    .trim()
    .replace(/^No encontrado$/i, '');
  if (!cleaned) return 'amigo';
  return cleaned.split(/\s+/)[0];
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

  return {
    saludo: buildGreeting(nombre),
    mensajeIA: `Vi tu perfil y me pareció muy sólido tu expertise ${expertise}.

En Pro Talent ayudamos a perfiles como el tuyo a escalar profesionalmente, conectándolos con vacantes clave en ${puestoClave} y fortaleciendo su posicionamiento con estrategias activas que resaltan resultados y liderazgo.

¿Te interesaría una sesión gratuita de diagnóstico para revisar tu perfil y explicarte cómo podemos ayudarte a llegar a tu siguiente nivel?

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
2. Identifica el PUESTO CLAVE más relevante de la persona (ej: Gerencia de Producción, Supervisión de Calidad, Dirección de Operaciones, etc.)
3. Identifica también un logro destacado, rol específico o industria para personalizar el expertise
4. Genera un mensaje natural y conversacional
5. Varía un poco el mensaje para que no sea repetitivo y se sienta natural
6. Usa solo el primer nombre ("${firstName}"), evita usar apellidos

FORMATO EXACTO (debes seguir este formato estrictamente, sin texto extra):
SALUDO: [elige UNA variante natural: "Hola ${firstName}" o "Qué tal ${firstName}" o "Buen día ${firstName}"]
MENSAJE:
Vi tu perfil y me pareció muy sólido tu expertise [personaliza aquí con algo específico de su experiencia - máximo 60 caracteres].

En Pro Talent ayudamos a perfiles como el tuyo a escalar profesionalmente, conectándolos con vacantes clave en [PUESTO CLAVE IDENTIFICADO] y fortaleciendo su posicionamiento con estrategias activas que resaltan resultados y liderazgo.

¿Te interesaría una sesión gratuita de diagnóstico para revisar tu perfil y explicarte cómo podemos ayudarte a llegar a tu siguiente nivel?

Atte:
${SENDER_PLACEHOLDER}

IMPORTANTE - SALUDO Y NOMBRE:
- El SALUDO es un mensaje corto aparte (solo la línea de saludo, sin coma final obligatoria)
- El MENSAJE NO debe empezar con "Hola", "Qué tal" ni mencionar el nombre de la persona
- El nombre "${firstName}" solo puede aparecer en la línea SALUDO

IMPORTANTE - PUESTO CLAVE:
- Debes identificar el puesto clave basándote en su experiencia
- Ejemplos de puestos clave: "Gerencia de Producción", "Supervisión de Calidad", "Dirección de Operaciones", "Gerencia de Ventas", "Producción", "Operaciones", "Calidad", etc.
- NO uses "dirección comercial" a menos que realmente sea su área
- El puesto debe ser específico y relevante a su experiencia

EJEMPLOS DE PERSONALIZACIÓN DEL EXPERTISE:
- "tu expertise como Gerente de Producción en Graham Packaging"
- "tu experiencia mejorando la eficiencia operativa en un 2%"
- "tu trayectoria en manufactura de botellas de plástico"
- "tu liderazgo en equipos de producción"
- "tu experiencia en auditorías ISO y gestión de calidad"

EJEMPLOS DE PUESTOS CLAVE (según experiencia):
- Si es Gerente de Producción → "Gerencia de Producción"
- Si es Supervisor de Calidad → "Supervisión de Calidad"
- Si trabaja en Operaciones → "Operaciones"
- Si es Director → "Dirección"
- Si es de Ventas → "Ventas" o "Gerencia de Ventas"

REGLAS IMPORTANTES:
- Máximo 60 caracteres para la personalización del expertise
- El puesto clave debe ser específico y relevante
- Usa lenguaje natural y conversacional
- Mantén el resto del mensaje exactamente igual al formato
- GENERA SOLO UNA respuesta con SALUDO + MENSAJE, NO múltiples variaciones
- NO uses separadores como "---" o "***"
- NO generes múltiples versiones del mensaje`;

  try {
    const response = await axios.post(DEEPSEEK_API_URL, {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 500
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

function generateBasicReply({ contactName, incomingBody, matchedRule, senderName }) {
  const name = contactName || 'contacto';
  if (matchedRule) {
    if (matchedRule.id === 'interes') {
      return `¡Excelente, ${name}! Me da gusto saberlo. ¿Qué día y horario te acomoda para una sesión gratuita de diagnóstico?\n\nAtte:\n${senderName}`;
    }
    if (matchedRule.id === 'precio') {
      return `Hola ${name}, la sesión de diagnóstico es completamente gratuita y sin compromiso. ¿Te gustaría agendarla?\n\nAtte:\n${senderName}`;
    }
    if (matchedRule.id === 'no') {
      return `Entendido, ${name}. Gracias por tu tiempo. ¡Mucho éxito!\n\nAtte:\n${senderName}`;
    }
  }
  return `Hola ${name}, gracias por tu mensaje. ¿En qué puedo ayudarte con respecto a tu desarrollo profesional?\n\nAtte:\n${senderName}`;
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
  conversationContext
}) {
  const sender = senderName || 'Pro Talent';
  const ruleHint = matchedRule
    ? `\nRegla aplicada (${matchedRule.label}): ${matchedRule.instruction}`
    : '';

  const contextBlock = conversationContext
    ? `\nContexto del candidato (CV):\n${conversationContext}`
    : '';

  if (!API_KEY || API_KEY.includes('test') || API_KEY.includes('tu_api_key')) {
    return generateBasicReply({
      contactName,
      incomingBody,
      matchedRule,
      senderName: sender
    });
  }

  const prompt = `${basePrompt || 'Eres un asistente de Pro Talent.'}

Nombre del contacto: ${contactName || 'contacto'}
Mensaje que te escribió:
"${incomingBody}"
${ruleHint}${contextBlock}

INSTRUCCIONES:
- Responde en español, tono conversacional y profesional.
- Máximo 400 caracteres (sin contar la firma).
- Responde directamente a su mensaje; no repitas el pitch inicial completo.
- Usa solo el primer nombre si aplica.
- Termina con:
Atte:
${sender}

Genera SOLO el texto del mensaje de respuesta, sin explicaciones ni alternativas.`;

  try {
    const response = await axios.post(
      DEEPSEEK_API_URL,
      {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.6,
        max_tokens: 300
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
      let message = response.data.choices[0].message.content.trim();
      const separators = ['---', '***', '===', '\n\n\n'];
      for (const separator of separators) {
        if (message.includes(separator)) {
          message = message.split(separator)[0].trim();
          break;
        }
      }
      if (!message.includes('Atte:')) {
        message += `\n\nAtte:\n${sender}`;
      }
      return message;
    }
    throw new Error('Respuesta inválida de DeepSeek');
  } catch (error) {
    console.error('Error generando auto-respuesta:', error.message);
    return generateBasicReply({
      contactName,
      incomingBody,
      matchedRule,
      senderName: sender
    });
  }
}

module.exports = {
  generatePersonalizedMessage,
  generateBulkMessages,
  generateReplyMessage,
  buildGreeting,
  extractFirstName,
  parseSaludoAndMessage
};
