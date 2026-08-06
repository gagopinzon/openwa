# Diseño: búsqueda en Conversaciones

Fecha: 2026-08-06  
Estado: implementado

## Decisiones

- Búsqueda profunda vía OpenWA `GET /search` (opción C).
- UX: filtro local de la lista + panel “Mensajes encontrados” (opción C).
- Scope deep search: todas las sesiones configuradas a las que el usuario tiene acceso (opción B), independiente del selector de sesión.
- Caja única con debounce ~400ms.

## Comportamiento

1. Input filtra chats cargados por nombre, teléfono/chatId, preview y sesión.
2. Tras debounce (≥2 caracteres) → `GET /api/conversations/search?q=…`.
3. Hits clicables abren el chat (`openConversationChat`).
4. Si OpenWA responde 501 / sin provider → solo filtro local + aviso.
