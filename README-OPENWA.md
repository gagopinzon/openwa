# WhatsApp Bulk — versión OpenWA

Copia independiente de `whatsapp-bulk` que envía mensajes vía [OpenWA](https://github.com/rmyndharis/OpenWA) en lugar de Puppeteer/Chrome.

El proyecto original (`whatsapp-bulk/`) no se modifica y sigue usando WhatsApp Web local.

## Requisitos

- Node.js 18+
- API key de DeepSeek (mensajes con IA)
- Instancia OpenWA desplegada y sesión(es) conectada(s)
- MongoDB opcional (historial de contactos ya notificados)

## Variables de entorno

Copia `.env.example` a `.env` y completa:

```bash
PORT=3445
TEST_MODE=true
DEEPSEEK_API_KEY=tu_clave_deepseek

OPENWA_BASE_URL=https://openwa.protalentconnections.com/api
OPENWA_API_KEY=tu_api_key_openwa

# Las sesiones se configuran en la web (persisten en data/sessions.json en el servidor).
# Opcional: si data/sessions.json está vacío al primer arranque, se importan desde .env:
# OPENWA_SESSION_SESSION1=id-sesion-1
# OPENWA_SESSION_SESSION2=id-sesion-2

# Historial separado del proyecto Puppeteer (opcional)
# MONGODB_URI=mongodb://whatsapp_app:PASSWORD@localhost:27017/whatsapp_bulk_openwa?authSource=whatsapp_bulk_openwa
```

### Configurar sesiones (sin editar .env cada vez)

1. En la interfaz web, sección **Sesiones WhatsApp (OpenWA)**.
2. Pulsa **↻** para cargar las sesiones del dashboard OpenWA.
3. Elige una en el desplegable y **Agregar sesión**, o usa **Importar conectadas** para traer todas las que estén `CONNECTED`.
4. Las sesiones quedan guardadas en `data/sessions.json` en el servidor (sobreviven reinicios y deploys).

Puedes tener 2, 8 o las que necesites. El selector y los checkboxes de envío se generan solos según lo guardado.

### Migración desde .env (solo primera vez)

Si `data/sessions.json` está vacío al arrancar, el servidor importa automáticamente `OPENWA_SESSION_SESSION1/2/3` si existen en `.env`.

## Instalación y arranque

```bash
cd whatsapp-bulk-openwa
npm install
npm start
```

Interfaz: http://localhost:3445

## Flujo de uso

1. Conecta las sesiones en el dashboard de OpenWA (escanear QR).
2. En la web, configura las sesiones en **Sesiones WhatsApp** (agregar o importar conectadas).
3. Pulsa **Verificar sesiones OpenWA**.
4. Sube PDFs, genera mensajes con IA y envía (o usa `TEST_MODE=true` para simular).

## Verificar sesión con curl

```bash
export OPENWA_BASE_URL=https://openwa.protalentconnections.com/api
export OPENWA_API_KEY=tu_api_key
export SESSION_ID=tu_session_id

curl -s "$OPENWA_BASE_URL/sessions/$SESSION_ID" \
  -H "X-API-Key: $OPENWA_API_KEY"
```

Respuesta esperada: `"status": "connected"` (o similar).

## Enviar mensaje de prueba con curl

```bash
curl -X POST "$OPENWA_BASE_URL/sessions/$SESSION_ID/messages/send-text" \
  -H "X-API-Key: $OPENWA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chatId":"521234567890@c.us","text":"Hola desde OpenWA"}'
```

Sustituye el `chatId` por el número en formato México (`521` + 10 dígitos + `@c.us`).

## Modo prueba

Con `TEST_MODE=true` en `.env`:

- No se llama a OpenWA.
- Los envíos se simulan en el servidor.
- El botón de verificar sesiones se oculta.

Recomendado para probar PDF + IA antes de envíos reales.

## Despliegue en servidor

### Primera vez

```bash
git clone https://github.com/gagopinzon/openwa.git
cd openwa
cp .env.example .env   # editar con tus claves
chmod +x deploy.sh
./deploy.sh
```

El script `deploy.sh` hace: `git pull` → `npm install` → `pm2 startOrReload ecosystem.config.cjs` → `pm2 save`.

### Actualizaciones

Desde la carpeta del proyecto en el servidor:

```bash
./deploy.sh
# o
npm run deploy
```

### PM2 manual

```bash
pm2 start ecosystem.config.cjs
pm2 logs msg
pm2 restart msg
pm2 stop msg
```

La app carga variables desde `.env` (no se sube a git). Logs en `logs/out.log` y `logs/error.log`.

### Requisitos en el servidor

- Node.js 18+
- PM2: `npm install -g pm2`
- Opcional al boot: `pm2 startup` y luego `pm2 save`

## Archivos principales

| Archivo | Rol |
|---------|-----|
| `server.js` | API Express e interfaz web |
| `sessionsStore.js` | Sesiones guardadas en `data/sessions.json` |
| `openwaClient.js` | Cliente HTTP OpenWA |
| `openwaWhatsAppService.js` | Envío masivo y delays |
| `pdfProcessor.js` / `aiService.js` | Igual que el proyecto original |

## Diferencias con whatsapp-bulk (Puppeteer)

- No hay `/open-whatsapp` que abre Chrome; verifica estado remoto.
- No hay perfiles `user_data_session*`.
- Las sesiones se administran en el dashboard OpenWA.
- Historial MongoDB en base `whatsapp_bulk_openwa` (separada).
