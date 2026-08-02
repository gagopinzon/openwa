# Diseño: IA ofrece horarios + citas pendientes (liga/confirmación)

Fecha: 2026-08-01  
Estado: aprobado e implementado (2026-08-01)

## Problema

La auto-respuesta IA ya conversa por WhatsApp, pero no consulta la disponibilidad real del panel. El lead pregunta por “mañana” y la IA no puede listar horarios libres ni dejar una cita en cola para que un humano asigne vendedor, pegue la liga Zoom/Meet y confirme al lead.

## Decisiones acordadas

| Tema | Decisión |
|------|----------|
| Alcance por fases | **Fase 1:** ofrecer horarios. **Fase 2:** pendientes + vendedor + liga + confirmación WhatsApp |
| Avisos | Lista global en Msg: **“Citas por confirmar”** (admin + usuarios con `control`) |
| Disponibilidad | Agregar **todos** los `gerenteEmail` de perfiles de usuarios + `MSG_GERENTE_EMAIL` |
| Presentación | Solo horarios libres, **sin nombres** de vendedor |
| Asignación | El gerente/humano elige vendedor y pega la liga al confirmar |
| CV | Del lead ya cargado en el masivo (`cvId` / historial); sin CV ligado → no auto-agenda |
| Enfoque técnico | IA con herramientas internas que llaman APIs de Msg/panel (enfoque 1) |

## Contexto existente

- `panelMsgClient.getDisponibilidad({ gerenteEmail, fechaInicio, fechaFin })`
- `panelMsgClient.crearReunion({ vendedorId, fecha, horaInicio, horaFin, urlReunion, cvUrl, … })`
- UI actual de agendar (modal) y calendario de disponibilidad
- Auto-respuesta: `autoReplyService` + DeepSeek + webhooks OpenWA

## Fase 1 — Ofrecer horarios (MVP conversacional)

### Comportamiento

1. Lead expresa intención de agendar o pide un día (“mañana”, “el jueves”, “esta semana”).
2. Backend agrega disponibilidad de todos los gerentes conocidos en Msg.
3. Normaliza a **slots únicos** por `fecha + horaInicio + horaFin` (timezone CDMX / la que ya use el panel).
4. La IA responde con una lista corta de horarios libres ese día (o el siguiente con huecos).
5. No crea reunión en el panel todavía; no pide nombres de vendedor.

### API interna

`GET /api/agenda/slots?fechaInicio=YYYY-MM-DD&fechaFin=YYYY-MM-DD`

Respuesta (conceptual):

```json
{
  "success": true,
  "slots": [
    {
      "fecha": "2026-08-02",
      "horaInicio": "10:00",
      "horaFin": "10:30",
      "label": "domingo 2 ago, 10:00"
    }
  ],
  "gerentesConsultados": 3,
  "erroresGerente": []
}
```

Por debajo (no exponer al lead) se puede cachear qué `(gerenteEmail, vendedorId)` cubren cada slot para Fase 2.

### Integración IA

- Extender el flujo de `generateReplyMessage` / `handleIncomingWebhook` con un paso previo opcional:
  - Detectar intención de agenda (heurística + instrucción en prompt / tool).
  - Si aplica, inyectar en el contexto del modelo los slots del día pedido (máx. N slots, p. ej. 8).
- Si no hay slots: “Ese día no tenemos hueco; el más cercano es …”
- Si no hay gerentes configurados / panel caído: no inventar horarios; pedir reintento o paso a humano.

### Fuera de Fase 1

- Crear pendientes, UI de confirmación, llamada a `crearReunion`, mensaje de confirmación al lead.

## Fase 2 — Pendientes, liga y confirmación

### Flujo

1. Lead elige un horario de los ofrecidos.
2. Msg crea **cita pendiente** (`status: pending_link`) con: teléfono/chatId, nombre, cvId/cvUrl, fecha/hora, sesión WhatsApp, mapa de vendedores candidatos del slot.
3. Aparece en **Citas por confirmar**.
4. Humano con `control`: elige vendedor (de candidatos o del equipo del gerente correspondiente) + pega `urlReunion` → **Confirmar**.
5. Msg llama `crearReunion` al panel y envía WhatsApp de confirmación al lead por la misma sesión.
6. `status: confirmed`.

### Modelo pendiente (Mongo preferible; fallback `data/agenda-pending.json` si hace falta)

| Campo | Descripción |
|-------|-------------|
| id | UUID |
| telefono / chatId / contactName | Lead |
| cvId / cvUrl | Del masivo |
| fecha, horaInicio, horaFin | Slot |
| logicalSessionId / openwaSessionId | Línea |
| candidateVendors | `[{ gerenteEmail, vendedorId, nombre? }]` |
| vendedorId / gerenteEmail / urlReunion | Tras confirmación |
| status | `pending_link` \| `confirmed` \| `cancelled` |
| createdAt / confirmedAt | Auditoría |
| panelReunionId | Si el panel lo devuelve |

### APIs

- `POST /api/agenda/pending` — crea pendiente (backend tras parsear elección del lead)
- `GET /api/agenda/pending` — lista para UI (filtrar por sesiones del usuario si no es super)
- `POST /api/agenda/pending/:id/confirm` — `{ vendedorId, urlReunion, gerenteEmail? }`
- `POST /api/agenda/pending/:id/cancel` — opcional

### UI

- Sección **Citas por confirmar** (visible si `control` o super).
- Contador de pendientes.
- Fila: lead, fecha/hora, línea, CV; acciones Confirmar / Cancelar.

### Mensaje de confirmación (plantilla)

Tras éxito en panel, enviar por OpenWA algo como:

> Listo, [nombre]. Tu sesión quedó el [fecha] a las [hora]. Liga: [url]. ¡Nos vemos!

## Recolección de gerentes

Fuente de emails únicos (lowercase, válidos):

1. `usersStore` → `gerenteEmail` de cada usuario
2. Super profile / `MSG_GERENTE_EMAIL`
3. (Opcional futuro) email por sesión — **no requerido en v1** tras decidir agregación global (A)

Si un gerente falla al consultar, se registra en `erroresGerente` y se continúa con el resto.

## Criterios de éxito

### Fase 1

1. Lead pide “mañana” y recibe horarios reales agregados (sin nombres).
2. Día sin huecos → ofrece alternativa cercana o lo dice explícitamente.
3. Sin inventar slots si el panel falla.

### Fase 2

4. Tras elegir horario, aparece pendiente en la lista.
5. Confirmar con vendedor + liga crea reunión en panel y WhatsApp al lead.
6. Usuarios solo ven/confirman según permisos de sesión (o todos si super).

## Fuera de alcance (v1)

- Cancelar/reprogramar por la propia IA
- Reasignar vendedor post-confirmación
- Nuevo endpoint en el panel “toda la empresa”
- Mostrar nombres de vendedores al lead

## Orden de implementación sugerido

1. `agendaAvailability` (agregar slots) + `GET /api/agenda/slots`
2. Inyectar slots en auto-respuesta (Fase 1)
3. Store de pendientes + APIs + UI “Citas por confirmar”
4. Parseo de elección del lead → `pending`
5. Confirm + `crearReunion` + WhatsApp

## Archivos probables

- `panelMsgClient.js` — sin cambio de contrato; posible helper de agregación
- `agendaAvailability.js` (nuevo) — merge de gerentes/slots
- `agendaPendingStore.js` (nuevo)
- `autoReplyService.js` / `aiService.js` — contexto de agenda
- `server.js` — rutas `/api/agenda/*`
- `public/index.html` + `public/app.js` — UI pendientes (Fase 2)
