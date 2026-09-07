#!/usr/bin/env bash
#
# Despliegue: preservar config local → git pull → restaurar prompts → npm → PM2
# Uso: ./deploy.sh
#
# Conserva en data/auto-reply-config.json tus textos editados en el panel
# (basePrompt, systemInstructions, etc.) aunque el pull traiga una versión nueva.
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

CONFIG_REL="data/auto-reply-config.json"
CONFIG_FILE="$ROOT/$CONFIG_REL"
BACKUP_DIR="$ROOT/data/.deploy-backups"
DID_STASH=0

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

if ! command -v node >/dev/null 2>&1; then
  fail "node no está instalado"
fi

if [[ ! -f "$ROOT/.env" ]]; then
  warn "No existe .env — copia .env.example y configura las variables antes de enviar mensajes reales"
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
CONFIG_BACKUP=""

# --- 1) Guardar config local (prompts del panel) ---
if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_BACKUP="$BACKUP_DIR/auto-reply-config.${STAMP}.json"
  cp "$CONFIG_FILE" "$CONFIG_BACKUP"
  ok "Backup de $CONFIG_REL → ${CONFIG_BACKUP#$ROOT/}"
else
  warn "No hay $CONFIG_REL todavía (se usará lo del repo tras el pull)"
fi

# --- 2) Stash de cambios locales que bloquearían el pull ---
step "Preparando git (stash si hay cambios locales)..."
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  STASH_NAME="deploy-stash-${STAMP}"
  if git stash push -u -m "$STASH_NAME"; then
    DID_STASH=1
    ok "Cambios locales guardados en stash: $STASH_NAME"
  else
    fail "No se pudo hacer git stash (revisa el estado del repo)"
  fi
else
  ok "Working tree limpio — no hace falta stash"
fi

# --- 3) Pull ---
step "Actualizando código (git pull)..."
if git pull --ff-only; then
  ok "Código actualizado"
else
  if [[ "$DID_STASH" -eq 1 ]]; then
    warn "Pull falló — restaurando stash…"
    git stash pop || true
  fi
  fail "git pull falló"
fi

# --- 4) Intentar recuperar el resto del stash (código local) ---
if [[ "$DID_STASH" -eq 1 ]]; then
  step "Reaplicando stash de otros cambios locales…"
  if git stash pop; then
    ok "Stash reaplicado"
  else
    warn "stash pop tuvo conflictos — revisa con: git status / git stash list"
  fi
fi

echo ""

# --- 5) Restaurar prompts locales ENCIMA de todo (pull + stash) ---
# Así un stash pop no pisa tu basePrompt / systemInstructions.
if [[ -n "$CONFIG_BACKUP" && -f "$CONFIG_BACKUP" ]]; then
  step "Reaplicando tus prompts locales sobre la config nueva…"
  if DEPLOY_CONFIG_BACKUP="$CONFIG_BACKUP" node <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const configPath = path.join(root, 'data', 'auto-reply-config.json');
const backupPath = process.env.DEPLOY_CONFIG_BACKUP;

const LOCAL_KEYS = [
  'basePrompt',
  'personaSystem',
  'systemInstructions',
  'cvPolicyWithCv',
  'cvPolicyWithoutCv',
  'rules',
  'enabled',
  'enabledSessionIds',
  'minDelayMs',
  'maxDelayMs',
  'webhookIdsBySession'
];

let remote = {};
if (fs.existsSync(configPath)) {
  remote = JSON.parse(fs.readFileSync(configPath, 'utf8'));
}
const local = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

const merged = { ...remote };
const applied = [];
for (const key of LOCAL_KEYS) {
  if (Object.prototype.hasOwnProperty.call(local, key) && local[key] !== undefined) {
    merged[key] = local[key];
    applied.push(key);
  }
}
if (remote.version != null) merged.version = remote.version;
else if (local.version != null) merged.version = local.version;

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
console.log('claves locales restauradas:', applied.join(', ') || '(ninguna)');
NODE
  then
    ok "Config local reaplicada (backup en ${CONFIG_BACKUP#$ROOT/})"
  else
    warn "No se pudo fusionar la config — queda la del repo; backup en ${CONFIG_BACKUP#$ROOT/}"
  fi
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
