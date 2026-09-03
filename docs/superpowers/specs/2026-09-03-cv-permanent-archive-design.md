# Archivo permanente de CVs

**Fecha:** 2026-09-03  
**Estado:** pendiente de revisión  
**Contexto:** Tras “Cargar CVs” → generar mensajes → enviar, al agendar la IA pedía el CV otra vez porque el PDF ya no estaba en disco. Hoy el sistema **borra CVs a los 7 días** y, al re-subir el mismo teléfono, **elimina el PDF anterior**.

## Objetivo

Conservar **para siempre** todos los PDFs y metadatos necesarios para:

1. Que la auto-respuesta / agenda encuentre el CV del lead por teléfono o `cvId`.
2. Que “limpiar mesa” no borre archivos.
3. Que re-subir el mismo teléfono actualice el CV activo sin perder el PDF viejo.

## No objetivos (esta iteración)

- UI nueva de “biblioteca de CVs” o borrado manual.
- Migración a Mongo para el archivo de PDFs.
- Cambiar el TTL de tokens de URL pública firmada (sigue siendo corto; solo firma de descarga).

## Modelo mental

| Capa | Qué es | Persistencia |
|------|--------|--------------|
| **Mesa de trabajo** | CVs con `inWorkspace: true` (lote actual para editar / generar / enviar) | Se vacía al limpiar o al archivar enviados |
| **Archivo activo** | Entradas en `cvs-manifest.json` (una por teléfono usable; la más reciente gana) | **Sin caducidad** |
| **Historial de PDF** | PDFs reemplazados en `data/cv-files/history/` | **Sin caducidad**; no se usan en lookup salvo recuperación manual futura |

## Cambios de comportamiento

### 1. Sin purge por edad

- `purgeExpiredCvs` **deja de borrar** entradas del manifesto y PDFs por `savedAt`.
- Opciones de implementación (elegir la mínima):
  - `purgeExpiredCvs` = no-op que retorna `{ kept: cvs, expired: [] }`, o
  - quitar llamadas a `purgeExpiredArchive` / dejar de filtrar por `isCvExpired` en lookups.
- `isCvExpired` puede quedar para tests de compatibilidad, pero **no debe usarse** para excluir CVs del lookup ni del manifesto.
- Logs del tipo “Caducidad 7 días: N CVs borrados” desaparecen o se sustituyen por mensaje de archivo permanente.

### 2. Mesa vs archivo

- “Limpiar mesa” / archivar enviados: solo `inWorkspace: false`.
- Los PDFs en `data/cv-files/{cvId}.pdf` **permanecen**.
- `findCvForPhone` / `liveArchiveCvs` buscan en **todo** el manifesto con `procesado && cvId`, sin filtro de expiración.

### 3. Reemplazo por teléfono

Hoy `mergeIncomingBatch` reporta `replacedIds` y el caller hace `deleteCvFile(oldId)`.

Nuevo flujo:

1. Al reemplazar por mismo teléfono, el PDF viejo se **mueve** (o copia+unlink del path activo) a:
   `data/cv-files/history/{cvId}-{timestamp}.pdf`  
   (o `history/{cvId}.pdf` si no hay colisión).
2. **No** se llama a `deleteCvFile` para liberar espacio en el caso de reemplazo.
3. El manifesto queda con la entrada nueva (`cvId` nuevo); el id viejo ya no está en el manifesto activo, pero el binario sigue en `history/`.

### 4. Tokens públicos

- `TOKEN_TTL_SECONDS` (firma de `/api/public/cv/:cvId`) **no cambia**: la URL firmada sigue caducando; el archivo en disco no.
- Si hace falta otra descarga pública, se genera un token nuevo.

### 5. Disco y crecimiento

- El directorio `data/cv-files/` (y `history/`) crece sin límite automático.
- Fuera de alcance: UI de borrado, cuotas, o job de limpieza. Se documenta en README/comentario.

## Archivos tocados (previsto)

| Archivo | Cambio |
|---------|--------|
| `cvFileStore.js` | Desactivar purge destructivo; `retireCvFileToHistory(cvId)`; dejar de borrar en reemplazo |
| `server.js` | Dejar de `deleteCvFile` en `replacedIds`; ajustar `findCvForPhone` / logs / `purgeExpiredArchive` |
| `cvIngestService.js` | Mismo: no borrar PDF al reemplazar; retirar a history |
| `tests/cvFileStore.test.js` | TTL ya no implica borrado; tests de history + manifesto permanente |
| Posible: `README` / comentario en store | “CVs se conservan indefinidamente” |

## Criterios de aceptación

1. Subir un CV, esperar > 7 días (o simular `savedAt` antiguo) → el PDF y la entrada siguen; `findCvForPhone` lo encuentra.
2. “Limpiar mesa” → mesa vacía, manifesto + PDF intactos; agenda por teléfono sigue resolviendo el CV.
3. Re-subir el mismo teléfono → manifesto apunta al nuevo `cvId`; el PDF anterior existe bajo `cv-files/history/`.
4. Auto-reply con CV cargado: no pide el PDF por “archivo caducado”; el post-filtro de “no pedir CV” sigue vigente.
5. Suite de tests existente + nuevos casos de archivo permanente en verde.

## Riesgos

- **Disco:** crecimiento ilimitado; aceptar por decisión de producto (“para siempre”).
- **Manifesto grande:** JSON en disco; si escala a decenas de miles, valorar índice después (no ahora).
- **Tokens vs archivo:** operadores no deben confundir “URL firmada vencida” con “CV borrado”.

## Ejemplo de referencia

CV de muestra: `EMMANUEL MARTINEZ MARTINEZ` (`+525566567983`). Extracción actual correcta; el problema observado era retención, no parseo.
