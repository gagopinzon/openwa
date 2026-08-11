# Diseño: Vínculo Android por línea + canal de primer mensaje

Fecha: 2026-08-11  
Estado: aprobado / implementado

## Decisión (opción C)

- Cada línea puede vincular un `androidDeviceId`.
- Cada línea elige `outreachChannel`: `openwa` | `android` (primer mensaje / lote).
- Auto-reply y conversación del panel: siempre OpenWA.
- El envío masivo usa modo `auto`: reparte contactos por pesos y enruta según la línea.

## Campos en sesión

- `androidDeviceId: string | null`
- `outreachChannel: "openwa" | "android"` (default `openwa`)

## UI

En **Líneas** (admin): selects Celular Android + Primer mensaje + Guardar vínculo.
