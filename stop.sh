#!/bin/bash

echo "🛑 Deteniendo servidor en puerto 3000..."

# Matar procesos de node server.js
pkill -f "node server.js"

# Matar cualquier proceso en puerto 3000
fuser -k 3004/tcp 2>/dev/null

# Verificar si el puerto está libre
if lsof -Pi :3004 -sTCP:LISTEN -t >/dev/null ; then
    echo "❌ El puerto 3000 aún está en uso"
    echo "Procesos usando el puerto:"
    lsof -i :3004
else
    echo "✅ Puerto 3004 liberado correctamente"
fi

echo "🚀 Ahora puedes ejecutar: npm start"

