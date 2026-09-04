# Garantía vínculo prospecto ↔ CV

**Fecha:** 2026-09-04  
**Estado:** aprobado e implementado (2026-09-04)  
**Contexto:** Tras enviar, la mesa se vacía y parece que “se pierden” los CVs. El archivo permanente ya existe, pero el operador necesita la **garantía** de que si un prospecto contesta en N días, el sistema sigue resolviendo el mismo PDF sin pedirlo de nuevo. Sin UI de biblioteca/búsqueda.

## Objetivo

Tras un envío **exitoso**, persistir de forma durable la relación:

`teléfono del prospecto → cvId (PDF en disco)`

de modo que, aunque la mesa esté vacía, al contestar el lead (p. ej. 5 días después) `resolveUsableCvId` / agenda encuentren el CV y la IA **no pida** el PDF otra vez.

## No objetivos

- UI de archivo / buscar CV / reabrir en mesa.
- Atajos de cola “+3 horas” (fuera de este spec).
- Migrar PDFs a Mongo.

## Modelo

| Capa | Rol | Caducidad |
|------|-----|-----------|
| `data/cv-files/{cvId}.*` | Binario del CV | Permanente |
| `data/cvs-manifest.json` | Metadatos + **teléfono canónico** por `cvId` | Permanente (mesa = solo `inWorkspace`) |
| Mongo `contact_history.cvId` | Vínculo rápido sesión/inbound | Permanente mientras exista el contacto |

La **fuente de verdad del PDF** es el disco. Mongo acelera el lookup por teléfono/`lid_` pero no sustituye el manifesto.

## Comportamiento

### 1. Al enviar con éxito → `bindProspectCvLink`

Por cada mensaje enviado OK con `cvId` y teléfono usable:

1. Actualizar (o confirmar) en el manifesto: `telefono`, `nombre` opcional, `procesado: true`; **no** borrar PDF; `inWorkspace` puede quedar `false` tras archivar mesa.
2. `recordSuccessfulContact` con `cvId` (+ `archivoOriginal`) si hay Mongo.
3. Log: `prospect-cv-link bound phone=… cvId=…`
4. Si el envío OK **no** trae `cvId` o el PDF no está en disco → log de error claro (`unbound` / `missing_pdf`); no inventar vínculo.

### 2. Limpiar mesa / archivar enviados

Sin cambio de contrato: solo `inWorkspace: false`. El vínculo teléfono↔cvId en manifesto **permanece**.

### 3. Al contestar (inbound)

Cadena existente (`contactSession.cvId` → `leadCv` → archivo por teléfono/nombre) se mantiene.  
Si hay vínculo usable → política vigente: **nunca pedir CV**.  
Si Mongo apunta a `cvId` stale sin PDF → caer al archivo por teléfono (ya cubierto en tests).

### 4. Fallos visibles

No UI nueva. Logs estructurados bastan para operar:

- `bound` / `skipped_no_cvId` / `skipped_bad_phone` / `missing_pdf`

## Archivos

| Archivo | Cambio |
|---------|--------|
| `cvLookup.js` | `bindProspectCvLink` (+ helpers puros testeables) |
| `server.js` | Tras envío OK, llamar bind (disco + Mongo hook) |
| `tests/cvLookup.test.js` (o nuevo) | Bind actualiza manifesto; lookup tras `inWorkspace:false` |
| Tests de integración ligeros del hook si aplica | Filas sin cvId no corrompen manifesto |

## Criterios de aceptación

1. Enviar OK con `cvId` + teléfono → manifesto tiene ese teléfono en esa entrada; `lookupCvIdFromArchive(phone)` lo encuentra con mesa vacía.
2. Simular “5 días después”: solo archivo (`inWorkspace: false`) + opcional Mongo `cvId` → `resolveUsableCvId` retorna el mismo id.
3. Envío OK sin `cvId` → no escribe basura; log `skipped_no_cvId`.
4. PDF ausente → no marca bound; log `missing_pdf`.
5. Suite existente + nuevos tests en verde.

## Riesgos

- Teléfono mal parseado en el CV original → vínculo a número incorrecto; mitigación: usar el `telefono` del contacto **enviado** (ya editado en cliente), no re-extraer del PDF.
- Sin Mongo: el manifesto en disco sigue siendo suficiente; documentar que borrar `data/` rompe la garantía.
