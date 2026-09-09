# Diseño: Bloqueo 45 min al vendedor / 15 min al lead

## Problema

Al agendar, el Panel bloqueaba ~30 min al vendedor; el cierre queda corto. Al lead se le comunica 15 minutos.

## Decisión

- **Vendedor / Panel:** bloquear **45 minutos** (`horaFin = horaInicio + 45`).
- **Lead:** comunicar **15 minutos**.
- **Ofertas:** seguir ofreciendo starts cada media hora (`10:00`, `10:30`…), solo si hay **45 min libres seguidos** del mismo vendedor.

## Comportamiento

1. Tras merge de disponibilidad, construir slots “bookable” de 45 min con candidatos que cubren el intervalo completo.
2. Holds (`pending_link`) y filtros usan **solape de intervalos**, no solo clave exacta.
3. `crearReunion` / reagendar / ranking usan el `horaFin` de 45 min; `vendorHasSlot` valida cobertura continua.
4. Textos IA / prompt de slots: “15 minutos”. Confirmación WhatsApp menciona ~15 min.

## Fuera de alcance

- Cambiar granularidad del Panel (`slotMinutos`).
- Buffer post-cita aparte del bloque al vendedor.
