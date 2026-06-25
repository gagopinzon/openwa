#!/bin/bash

echo "🛑 Deteniendo servidor en puerto 3445..."

# Matar procesos de node server.js
pkill -f "node server.js"

# Matar cualquier proceso en puerto 3445
fuser -k 3445/tcp 2>/dev/null

# Verificar si el puerto está libre
if lsof -Pi :3445 -sTCP:LISTEN -t >/dev/null ; then
    echo "❌ El puerto 3445 aún está en uso"
    echo "Procesos usando el puerto:"
    lsof -i :3445
else
    echo "✅ Puerto 3445 liberado correctamente"
fi

echo "🚀 Ahora puedes ejecutar: npm start"
