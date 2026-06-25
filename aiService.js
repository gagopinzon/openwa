const axios = require('axios');
require('dotenv').config();

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const API_KEY = process.env.DEEPSEEK_API_KEY;

if (!API_KEY) {
  console.error('Error: DEEPSEEK_API_KEY no está configurada en el archivo .env');
}

/**
 * Genera un mensaje básico sin IA cuando no hay API key
 * @param {string} nombre - Nombre de la persona
 * @param {string} experiencia - Experiencia profesional
 * @returns {string} - Mensaje básico personalizado
 */
function generateBasicMessage(nombre, experiencia) {
  // Extraer información básica de la experiencia
  const lines = experiencia.split('\n').filter(line => line.trim().length > 0);
  
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

  return `Hola ${nombre},

Vi tu perfil y me pareció muy sólido tu expertise ${expertise}.

En Pro Talent ayudamos a perfiles como el tuyo a escalar profesionalmente, conectándolos con vacantes clave en ${puestoClave} y fortaleciendo su posicionamiento con estrategias activas que resaltan resultados y liderazgo.

¿Te interesaría una sesión gratuita de diagnóstico para revisar tu perfil y explicarte cómo podemos ayudarte a llegar a tu siguiente nivel?
Atte:
Mónica González`;
}

/**
 * Genera un mensaje personalizado usando la API de DeepSeek
 * @param {string} nombre - Nombre de la persona
 * @param {string} experiencia - Experiencia profesional de la persona
 * @returns {Promise<string>} - Mensaje personalizado generado por IA
 */
async function generatePersonalizedMessage(nombre, experiencia) {
  // Si no hay API key o es de prueba, generar mensaje básico
  if (!API_KEY || API_KEY.includes('test') || API_KEY.includes('tu_api_key')) {
    console.log('⚠️  API key no configurada o de prueba. Generando mensaje básico...');
    return generateBasicMessage(nombre, experiencia);
  }

  const prompt = `Eres un experto en reclutamiento. Genera un mensaje personalizado y profesional para ${nombre}.

Experiencia profesional de ${nombre}:
${experiencia}

INSTRUCCIONES:
1. Lee cuidadosamente la experiencia profesional
2. Identifica el PUESTO CLAVE más relevante de la persona (ej: Gerencia de Producción, Supervisión de Calidad, Dirección de Operaciones, etc.)
3. Identifica también un logro destacado, rol específico o industria para personalizar el expertise
4. Genera un mensaje natural y conversacional
5. Varía un poco el mensaje para que no sea repetitivo y se sienta natural
6. Usa solo el primer nombre de la persona, evita usar apellidos

FORMATO EXACTO (debes seguir este formato estrictamente):
Hola [primer nombre],

Vi tu perfil y me pareció muy sólido tu expertise [personaliza aquí con algo específico de su experiencia - máximo 60 caracteres].

En Pro Talent ayudamos a perfiles como el tuyo a escalar profesionalmente, conectándolos con vacantes clave en [PUESTO CLAVE IDENTIFICADO] y fortaleciendo su posicionamiento con estrategias activas que resaltan resultados y liderazgo.

¿Te interesaría una sesión gratuita de diagnóstico para revisar tu perfil y explicarte cómo podemos ayudarte a llegar a tu siguiente nivel?

Atte:
Mónica González

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
- GENERA SOLO UN MENSAJE, NO múltiples variaciones
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
      const separators = ['---', '***', '===', '\n\n\n'];
      for (const separator of separators) {
        if (message.includes(separator)) {
          console.log(`⚠️ Se detectaron múltiples mensajes separados por "${separator}". Tomando solo el primero.`);
          message = message.split(separator)[0].trim();
          break;
        }
      }
      
      // También verificar si hay múltiples mensajes completos (patrón: "Hola [nombre]" aparece múltiples veces)
      const mensajePattern = /Hola\s+[\w\s]+,\s+Vi tu perfil/g;
      const matches = message.match(mensajePattern);
      if (matches && matches.length > 1) {
        console.log(`⚠️ Se detectaron ${matches.length} mensajes completos. Tomando solo el primero.`);
        // Encontrar el final del primer mensaje (antes del segundo "Hola")
        const firstMensajeEnd = message.indexOf(matches[1]);
        if (firstMensajeEnd > 0) {
          message = message.substring(0, firstMensajeEnd).trim();
        }
      }
      
      return message;
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
    
    return `Hola ${nombre},

Vi tu perfil y me pareció muy sólido tu expertise profesional.

En Pro Talent ayudamos a perfiles como el tuyo a escalar profesionalmente, conectándolos con vacantes clave en ${puestoClave} y fortaleciendo su posicionamiento con estrategias activas que resaltan resultados y liderazgo.

¿Te interesaría una sesión gratuita de diagnóstico para revisar tu perfil y explicarte cómo podemos ayudarte a llegar a tu siguiente nivel?
Atte:
Mónica González`;
  }
}

/**
 * Genera mensajes personalizados para múltiples CVs
 * @param {Array} cvs - Array de objetos CV con nombre y experiencia
 * @returns {Promise<Array>} - Array de mensajes generados
 */
async function generateBulkMessages(cvs) {
  const messages = [];
  
  for (let i = 0; i < cvs.length; i++) {
    const cv = cvs[i];
    console.log(`Generando mensaje ${i + 1}/${cvs.length} para ${cv.nombre}`);
    
    try {
      const message = await generatePersonalizedMessage(cv.nombre, cv.experiencia);
      messages.push({
        ...cv,
        mensajeIA: message
      });
      
      // Delay entre llamadas para evitar rate limiting
      if (i < cvs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
    } catch (error) {
      console.error(`Error generando mensaje para ${cv.nombre}:`, error.message);
      messages.push({
        ...cv,
        mensajeIA: `Error generando mensaje para ${cv.nombre}`
      });
    }
  }
  
  return messages;
}

module.exports = {
  generatePersonalizedMessage,
  generateBulkMessages
};
