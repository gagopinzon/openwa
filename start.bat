@echo off
REM Script de inicio para Windows

echo 🚀 Iniciando Sistema de Analisis de CVs...
echo.

REM Verificar si el puerto 3000 está ocupado
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    echo ⚠️  El puerto 3000 esta ocupado. Deteniendo procesos...
    call stop.bat
    timeout /t 2 /nobreak >nul
)

REM Verificar que existe el archivo .env
if not exist .env (
    echo ❌ Archivo .env no encontrado. Creando uno de ejemplo...
    (
        echo DEEPSEEK_API_KEY=tu_api_key_aqui
        echo TEST_MODE=true
        echo PORT=3000
    ) > .env
    echo ✅ Archivo .env creado. Editelo con su API key real.
    echo.
)

echo 📋 Verificando configuracion...
findstr /C:"tu_api_key_aqui" .env >nul 2>&1
if %errorlevel% equ 0 (
    echo ⚠️  Recuerda configurar tu API key real de DeepSeek en el archivo .env
    echo.
)

echo 🌐 Iniciando servidor...
echo 📱 Interfaz disponible en: http://localhost:3000
for /f "tokens=2 delims==" %%a in ('findstr /C:"TEST_MODE" .env') do (
    echo 🧪 Modo de prueba: %%a
)
echo.

node server.js
