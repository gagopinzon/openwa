# WA Agent (Android)

App agente que pide jobs al servidor y envía por la app de WhatsApp del celular (intent `api.whatsapp.com/send` + Accesibilidad para pulsar Enviar).

## Requisitos

- Android Studio (o SDK) para compilar el APK
- WhatsApp o WhatsApp Business instalado y logueado
- Servidor con `ANDROID_GATEWAY_TOKEN` en `.env`

## Compilar

```bash
cd android-agent
# con Android Studio: Open → Sync → Build APK
```

## Configurar en el teléfono

1. Instalar el APK
2. Abrir **WA Agent**
3. URL del servidor (ej. `https://tu-dominio` o `http://IP:3445`)
4. Token = valor de `ANDROID_GATEWAY_TOKEN`
5. Etiqueta (ej. `Linea 1`) y opcionalmente `session1`
6. **Registrar dispositivo**
7. **Abrir Accesibilidad** → activar **WA Agent**
8. **Iniciar agente** (dejar el teléfono despierto / sin batería agresiva)

## Enviar desde el panel

1. En **Gateway Android**, confirma dispositivos online
2. Canal de envío → **Android (celular)**
3. Encolar o **Enviar ahora** como siempre

## Notas

- Intervalo mínimo entre envíos por celular: ~3 minutos (configurable en `data/android-gateway.json` → `minIntervalMs`)
- WhatsApp puede cambiar la UI; si deja de pulsar Enviar, hay que ajustar selectores en `WhatsAppAccessibilityService.kt`
- Prospección fría sigue violando ToS de WhatsApp; esto solo cambia el canal de salida
