# openwa

Sistema de análisis de CVs con IA y envío masivo por WhatsApp vía [OpenWA](https://github.com/rmyndharis/OpenWA).

Documentación completa en [README-OPENWA.md](README-OPENWA.md).

## Inicio rápido

```bash
cp .env.example .env   # completa DEEPSEEK_API_KEY, OPENWA_API_KEY y sesiones
# Para agendar en panel: MSG_INTEGRATION_API_KEY, MSG_GERENTE_EMAIL, WEBHOOK_PUBLIC_URL
# Para descargar CVs desde OCC al agendar: OCC_USER, OCC_PASSWORD
npm install
npx playwright install chromium              # browser
sudo npx playwright install-deps chromium    # libs del SO en Linux (libnspr4, etc.)
npm start
```

Interfaz: http://localhost:3445
