# Integración de Reporte de Batería

Se ha actualizado el agente Android para enviar el nivel de batería en cada comunicación con el servidor.

## Cambios en los Endpoints del Servidor

El servidor debe estar preparado para recibir el campo `batteryLevel` (tipo Entero, de 0 a 100) en el cuerpo JSON de las siguientes peticiones:

### 1. Registro de Dispositivo
**Ruta:** `POST /api/android/devices/register`
**Nuevo Payload:**
```json
{
  "label": "Nombre del dispositivo",
  "logicalSessionId": "id_sesion_opcional",
  "deviceId": "id_previo_opcional",
  "batteryLevel": 85
}
```

### 2. Heartbeat (Latido)
**Ruta:** `POST /api/android/devices/{deviceId}/heartbeat`
**Nuevo Payload:**
```json
{
  "batteryLevel": 84
}
```

## Consideraciones:
*   **Valor -1:** Si la aplicación no puede leer el estado de la batería, enviará `-1`.
*   **Frecuencia:** El `heartbeat` se envía aproximadamente cada 4-10 segundos mientras el servicio esté activo.
*   **Uso Recomendado:** Se recomienda guardar este valor en la base de datos asociado al `deviceId` para mostrar alertas de "Batería Baja" en el panel de administración si el nivel es inferior al 15-20%.
