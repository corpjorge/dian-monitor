#!/usr/bin/env bash
#
# Despliegue del monitor en Railway.
#
#   railway login          (una sola vez, abre el navegador)
#   ./scripts/railway-setup.sh
#
# Es idempotente: puedes volver a ejecutarlo para actualizar las variables o
# volver a desplegar. Lee los valores de .env y los sube a Railway; los
# secretos se pasan por stdin, así que nunca aparecen en la salida ni en el
# historial del shell.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT_NAME="${RAILWAY_PROJECT_NAME:-dian-monitor}"
SERVICE_NAME="${RAILWAY_SERVICE_NAME:-monitor}"
VOLUME_MOUNT="/app/data"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  ✓ %s\n' "$1"; }
warn(){ printf '  ! %s\n' "$1"; }

# ---------------------------------------------------------------- requisitos
command -v railway >/dev/null || {
  echo "Falta la CLI de Railway:  npm install -g @railway/cli"
  exit 1
}

if ! railway whoami >/dev/null 2>&1; then
  echo "No has iniciado sesión en Railway. Ejecuta primero:  railway login"
  exit 1
fi
ok "sesión de Railway: $(railway whoami 2>/dev/null | tail -1)"

[[ -f .env ]] || { echo "No existe .env (cópialo de .env.example)"; exit 1; }

# ------------------------------------------------------------------ proyecto
say "1. Proyecto y servicio"
if railway status >/dev/null 2>&1; then
  ok "ya hay un proyecto enlazado a esta carpeta"
else
  railway init --name "$PROJECT_NAME" >/dev/null
  ok "proyecto «$PROJECT_NAME» creado y enlazado"
fi

# Un proyecto recién creado no tiene servicios, y las variables cuelgan de uno.
if railway status 2>/dev/null | grep 'Linked service' >/dev/null; then
  ok "servicio ya enlazado"
else
  railway add --service "$SERVICE_NAME" >/dev/null
  ok "servicio «$SERVICE_NAME» creado y enlazado"
fi

# ------------------------------------------------------------------ variables
# Se envían todas las claves del .env excepto las vacías y las que sólo tienen
# sentido en local. HEADLESS se fuerza a true: en Railway no hay pantalla.
say "2. Variables de entorno"

SKIP_KEYS="HEADLESS|DRY_RUN|SCREENSHOT_DIR|STATE_FILE_PATH"
SECRET_KEYS="TELEGRAM_BOT_TOKEN|RESEND_API_KEY"
count=0

while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  [[ "$line" != *=* ]] && continue

  key="${line%%=*}"
  value="${line#*=}"
  key="$(printf '%s' "$key" | tr -d '[:space:]')"

  [[ -z "$value" ]] && continue
  [[ "$key" =~ ^($SKIP_KEYS)$ ]] && continue

  if [[ "$key" =~ ^($SECRET_KEYS)$ ]]; then
    # --stdin evita que el secreto quede en la línea de comandos.
    printf '%s' "$value" | railway variable set "$key" --stdin --skip-deploys >/dev/null
    ok "$key = (oculto)"
  else
    railway variable set "$key=$value" --skip-deploys >/dev/null
    ok "$key = $value"
  fi
  count=$((count + 1))
done < .env

railway variable set "HEADLESS=true" --skip-deploys >/dev/null
ok "HEADLESS = true (forzado: en Railway no hay pantalla)"
railway variable set "DRY_RUN=false" --skip-deploys >/dev/null
ok "DRY_RUN = false (forzado: en producción sí se envían las alertas)"
railway variable set "STATE_FILE_PATH=$VOLUME_MOUNT/state.json" --skip-deploys >/dev/null
ok "STATE_FILE_PATH = $VOLUME_MOUNT/state.json (dentro del volumen)"
printf '  %d variables enviadas\n' "$((count + 3))"

# -------------------------------------------------------------------- volumen
# El contador del resumen periódico vive en el estado: sin volumen se
# reiniciaría en cada ejecución y ese mensaje no llegaría nunca.
say "3. Volumen persistente"
if railway volume list 2>/dev/null | grep "$VOLUME_MOUNT" >/dev/null; then
  ok "ya existe un volumen en $VOLUME_MOUNT"
else
  if railway volume add --mount-path "$VOLUME_MOUNT" >/dev/null 2>&1; then
    ok "volumen creado en $VOLUME_MOUNT"
  else
    warn "no se pudo crear el volumen automáticamente."
    warn "Créalo en la interfaz (servicio → ⋮ → Add Volume, ruta $VOLUME_MOUNT)"
    warn "o pon HEARTBEAT_EVERY_RUNS=0 para desactivar el resumen periódico."
  fi
fi

# ------------------------------------------------------------------- despliegue
say "4. Despliegue"
railway up --detach --yes
ok "build lanzado"

say "Listo"
cat <<'EOF'
  Falta un paso manual (la CLI no expone el cron):
    Railway → tu servicio → Settings → Cron Schedule → */5 * * * *
    y comprueba que Restart Policy sea "Never".

  Ver los logs:        railway logs
  Ejecutar a mano:     Railway → Deployments → ⋮ → Redeploy
  Abrir el panel:      railway open
EOF
