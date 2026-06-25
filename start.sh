#!/bin/bash

echo "🚀 Iniciando Sistema de Análisis de CVs..."

# Verificar si el puerto 3445 está ocupado
if lsof -Pi :3445 -sTCP:LISTEN -t >/dev/null ; then
    echo "⚠️  El puerto 3445 está ocupado. Deteniendo procesos..."
    ./stop.sh
    sleep 2
fi

# Verificar que existe el archivo .env
if [ ! -f .env ]; then
    echo "❌ Archivo .env no encontrado. Creando uno de ejemplo..."
    echo "DEEPSEEK_API_KEY=tu_api_key_aqui
TEST_MODE=true
PORT=3445" > .env
    echo "✅ Archivo .env creado. Edítalo con tu API key real."
fi

echo "📋 Verificando configuración..."
if grep -q "tu_api_key_aqui" .env; then
    echo "⚠️  Recuerda configurar tu API key real de DeepSeek en el archivo .env"
fi

echo "🌐 Iniciando servidor..."
echo "📱 Interfaz disponible en: http://localhost:3445"
echo "🧪 Modo de prueba: $(grep TEST_MODE .env | cut -d'=' -f2)"

node server.js

