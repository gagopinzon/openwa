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

# Auto-respuesta IA (requiere MongoDB + URL pública)
WEBHOOK_PUBLIC_URL=https://tu-dominio.com
WEBHOOK_SECRET=un-secreto-largo-aleatorio
AUTO_REPLY_ENABLED=false
AUTO_REPLY_MIN_DELAY_MS=3000
AUTO_REPLY_MAX_DELAY_MS=35000
AUTO_REPLY_TYPING_BASE_MS=2500
AUTO_REPLY_TYPING_MS_PER_CHAR=200

# Agendar reuniones en Panel (API externa Msg)
# Misma MSG_INTEGRATION_API_KEY que en panel.protalentconnections.com
PANEL_BASE_URL=https://panel.protalentconnections.com
MSG_INTEGRATION_API_KEY=clave_compartida_con_panel
# Opcional: fallback. Lo normal es que cada usuario guarde su correo en la UI ("Tu correo en Panel")
MSG_GERENTE_EMAIL=gerente@protalentconnections.com
```

### Agendar reuniones desde CVs

Con la integración al panel puedes, desde la tabla de CVs, pulsar **Agendar**:

1. Guarda tu **correo de gerente** en la sección *Tu correo en Panel* (debe existir en panel.protalentconnections.com).
2. Se consulta disponibilidad del equipo de ese gerente.
3. Eliges vendedor + slot y confirmas.
4. Msg envía el CV al panel (`cvBase64` desde disco local, o `cvUrl` pública en producción); el panel analiza con DeepSeek, crea la reunión y genera la liga de Meet.

Requisitos: `MSG_INTEGRATION_API_KEY`, correo de gerente (perfil o `MSG_GERENTE_EMAIL`). En máquina local el PDF va en **base64** (no hace falta túnel). En servidor prod puede usarse `cvUrl` con `CV_PUBLIC_URL` alcanzable desde internet.

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
5. Opcional: con panel configurado, pulsa **Agendar** en un CV para crear la reunión en panel.protalentconnections.com.

## Auto-respuesta IA

La sección **Auto-respuesta IA** en la interfaz permite que DeepSeek conteste automáticamente cuando un contacto **ya contactado** responde por WhatsApp.

### Requisitos

- `MONGODB_URI` configurado (el historial guarda teléfono + sesión usada al enviar).
- `WEBHOOK_PUBLIC_URL` apuntando a esta app con HTTPS (OpenWA debe poder hacer POST).
- Sesiones conectadas en OpenWA.

### Activación

1. Configura reglas en el acordeón (prompt base + palabras clave).
2. Pulsa **Guardar configuración**.
3. Pulsa **Activar webhooks** (registra un webhook por sesión en OpenWA).
4. Activa el switch **Auto-respuesta activa**.

Cada número responde **solo desde la sesión que recibió el mensaje** (no hay cruce entre los 6 números).

### URL pública (nginx)

Ejemplo de proxy inverso hacia el puerto de la app (`3445`):

```nginx
server {
    listen 443 ssl;
    server_name msg.tudominio.com;

    location / {
        proxy_pass http://127.0.0.1:3445;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

En `.env`:

```bash
WEBHOOK_PUBLIC_URL=https://msg.tudominio.com
WEBHOOK_SECRET=genera-un-secreto-y-usalo-al-activar-webhooks
```

OpenWA enviará eventos a `https://msg.tudominio.com/api/webhooks/openwa`.

### Probar sin WhatsApp real

Con `TEST_MODE=true`, usa **Probar respuesta** en la UI (teléfono que ya esté en MongoDB tras un envío real previo) o:

```bash
curl -X POST http://localhost:3445/api/auto-reply/test \
  -H "Content-Type: application/json" \
  -d '{"telefono":"5512345678","message":"Hola, me interesa"}'
```

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
| `autoReplyStore.js` / `autoReplyService.js` | Config y lógica de auto-respuesta |
| `contactHistoryStore.js` | Historial MongoDB (teléfono + sesión) |
| `pdfProcessor.js` / `aiService.js` | CVs, mensajes salientes y respuestas IA |

## Diferencias con whatsapp-bulk (Puppeteer)

- No hay `/open-whatsapp` que abre Chrome; verifica estado remoto.
- No hay perfiles `user_data_session*`.
- Las sesiones se administran en el dashboard OpenWA.
- Historial MongoDB en base `whatsapp_bulk_openwa` (separada).
