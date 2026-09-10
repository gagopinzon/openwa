#!/usr/bin/env bash
#
# Despliegue: preservar config local → git pull → restaurar config → npm → PM2
# Uso: ./deploy.sh
#
# Conserva data/auto-reply-config.json (prompts + reglas por palabra clave del panel)
# aunque el pull o un stash toquen el working tree.
#
# Importante: el backup vive FUERA del repo ($HOME/.local/state/msg-openwa-backups)
# para que `git stash -u` no se lo lleve (bug que borraba las keywords al desplegar).
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
BACKUP_DIR_REPO="$ROOT/data/.deploy-backups"
# Fuera del work tree: stash -u no puede borrar esto
BACKUP_DIR_SAFE="${MSG_DEPLOY_BACKUP_DIR:-$HOME/.local/state/msg-openwa-backups}"
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

mkdir -p "$BACKUP_DIR_REPO" "$BACKUP_DIR_SAFE"
STAMP="$(date +%Y%m%d-%H%M%S)"
CONFIG_BACKUP_SAFE=""
CONFIG_BACKUP_REPO=""

count_rules() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "0"
    return
  fi
  node -e "
    try {
      const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const rules = Array.isArray(c.rules) ? c.rules : [];
      const kws = rules.reduce((n, r) => n + (Array.isArray(r.keywords) ? r.keywords.length : 0), 0);
      process.stdout.write(String(rules.length) + ' reglas / ' + String(kws) + ' keywords');
    } catch {
      process.stdout.write('?');
    }
  " "$file"
}

# --- 1) Guardar config local (prompts + keywords del panel) ---
if [[ -f "$CONFIG_FILE" ]]; then
  CONFIG_BACKUP_SAFE="$BACKUP_DIR_SAFE/auto-reply-config.${STAMP}.json"
  CONFIG_BACKUP_REPO="$BACKUP_DIR_REPO/auto-reply-config.${STAMP}.json"
  cp "$CONFIG_FILE" "$CONFIG_BACKUP_SAFE"
  cp "$CONFIG_FILE" "$CONFIG_BACKUP_REPO"
  # Copia “última conocida buena” siempre sobrescribible
  cp "$CONFIG_FILE" "$BACKUP_DIR_SAFE/auto-reply-config.latest.json"
  ok "Backup de $CONFIG_REL ($(count_rules "$CONFIG_FILE"))"
  ok "  → ${CONFIG_BACKUP_SAFE}"
  ok "  → ${CONFIG_BACKUP_REPO#$ROOT/}"
else
  if [[ -f "$BACKUP_DIR_SAFE/auto-reply-config.latest.json" ]]; then
    warn "No hay $CONFIG_REL — se restaurará el último backup bueno al final"
    CONFIG_BACKUP_SAFE="$BACKUP_DIR_SAFE/auto-reply-config.latest.json"
  else
    warn "No hay $CONFIG_REL ni backup previo (se usará defaults / lo del repo tras el pull)"
  fi
fi

# --- 2) Stash SOLO cambios trackeados (nunca -u: no tocar data/ ignorada) ---
step "Preparando git (stash de cambios trackeados si hace falta)..."
if [[ -n "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
  STASH_NAME="deploy-stash-${STAMP}"
  if git stash push -m "$STASH_NAME"; then
    DID_STASH=1
    ok "Cambios trackeados en stash: $STASH_NAME"
  else
    fail "No se pudo hacer git stash (revisa el estado del repo)"
  fi
else
  ok "Sin cambios trackeados que bloqueen el pull (data/ ignorada se deja en disco)"
fi

# Verificar que la config no desapareció por el stash
if [[ -n "$CONFIG_BACKUP_SAFE" && -f "$CONFIG_BACKUP_SAFE" && ! -f "$CONFIG_FILE" ]]; then
  warn "$CONFIG_REL faltaba tras el stash — restaurando desde backup seguro ya"
  mkdir -p "$(dirname "$CONFIG_FILE")"
  cp "$CONFIG_BACKUP_SAFE" "$CONFIG_FILE"
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

# --- 4) Intentar recuperar stash de código local ---
if [[ "$DID_STASH" -eq 1 ]]; then
  step "Reaplicando stash de cambios trackeados…"
  if git stash pop; then
    ok "Stash reaplicado"
  else
    warn "stash pop tuvo conflictos — revisa con: git status / git stash list"
  fi
fi

echo ""

# --- 5) Restaurar config local ENCIMA de todo ---
# Preferimos el backup FUERA del repo (no lo toca stash).
RESTORE_FROM=""
if [[ -n "$CONFIG_BACKUP_SAFE" && -f "$CONFIG_BACKUP_SAFE" ]]; then
  RESTORE_FROM="$CONFIG_BACKUP_SAFE"
elif [[ -f "$BACKUP_DIR_SAFE/auto-reply-config.latest.json" ]]; then
  RESTORE_FROM="$BACKUP_DIR_SAFE/auto-reply-config.latest.json"
  warn "Usando auto-reply-config.latest.json (backup más reciente)"
elif [[ -n "$CONFIG_BACKUP_REPO" && -f "$CONFIG_BACKUP_REPO" ]]; then
  RESTORE_FROM="$CONFIG_BACKUP_REPO"
fi

if [[ -n "$RESTORE_FROM" ]]; then
  step "Reaplicando tu config local (prompts + reglas por palabra clave)…"
  if DEPLOY_CONFIG_BACKUP="$RESTORE_FROM" node <<'NODE'
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
  try {
    remote = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    remote = {};
  }
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

const rules = Array.isArray(merged.rules) ? merged.rules : [];
const kws = rules.reduce((n, r) => n + (Array.isArray(r.keywords) ? r.keywords.length : 0), 0);
console.log('claves locales restauradas:', applied.join(', ') || '(ninguna)');
console.log('reglas activas:', rules.length, '/ keywords:', kws);
NODE
  then
    ok "Config local reaplicada ($(count_rules "$CONFIG_FILE"))"
    ok "Backup seguro: $RESTORE_FROM"
  else
    warn "Merge falló — copiando backup completo encima"
    mkdir -p "$(dirname "$CONFIG_FILE")"
    cp "$RESTORE_FROM" "$CONFIG_FILE"
    ok "Config restaurada por copia directa ($(count_rules "$CONFIG_FILE"))"
  fi
else
  warn "Sin backup para restaurar — $CONFIG_REL queda como esté tras el pull"
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
ok "Despliegue completado — $CONFIG_REL: $(count_rules "$CONFIG_FILE")"
echo "   Backups: $BACKUP_DIR_SAFE"
pm2 status msg 2>/dev/null || pm2 status
