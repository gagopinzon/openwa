@echo off
REM Script de detención para Windows

echo 🛑 Deteniendo servidor en puerto 3000...
echo.

REM Matar procesos de node server.js
taskkill /F /IM node.exe /FI "WINDOWTITLE eq *server.js*" >nul 2>&1
for /f "tokens=2" %%a in ('tasklist ^| findstr /I "node.exe"') do (
    wmic process where "name='node.exe' and commandline like '%%server.js%%'" delete >nul 2>&1
)

REM Matar cualquier proceso en puerto 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
    echo Deteniendo proceso %%a en puerto 3000...
    taskkill /F /PID %%a >nul 2>&1
)

REM Matar cualquier proceso en puerto 3004 (por si acaso)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3004 ^| findstr LISTENING') do (
    echo Deteniendo proceso %%a en puerto 3004...
    taskkill /F /PID %%a >nul 2>&1
)

REM Verificar si el puerto está libre
netstat -aon | findstr :3000 | findstr LISTENING >nul 2>&1
if %errorlevel% equ 0 (
    echo ❌ El puerto 3000 aun esta en uso
    echo Procesos usando el puerto:
    netstat -aon | findstr :3000
) else (
    echo ✅ Puerto 3000 liberado correctamente
)

echo.
echo 🚀 Ahora puedes ejecutar: npm start
echo.
