# Design: Alinear Msg con API Panel (cvFile multipart)

**Fecha:** 2026-09-14  
**Estado:** implementado (2026-09-14)  
**Alcance:** Cliente Panel (`panelMsgClient`, `panelCvDelivery`) y callers de crear/reagendar reunión.

## Problema

La spec de panel (`POST /api/external/msg/reuniones`) ya admite **`cvFile` en `multipart/form-data` (máx. 10 MB)** como vía preferida. Msg todavía manda `cvUrl` o `cvBase64`. CVs grandes en local fallan con 413 si no hay URL pública; el body JSON tope es 2 MB.

## Decisiones

| Tema | Decisión |
|------|----------|
| Vía default | **`cvFile` multipart** si hay PDF local ≤ 10 MB |
| Escape >10 MB | **`cvUrl` JSON** solo si el archivo local supera 10 MB y hay `CV_PUBLIC_URL` alcanzable por el panel |
| `cvBase64` | **Eliminado.** No se envía en ningún camino |
| Sin archivo | `404` (no se inventa URL) |
| >10 MB sin URL pública | `413` |
| Meet | Msg **no** envía `urlReunion` al crear; usa la que devuelve el panel |
| Lead | Seguir mandando nombre/correo/tel/ciudad/estado si Msg ya los tiene (override de DeepSeek) |
| PATCH `vendedorId` | Opcional en el cliente. El reagendado automático **sigue enviándolo** cuando ya eligió vendedor |
| Cache disponibilidad | 90 s en `getDisponibilidad`; `skipCache: true` al confirmar y reagendar |
| Campos extra panel | No enviar `puestosAdicionales` / `estadoEmpleo` / `tieneMaestria` si no hay dato real |

## Flujo de delivery

```
PDF local ≤ 10 MB     → multipart cvFile
PDF local > 10 MB
  + URL pública OK    → JSON cvUrl
  + sin URL pública   → 413
Sin archivo en disco  → 404
```

OCC sigue descargando el CV completo **antes** de resolver delivery (mismo `ensureOccCvFetched` que hoy).

## Componentes

| Pieza | Cambio |
|-------|--------|
| `panelCvDelivery.js` | Devuelve `{ delivery: 'file', buffer, cvFileName, mime }` o `{ delivery: 'url', cvUrl }`. Quitar base64 y la preferencia URL-primero. |
| `panelMsgClient.crearReunion` | Si `cvFile` (Buffer): `FormData` nativo + `Blob`, **sin** `Content-Type: application/json` (axios pone el boundary). `analisisCV` como string JSON. `maxBodyLength` / `maxContentLength` ≥ 10 MB. Si `cvUrl`: JSON como hoy. |
| `panelMsgClient.actualizarReunion` | `vendedorId` opcional: si viene, se manda; si no, el panel conserva el actual. Siguen siendo obligatorios `fecha`, `horaInicio`, `horaFin`. |
| `panelMsgClient.getDisponibilidad` | Cache in-memory 90 s por `gerenteEmail + fechaInicio + fechaFin + slotMinutos`. `opts.skipCache` ignora y no escribe cache. |
| `agendaConfirmService.js` | Pasa `cvFile` / `cvFileName` al POST; ranking llama disponibilidad con `skipCache`. |
| `agendaRescheduleService.js` | PATCH con `vendedorId` elegido; disponibilidad con `skipCache`. |
| `server.js` | Los dos `crearReunion` (confirmar pendiente + agendar UI) usan el mismo delivery. |
| `.env.example` | Documentar: multipart preferido; `cvUrl` solo CVs >10 MB. |

## Multipart (campos)

Igual que la spec de panel:

- Archivo: `cvFile` (filename del PDF original / display name)
- Texto: `vendedorId`, `fecha`, `horaInicio`, `horaFin`, `titulo`, `origen`, `leadNombre`, `leadCorreo`, `leadTelefono`, `leadCiudad`, `leadEstado`, `cvAnalizadoEnMsg`
- JSON string: `analisisCV`, `leadExtraido` si aplican

Headers: `X-API-Key`, `X-Gerente-Email`. Timeout POST sigue en 150 s.

Límite: `PANEL_CV_MAX_FILE_BYTES = 10 * 1024 * 1024` (configurable por env si hace falta, default 10 MB).

## Cache disponibilidad

- TTL: **90 s** (mismo que la UI en `public/app.js`).
- Clave: gerente + rango + `slotMinutos`.
- Ofrecer horarios a la IA / calendario: puede usar cache.
- Confirmar reunión y reagendar: **siempre fresco** (`skipCache: true`).
- No persistir en disco.

## Fuera de alcance

- Cambiar ranking de vendedores o flujo conversacional de agenda.
- Cancelar reuniones en panel.
- Nuevo paquete `form-data` (usar `FormData` / `Blob` de Node).
- Seguir soportando `cvBase64`.

## Criterios de éxito

1. Auto-agenda y agendar en UI suben el PDF con `cvFile` si pesa ≤ 10 MB, aunque exista `CV_PUBLIC_URL`.
2. Un PDF >10 MB con URL pública firmada llega como `cvUrl`; sin URL, error 413 claro.
3. Ya no hay camino `cvBase64` (tests actuales de base64 se reescriben).
4. PATCH sin `vendedorId` no revienta en el cliente; el reagendado automático sigue mandando el id.
5. Confirmar/reagendar no usa disponibilidad cacheada.
6. Panel sigue recibiendo `cvAnalizadoEnMsg` + `analisisCV` + overrides de lead cuando Msg ya analizó.

## Tests

- `tests/panelCvDelivery.test.js`: file ≤10 MB → `file`; >10 MB + URL probe OK → `url`; >10 MB sin URL → 413; sin archivo → 404; no devolver `cvBase64`.
- Cliente crear reunión: mock de axios verifica `FormData` / ausencia de `Content-Type: application/json` en multipart.
- `getDisponibilidad`: segundo GET igual dentro de 90 s no llama axios; `skipCache` sí llama.
- `actualizarReunion`: payload sin `vendedorId` si se omite.
