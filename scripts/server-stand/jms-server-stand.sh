#!/usr/bin/env bash
# Sichert den Arbeitsstand des Server-Checkouts (~/intercom-system) stündlich als Zweig „server-stand“
# auf GitHub – auch Änderungen, die direkt auf dem Server gemacht und (noch) nicht committet wurden.
#
# Der Checkout selbst bleibt unberührt: kein Commit, kein Stash, kein Wechsel des Zweigs. Der Stand
# wird über einen eigenen, vorübergehenden Index gebaut (.gitignore gilt), als Commit an den Zweig
# „server-stand“ gehängt und nur hochgeladen, wenn sich etwas geändert hat.
#
# Das Repository ist ÖFFENTLICH. Vor jedem Hochladen werden alle Dateien, die von main abweichen,
# auf Geheimnisse geprüft (Schlüssel, Passwörter, Tokens, die Geheimnisse der laufenden Container,
# Schlüsseldateien). Bei einem Fund wird nichts hochgeladen; im Protokoll stehen nur die Dateinamen.
#
# Aufruf (systemd-Timer jms-server-stand.timer, als Benutzer master):
#   jms-server-stand.sh            sichern und hochladen
#   jms-server-stand.sh --dry-run  nur prüfen, nichts hochladen
#
# Hochladen braucht einen Deploy-Schlüssel mit Schreibrecht: ~/.ssh/jms-server-stand (siehe BETRIEB.md).

set -euo pipefail

REPO="${JMS_SERVER_STAND_REPO:-$HOME/intercom-system}"
BRANCH="${JMS_SERVER_STAND_BRANCH:-server-stand}"
REMOTE_URL="${JMS_SERVER_STAND_REMOTE:-git@github.com:Simon-Rohrer/intercom-system.git}"
KEY="${JMS_SERVER_STAND_KEY:-$HOME/.ssh/jms-server-stand}"
STATE_DIR="${JMS_SERVER_STAND_STATE:-$HOME/.local/state/jms-server-stand}"
MAX_FILE_BYTES=$((20 * 1024 * 1024))
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

mkdir -p "$STATE_DIR"
log() { echo "$(date '+%F %T') $*"; }
status() { printf '{"at":"%s","result":"%s","detail":%s}\n' "$(date -Iseconds)" "$1" "$(printf '%s' "${2:-}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" > "$STATE_DIR/status.json"; }

cd "$REPO"
git rev-parse --git-dir >/dev/null

# Stand des Arbeitsbaums in einen eigenen Index – der Index des Checkouts bleibt unangetastet
TMP_INDEX="$(mktemp "$STATE_DIR/index.XXXXXX")"
trap 'rm -f "$TMP_INDEX" "$STATE_DIR/blob"' EXIT
export GIT_INDEX_FILE="$TMP_INDEX"
git read-tree HEAD
git add -A
TREE="$(git write-tree)"
unset GIT_INDEX_FILE

HEAD_COMMIT="$(git rev-parse HEAD)"
PREV="$(git rev-parse -q --verify "refs/heads/$BRANCH" || true)"
if [[ -n "$PREV" && "$(git rev-parse "$PREV^{tree}")" == "$TREE" ]]; then
  log "Keine Änderung seit dem letzten Server-Stand ($PREV)"
  status unchanged "$PREV"
  exit 0
fi
if [[ -z "$PREV" && "$(git rev-parse "$HEAD_COMMIT^{tree}")" == "$TREE" ]]; then
  log "Arbeitsbaum entspricht HEAD – nichts zu sichern"
  status unchanged "$HEAD_COMMIT"
  exit 0
fi

# --- Prüfung auf Geheimnisse: alle Dateien, die vom Stand auf main abweichen --------------------
BASE="$(git rev-parse -q --verify origin/main || echo "$HEAD_COMMIT")"
mapfile -t CHANGED < <(git diff --name-only --diff-filter=ACMRT "$BASE" "$TREE")
FINDINGS=()

# Werte der Geheimnisse aus den laufenden Containern (nur zum Vergleichen, nie ausgeben)
mapfile -t LIVE_SECRETS < <(
  for c in multiview kesher; do
    docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true
  done | grep -E '^[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASS|KEY)[A-Z0-9_]*=' | cut -d= -f2- | awk 'length($0) >= 12' | sort -u
)

for f in "${CHANGED[@]}"; do
  [[ -z "$f" ]] && continue
  case "$f" in
    *.key|*.pem|*.p12|*.pfx|*id_rsa*|*id_ed25519*|*.env|*.env.*|*access-secret*|*secret*.json|*churchtools-secret*)
      FINDINGS+=("$f: Dateiname sieht nach Schlüssel/Geheimnis aus"); continue ;;
  esac
  size="$(git cat-file -s "$TREE:$f" 2>/dev/null || echo 0)"
  if (( size > MAX_FILE_BYTES )); then FINDINGS+=("$f: größer als 20 MB"); continue; fi
  BLOB="$STATE_DIR/blob"
  git cat-file -p "$TREE:$f" > "$BLOB" 2>/dev/null || : > "$BLOB"
  # -a: auch Binärdateien durchsuchen (ein Schlüssel kann z. B. in einem Archiv-Kopf stehen)
  if grep -qaE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
              -e '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}' \
              -e 'xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|tskey-[a-z]+-[A-Za-z0-9]{10,}' \
              -e '[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}' \
              "$BLOB"; then
    FINDINGS+=("$f: enthält einen Schlüssel oder Token"); continue
  fi
  if grep -qaiE '(secret|password|passwd|passwort|token|api[_-]?key)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9+/_=.-]{16,}["'"'"']' "$BLOB"; then
    FINDINGS+=("$f: enthält ein fest eingetragenes Passwort/Token"); continue
  fi
  for s in "${LIVE_SECRETS[@]}"; do
    if grep -qaF -- "$s" "$BLOB"; then FINDINGS+=("$f: enthält ein Geheimnis eines laufenden Containers"); break; fi
  done
