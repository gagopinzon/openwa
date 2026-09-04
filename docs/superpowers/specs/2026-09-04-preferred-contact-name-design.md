# Preferred contact name (CV) for AI replies

## Problem

La auto-respuesta IA a veces saluda con el nombre de WhatsApp (`pushName` / `notifyName`), no con el `nombre` del CV usado en el pitch frío.

## Decision

- Fuente de verdad: `preferredName` guardado al enviar el pitch (nombre del CV).
- Nunca usar nombre de WhatsApp para dirigirse al lead.
- Sin `preferredName` ni nombre de CV ligado: responder de forma genérica (sin nombre).

## Data

- Campo Mongo `contact_history.preferredName` (string).
- Se escribe en `recordSuccessfulContact` y `linkCvToContact` cuando hay nombre de CV.
- No se escribe ni se pisa desde enroll inbound / pushName.
- `getContactSession` expone `preferredName` (+ `lastOutboundAt` para legado).

## Resolution (AI)

Orden:

1. `preferredName`
2. `leadCv.nombre`
3. legado: `name` solo si el contacto tiene `cvId` o `lastOutboundAt` (hubo outreach)
4. `null` → plantillas/prompt sin nombre

## Out of scope

- UI del panel / inbox (pueden seguir mostrando pushName).
- Migración masiva de Mongo; el legado cubre contactos con outreach previo.
