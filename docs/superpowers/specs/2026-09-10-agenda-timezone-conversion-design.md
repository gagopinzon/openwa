# Diseño: zonas horarias del lead → hora del centro

Fecha: 2026-09-10  
Estado: implementado

## Problema

La agenda interna y el panel viven en **hora del centro** (`America/Mexico_City`). Los leads a veces piden hora local (“a las 12 de Hermosillo / Cancún”). Sin conversión, se agenda la hora literal y no la equivalente en centro.

## Decisiones

| Tema | Decisión |
|------|----------|
| Fuente de zona | Solo si el lead **nombra** ciudad/estado/zona en el mensaje |
| Sin mención | Asumir **hora del centro** y decirlo al confirmar |
| Canónico interno | Siempre centro (slots, panel, pending) |
| Conversión | Código determinista (`agendaTimezone.js`), no el LLM |
| Confirmación con desfase | Ambas horas: “tus 12:00 (Hermosillo), 13:00 hora del centro” |
| Confirmación sin desfase | “a las HH:MM hora del centro” |

## Enfoque

1. Detectar mención (mapa ciudad/estado → IANA).
2. Interpretar la hora pedida (mismo sesgo tarde 1–7).
3. Convertir pared local → centro con `Intl`.
4. Buscar/agendar slot en hora centro.
5. Redactar confirmación dual o “hora del centro”.

## Archivos

- `agendaTimezone.js` — mapa, conversión, frases
- `agendaPreferredTime.js` / `agendaIntent.js` — parseo y match de slots
- `autoReplyService.js` / `agendaMeetMessages.js` — mensajes al lead
- `autoReplyStore.js` — reglas del prompt

## Fuera de alcance

- Inferir zona solo por `leadCiudad`/`leadEstado` guardados (sin mención en el mensaje)
- Husos fuera de México
