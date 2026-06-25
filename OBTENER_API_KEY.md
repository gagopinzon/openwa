# 🔑 Cómo Obtener tu API Key de DeepSeek

## 📋 Pasos para Obtener tu API Key Real

### 1. **Registrarse en DeepSeek**
- Ve a: https://platform.deepseek.com/
- Haz clic en "Sign Up" o "Registrarse"
- Crea tu cuenta con email y contraseña

### 2. **Verificar tu Email**
- Revisa tu correo electrónico
- Haz clic en el enlace de verificación

### 3. **Acceder al Dashboard**
- Inicia sesión en https://platform.deepseek.com/
- Ve a tu dashboard personal

### 4. **Generar API Key**
- Busca la sección "API Keys" o "Claves API"
- Haz clic en "Create API Key" o "Crear Clave"
- Dale un nombre (ej: "CV-Analyzer")
- Copia la clave generada (empieza con `sk-`)

### 5. **Configurar en tu Sistema**
```bash
# Editar el archivo .env
nano .env
```

Reemplaza esta línea:
```env
DEEPSEEK_API_KEY=sk-test123456789
```

Por tu API key real:
```env
DEEPSEEK_API_KEY=sk-tu_api_key_real_aqui
```

## 💰 **Costos de DeepSeek**

- **Modelo deepseek-chat**: ~$0.14 por 1M tokens de entrada, $0.28 por 1M tokens de salida
- **Para generar ~100 mensajes**: Aproximadamente $0.50 - $1.00 USD
- **Créditos gratuitos**: DeepSeek suele dar créditos iniciales para probar

## 🔒 **Seguridad**

- ✅ **NUNCA** compartas tu API key
- ✅ **NUNCA** la subas a GitHub
- ✅ Guárdala solo en el archivo `.env`
- ✅ El archivo `.env` está en `.gitignore` (no se sube a repositorios)

## 🚨 **Formato de API Key**

Tu API key real debería verse así:
```
sk-1234567890abcdef1234567890abcdef1234567890abcdef
```

**NO** así (esta es falsa):
```
sk-test123456789
```

## 🧪 **Modo de Prueba Sin API Key**

Si quieres probar el sistema sin API key real, puedes:

1. **Desactivar la generación de IA** temporalmente
2. **Usar mensajes predefinidos** para testing
3. **Probar solo la funcionalidad de PDF** y WhatsApp

¿Quieres que configure el sistema para funcionar sin IA mientras obtienes tu API key?

## 📞 **Soporte**

Si tienes problemas:
1. Verifica que tu cuenta esté verificada
2. Asegúrate de tener créditos disponibles
3. Revisa que la API key esté copiada correctamente
4. Reinicia el servidor después de cambiar el .env

