# Diseño: Reuniones confirmadas visibles + reagendar automático (PATCH Panel)

Fecha: 2026-09-07  
Estado: aprobado (enfoque 1)

## Problema

Cuando un lead ya tiene reunión confirmada en Panel, Msg no la muestra de forma clara en Conversaciones ni permite moverla automáticamente. El lead pide otro horario y el sistema no hace `PATCH` al Panel ni prioriza al mismo vendedor.

## Decisiones

| Tema | Decisión |
|------|----------|
| Id de reunión | Ya llega del POST de alta y se guarda como `panelReunionId` |
| Persistencia | Seguir en `agenda-pending.json` (status `confirmed`); no Mongo duplicado |
| Visibilidad | **Ambas:** badge en cabecera del chat + lista de citas confirmadas |
| Reagendar | Automático: detectar horario → PATCH Panel → **WhatsApp solo desde Msg** |
| Sin cupo | Decir que no hay a esa hora y ofrecer alternativas |
| Vendedor | Preferir el mismo `vendedorId`; si no está libre en el slot, asignar otro |
| Enfoque | Extender store + `panelMsgClient` + rama en `autoReplyService` |

## Contexto existente

- `agendaPendingStore.confirmPending` guarda `panelReunionId`, `vendedorId`, `gerenteEmail`, `urlReunion`, fecha/hora
- `panelMsgClient.crearReunion` (POST); falta PATCH
- UI: panel «Citas por confirmar» solo lista `pending_link`
- Conversaciones: cabecera con badges de IA/bloqueado; sin cita

## API Panel (reagendar)

```
PATCH /api/external/msg/reuniones/{reunionId}
X-API-Key: …
X-Gerente-Email: gerente@…
Content-Type: application/json

{
  "fecha": "2026-09-08",
  "horaInicio": "15:00",
  "horaFin": "15:30",
  "vendedorId": "…"
}
```

Headers iguales a crear. `reunionId` = `panelReunionId` guardado.

## Flujo de reagendar (auto-reply)

1. Lead con cita `CONFIRMED` + `panelReunionId` pide mover / da nuevo día-hora.
2. Consultar slots agregados (misma disponibilidad que al agendar).
3. Si no hay slot a esa hora → respuesta fija + lista corta de alternativas (offer).
4. Si hay slot → candidatos del slot; orden: **mismo vendedor primero**, luego ranking habitual.
5. `actualizarReunion` (PATCH) con fecha/hora/`vendedorId` elegido.
6. Actualizar item local (fecha, horas, label, vendedorId, gerenteEmail si cambia; conservar `panelReunionId` / Meet si el panel no manda URL nueva).
7. Responder por WhatsApp con el nuevo horario (y Meet si aplica). **Msg es quien notifica**; no depender del WhatsApp del Panel.

Si falta `panelReunionId`: no inventar PATCH; avisar que un asesor debe moverla en Panel.

## Visibilidad

### Cabecera del chat

Si el contacto tiene cita confirmada: badge con fecha/hora (y link Meet si hay).

### Lista confirmadas

Sección o pestaña junto a «Citas por confirmar»: items `status=confirmed` con teléfono, horario, vendedor, `panelReunionId`, Meet.

`GET /api/agenda/pending?status=confirmed` (ya admite filtro; UI lo consume).

## Store

- `findConfirmedByPhone(telefono)` → última/única `CONFIRMED` activa del lead
- `updateConfirmedSchedule(id, { fecha, horaInicio, horaFin, label, vendedorId, gerenteEmail, urlReunion? })`
- No crear segundo pending al reagendar

## Fuera de alcance

- Borrador «Responder con IA» confirmable (otro spec)
- Cancelar reunión en Panel
- Migrar store a Mongo

## Criterios de éxito

1. Tras confirmar, la cita se ve en lista confirmadas y en el chat del lead.
2. Lead pide otro horario disponible → PATCH + mensaje de confirmación + store actualizado.
3. Horario sin cupo → mensaje + alternativas, sin PATCH.
4. Mismo vendedor si está libre; si no, otro del slot.
