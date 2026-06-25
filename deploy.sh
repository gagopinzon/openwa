#!/usr/bin/env bash
#
# Despliegue: git pull → npm install → PM2 startOrReload
# Uso: ./deploy.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

step() { echo -e "${BLUE}▶${NC} $1"; }
ok()   { echo -e "${GREEN}✅${NC} $1"; }
warn() { echo -e "${YELLOW}⚠️${NC} $1"; }
fail() { echo -e "${RED}❌${NC} $1"; exit 1; }

echo "🚀 Despliegue msg — $ROOT"
echo ""

if ! command -v git >/dev/null 2>&1; then
  fail "git no está instalado"
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm no está instalado"
fi

if ! command -v pm2 >/dev/null 2>&1; then
  fail "pm2 no está instalado (npm install -g pm2)"
fi

if [[ ! -f "$ROOT/.env" ]]; then
  warn "No existe .env — copia .env.example y configura las variables antes de enviar mensajes reales"
fi

step "Actualizando código (git pull)..."
if git pull --ff-only; then
  ok "Código actualizado"
else
  fail "git pull falló"
fi

echo ""

step "Instalando dependencias (npm install)..."
if npm install --omit=dev; then
  ok "Dependencias instaladas"
else
  fail "npm install falló"
fi

echo ""

step "Preparando carpeta de logs..."
mkdir -p "$ROOT/logs"
ok "logs/ listo"

echo ""

step "Reiniciando aplicación con PM2..."
if pm2 startOrReload "$ROOT/ecosystem.config.cjs"; then
  ok "PM2 startOrReload completado"
else
  fail "PM2 startOrReload falló"
fi

echo ""

step "Guardando lista de procesos PM2..."
if pm2 save; then
  ok "pm2 save completado"
else
  warn "pm2 save falló (puede no ser crítico)"
fi

echo ""
ok "Despliegue completado"
pm2 status msg 2>/dev/null || pm2 status
