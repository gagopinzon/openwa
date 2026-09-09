# Diseño: Lista de espera cuando no hay horarios ese día

Fecha: 2026-09-09  
Estado: aprobado (enfoque A, sondeo cada 5 h)

## Problema

El lead pide un día concreto (`jueves 17`, `el 17`, `17 de septiembre`). El parser solo usa el weekday → próximo jueves (p. ej. el 10). Si esa semana no está en el panel, se ofrecen huecos de **esta** semana y se agenda el día equivocado.

## Decisiones

| Tema | Decisión |
|------|----------|
| Fecha | Parsear día de mes + weekday + `N de septiembre` |
| `jueves 17` | Fecha (17), no las 17:00. `jueves 17:00` / `a las 17` sí es hora |
| Sin huecos ese día | No sustituir por esta semana. Avisar y guardar espera |
| Primer mensaje | Solo: aún no hay horarios; te aviso. Sin listar hoy/mañana |
| Aviso posterior | Automático por WhatsApp |
| Disparo | Lo primero: huecos para **ese** día, o faltan ≤2 días y sigue vacío |
| Sondeo | Cada **5 horas** + una pasada al arrancar Node |
| Vacío a 2 días | Solo si al inscribirse faltaban **más** de 2 días (no spam si pidió mañana) |
| Huecos después del nudge | Sí se mandan las horas (una vez) |
| Persistencia | JSON `data/agenda-waitlist.json` |
| UI / 413 CV | Fuera de alcance |

## Parser

Antes del weekday suelto, en `resolveDateRangeFromMessage`:

1. `17 de septiembre` / `17 de sep`
2. `jueves 17` (número 1–31, no `17:00`) → próximo YMD en ≤62 días con ese día de mes **y** weekday; si no calza el weekday, el próximo día 17
3. `el 17` si 8–31 (1–7 queda para “opción 2”)

## Store

Un ítem activo por teléfono. Pedir otro día actualiza `fecha`.

```
waiting | notified_slots | notified_empty | cancelled | expired | booked
```

Campos: `telefono`, `chatId`, `openwaSessionId`, `logicalSessionId`, `contactName`, `fecha`, `label`, `cvId`, timestamps de aviso.

Cancelar si: cita pending/confirmada **ese** mismo día, o `fecha` < hoy. Si hay pending de **otro** día y piden uno sin huecos, igual se guarda la espera (no se borra la cita).

## Job

Para cada `waiting`:

1. Fecha pasada → `expired`
2. Pending/confirmada esa fecha → `booked`
3. IA pausada o sesión IA off → skip (sigue waiting)
4. Hay slots ese día y no `notified_slots` → WhatsApp con horas, `rememberOffer`, `notified_slots`
5. Si no hay slots, `daysUntil <= 2`, al crear `daysUntil > 2`, y no `notified_empty` → nudge vacío, sigue `waiting`

Textos fijos (no LLM). Fuera: UI, 413, avisar al asesor.
