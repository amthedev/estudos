#!/usr/bin/env bash
# =====================================================================
# Foco de Elite — backup diário do PostgreSQL
#
# Instalação (como root):
#   sudo install -m 750 -o focoelite -g focoelite \
#        /opt/focoelite/app/docs/backup-db.sh /usr/local/bin/focoelite-backup
#   sudo install -d -o focoelite -g focoelite -m 750 /var/backups/focoelite
#
# Agendamento (crontab do usuário focoelite: `crontab -e -u focoelite`):
#   15 3 * * * /usr/local/bin/focoelite-backup >> /var/log/focoelite/backup.log 2>&1
#
# O script lê DATABASE_URL do .env da aplicação, gera um dump comprimido no
# formato custom do pg_dump, apaga os backups mais antigos que RETENTION_DAYS
# e devolve código diferente de zero se algo falhar (o cron avisa por e-mail).
# =====================================================================
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/focoelite/app}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/focoelite}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
fail() { log "ERRO: $*"; exit 1; }

command -v pg_dump >/dev/null 2>&1 || fail 'pg_dump não encontrado (instale postgresql-client-16).'
[ -f "$ENV_FILE" ] || fail "arquivo de ambiente não encontrado: $ENV_FILE"

# Lê apenas DATABASE_URL do .env, sem executar o arquivo.
DATABASE_URL="$(grep -E '^[[:space:]]*DATABASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d '=' -f 2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
[ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL não encontrada em $ENV_FILE"

mkdir -p "$BACKUP_DIR"
chmod 750 "$BACKUP_DIR"

STAMP="$(date '+%Y%m%d-%H%M%S')"
TARGET="$BACKUP_DIR/focoelite-$STAMP.dump"
TMP="$TARGET.part"

cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

log "iniciando backup em $TARGET"

# --format=custom permite restauração seletiva com pg_restore; --no-owner facilita
# restaurar em outro servidor, com outro dono de banco.
pg_dump --dbname="$DATABASE_URL" \
        --format=custom \
        --compress=6 \
        --no-owner \
        --no-privileges \
        --file="$TMP"

mv "$TMP" "$TARGET"
chmod 640 "$TARGET"

SIZE="$(du -h "$TARGET" | cut -f 1)"
log "backup concluído: $TARGET ($SIZE)"

# Um backup vazio quase sempre significa falha silenciosa.
MIN_BYTES=10240
ACTUAL_BYTES="$(wc -c < "$TARGET")"
[ "$ACTUAL_BYTES" -ge "$MIN_BYTES" ] || fail "backup suspeito: apenas $ACTUAL_BYTES bytes."

REMOVED="$(find "$BACKUP_DIR" -maxdepth 1 -name 'focoelite-*.dump' -type f -mtime "+$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')"
log "backups antigos removidos: $REMOVED (retenção de $RETENTION_DAYS dias)"

# Envio para fora do servidor — descomente e ajuste o destino.
# Um backup que mora no mesmo disco do banco não protege contra perda do servidor.
# rclone copy "$TARGET" "remoto:focoelite-backups/" --quiet

log "fim"