done

if (( ${#FINDINGS[@]} )); then
  log "NICHT hochgeladen – mögliche Geheimnisse gefunden:"
  printf '  %s\n' "${FINDINGS[@]}"
  status blocked "$(printf '%s\n' "${FINDINGS[@]}")"
  exit 1
fi

# --- Commit an den Zweig hängen ---------------------------------------------------------------
PARENTS=()
[[ -n "$PREV" ]] && PARENTS+=(-p "$PREV")
# Neue Commits auf dem Server (HEAD) als zweite Herkunft, damit der Verlauf beide Wege zeigt
if [[ -z "$PREV" ]] || ! git merge-base --is-ancestor "$HEAD_COMMIT" "$PREV"; then PARENTS+=(-p "$HEAD_COMMIT"); fi

mapfile -t DIRTY < <(git diff --name-only "$HEAD_COMMIT" "$TREE")
MESSAGE="Server-Stand $(date '+%d.%m.%Y %H:%M') – ${#DIRTY[@]} Datei(en) nicht committet

Automatisch vom JMS-Server (scripts/server-stand). Basis: $(git log -1 --format='%h %s' "$HEAD_COMMIT")

$(printf -- '- %s\n' "${DIRTY[@]:0:60}")"
COMMIT="$(GIT_AUTHOR_NAME='JMS-Server' GIT_AUTHOR_EMAIL='master@jms-server' GIT_COMMITTER_NAME='JMS-Server' GIT_COMMITTER_EMAIL='master@jms-server' \
  git commit-tree "$TREE" "${PARENTS[@]}" -m "$MESSAGE")"

if (( DRY_RUN )); then
  log "Probelauf: neuer Server-Stand wäre $COMMIT (${#DIRTY[@]} Dateien) – nichts geändert, nichts hochgeladen"
  printf '  %s\n' "${DIRTY[@]:0:60}"
  exit 0
fi

if [[ ! -f "$KEY" ]]; then
  log "Kein Deploy-Schlüssel ($KEY) – Stand nur lokal gesichert"
  git update-ref "refs/heads/$BRANCH" "$COMMIT" ${PREV:+"$PREV"}
  status local "$COMMIT"
  exit 0
fi

# Erst lokal festhalten – geht das Hochladen schief, ist der Stand trotzdem gesichert und geht beim nächsten Mal mit
git update-ref "refs/heads/$BRANCH" "$COMMIT" ${PREV:+"$PREV"}
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes"
if git push --quiet "$REMOTE_URL" "refs/heads/$BRANCH:refs/heads/$BRANCH" 2>"$STATE_DIR/push.err"; then
  log "Server-Stand hochgeladen: $COMMIT (${#DIRTY[@]} Dateien) → $BRANCH"
  status pushed "$COMMIT"
else
  # Kein Fehlerstatus für systemd: die Störungsmeldung soll nicht jede Stunde anschlagen, solange z. B. der
  # Deploy-Key noch nicht eingetragen ist. Der Grund steht im Protokoll und in status.json.
  log "Hochladen fehlgeschlagen ($(tail -1 "$STATE_DIR/push.err")) – Stand lokal in $BRANCH gesichert"
  status failed "$(tail -1 "$STATE_DIR/push.err")"
fi
