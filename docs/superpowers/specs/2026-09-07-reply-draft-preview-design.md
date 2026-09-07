# Design: Borrador de auto-respuesta en Conversaciones

**Fecha:** 2026-09-07  
**Alcance:** Vista Conversaciones + auto-reply WhatsApp.

## Objetivo

Al llegar un mensaje del lead, generar ya el borrador de la IA, mostrarlo en el hilo durante la gracia (~30s / ~20s), permitir pausar ese envío, editarlo o mandarlo ya; si no hay intervención, enviar al vencer el timer. Si llega otro mensaje, regenerar y reiniciar gracia.

## Controles

| Acción | Efecto |
|--------|--------|
| Pausar envío | Congela el timer; borrador editable |
| Reanudar | Reprograma `sendAt` |
| Enviar ya | Manda el texto actual (sin esperar) |
| Editar texto | Actualiza borrador; se usa al enviar |
| Pausar IA (existente) | Cancela borrador + deja de auto-responder |

## Arquitectura

- `replyDraftStore.js` — borradores en memoria
- `replyDraftService.js` — cola, generación temprana, timer de envío
- `autoReplyService` — `draftOnly` / `preparedReply` en el procesador de lote
- APIs REST + SSE `replyDraftUpdated` / `replyDraftCleared`
- UI: panel sobre el composer del hilo

## Defaults

- Misma gracia que el batcher (`AUTO_REPLY_BATCH_FIRST_MS` / `NEXT_MS`)
- Documento/CV o `skip delays` → sin hold (envío inmediato como hoy)
