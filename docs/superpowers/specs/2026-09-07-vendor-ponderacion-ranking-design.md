# Design: Ranking de vendedores por ponderación y carga

**Fecha:** 2026-09-07  
**Alcance:** Solo auto-confirmación WhatsApp (`agendaConfirmService` / `AUTO_AGENDA_CONFIRM`).

## Objetivo

Al confirmar una cita pendiente, elegir el vendedor del slot con equilibrio por capacidad:

1. Menor carga relativa `totalCitas / ponderacionReuniones`
2. Empate → mayor `ponderacionReuniones` (1–5)
3. Empate → menor `totalCitas`
4. Empate → `vendedorId` estable

Así un vendedor con 5 estrellas no se queda con todas las reuniones: cuando su ratio sube, entran los de menor ponderación con menos citas.

## Fuente de datos

`GET /api/external/msg/disponibilidad` — cada ítem de `vendedores[]`:

```json
{
  "id": "...",
  "nombre": "...",
  "correo": "...",
  "ponderacionReuniones": 3,
  "totalCitas": 2,
  "citas": [],
  "disponibilidad": []
}
```

- `totalCitas` / `citas` usan el mismo `fechaInicio`–`fechaFin` de la query.
- Se reconsulta **al confirmar** (no snapshot al crear pendiente).
- Solo se usa `totalCitas` para ranking (no el detalle de `citas[]`).

## Componentes

| Pieza | Rol |
|-------|-----|
| `vendorRanking.js` | Normalización, índice panel, `rankVendorsForSlot`, comparación por ratio |
| `agendaConfirmService.js` | Antes de `crearReunion`, refresh por gerentes de candidatos → ranking → loop 409 igual |
| `tests/vendorRanking.test.js` | Ratio, empates, defaults, filtro de slot, fallback |

## Defaults y errores

| Caso | Comportamiento |
|------|----------------|
| Sin `ponderacionReuniones` | 1 |
| Sin `totalCitas` | 0 |
| Fuera de rango | Clamp 1–5 / ≥ 0 |
| Refresh falla (todos los gerentes) | Orden original de candidatos |
| Vendedor sin ese slot en refresh | Excluido del ranking |
| Sin dato de un gerente parcial | Candidato con defaults; no se excluye por slot |
| UI / lead / POST reuniones | Sin cambios |

## Fuera de alcance

- Autoasignación en UI de agendar
- Mostrar ponderación al lead
- Cambiar autenticación del panel
