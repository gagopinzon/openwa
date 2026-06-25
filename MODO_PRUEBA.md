# 🧪 Modo de Prueba - Sistema de Análisis de CVs

## 📋 Descripción

El sistema incluye un **modo de prueba** que simula el envío de mensajes de WhatsApp sin realmente abrir el navegador o enviar mensajes reales. Esto es ideal para:

- **Desarrollo**: Probar la funcionalidad sin enviar mensajes reales
- **Testing**: Verificar que todo funciona correctamente
- **Demostraciones**: Mostrar el sistema sin afectar números reales

## ⚙️ Configuración

### 1. Activar Modo de Prueba

Edita el archivo `.env`:
```bash
nano .env
```

Configuración para modo de prueba:
```env
DEEPSEEK_API_KEY=tu_api_key_aqui
TEST_MODE=true
PORT=3000
```

### 2. Activar Modo Producción

Para envíos reales, cambia a:
```env
DEEPSEEK_API_KEY=tu_api_key_aqui
TEST_MODE=false
PORT=3000
```

## 🔄 Diferencias entre Modos

| Característica | Modo de Prueba | Modo Producción |
|---|---|---|
| **WhatsApp Web** | ❌ No se abre | ✅ Se abre automáticamente |
| **Envío real** | ❌ Solo simulación | ✅ Mensajes reales |
| **Delay entre mensajes** | 2 segundos | 3 minutos |
| **Tasa de éxito** | 90% simulado | Depende de WhatsApp |
| **Navegador** | No requerido | Requiere Chrome |

## 🎯 Funcionamiento del Modo de Prueba

### Simulación de Envíos
- Simula el proceso completo de envío
- Genera resultados aleatorios (90% éxito, 10% error)
- Muestra progreso en tiempo real
- Delay más corto para testing rápido

### Logs de Prueba
```
🧪 MODO PRUEBA: Simulando envío de mensajes...
🧪 Simulando envío 1/3 a Juan Pérez (+525512345678)
🧪 Esperando 2 segundos antes del siguiente mensaje...
🧪 Simulando envío 2/3 a María García (+525598765432)
🧪 Esperando 2 segundos antes del siguiente mensaje...
🧪 Simulando envío 3/3 a Carlos López (+525511122233)
🧪 Simulación completada
```

### Interfaz Visual
- Banner amarillo indicando modo de prueba
- Mensajes de confirmación específicos
- Indicadores de simulación en el progreso

## 🚀 Cómo Usar

### 1. Configurar Modo de Prueba
```bash
# Editar .env
TEST_MODE=true

# Reiniciar servidor
npm start
```

### 2. Usar el Sistema Normalmente
1. Cargar CVs PDF
2. Procesar archivos
3. Generar mensajes con IA
4. Hacer clic en "Enviar por WhatsApp"

### 3. Observar Simulación
- Verás el banner de modo de prueba
- Los mensajes se simularán con delay de 2 segundos
- Progreso en tiempo real
- Resultados simulados

## 🔧 Personalización

### Cambiar Tasa de Éxito
En `server.js`, función `simulateWhatsAppSending()`:
```javascript
// Cambiar de 0.1 a 0.05 para 95% de éxito
const success = Math.random() > 0.05;
```

### Cambiar Delay de Prueba
```javascript
// Cambiar de 2 a 5 segundos
const delaySeconds = 5;
```

### Agregar Más Logs
```javascript
console.log(`🧪 Simulando detalles del mensaje: ${cv.mensajeIA.substring(0, 50)}...`);
```

## 📊 Ventajas del Modo de Prueba

### Para Desarrolladores
- ✅ Prueba rápida sin WhatsApp
- ✅ No requiere configuración de navegador
- ✅ Logs detallados para debugging
- ✅ Resultados consistentes

### Para Usuarios
- ✅ Seguro para testing
- ✅ No envía mensajes reales
- ✅ Proceso más rápido
- ✅ Ideal para demostraciones

### Para Producción
- ✅ Transición fácil a modo real
- ✅ Misma interfaz y flujo
- ✅ Validación completa del sistema

## 🚨 Importante

### Antes de Producción
1. **Verificar configuración**: `TEST_MODE=false`
2. **Probar con pocos CVs**: Empezar con 2-3 archivos
3. **Verificar API key**: DeepSeek configurada correctamente
4. **Confirmar Chrome**: Navegador instalado y funcional

### Recomendaciones
- Usar modo de prueba para desarrollo
- Cambiar a producción solo cuando esté listo
- Mantener backups de configuración
- Documentar cambios importantes

## 🎉 Resultado

Con el modo de prueba puedes:
- Desarrollar y probar sin riesgo
- Demostrar el sistema fácilmente
- Validar toda la funcionalidad
- Hacer la transición a producción cuando estés listo

¡Perfecto para desarrollo y testing! 🚀

