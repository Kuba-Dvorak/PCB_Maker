#!/usr/bin/env bash
#
# Promaze stare logy z webUI/logs. nanoComm i backend rotuji po 15000 radcich
# a nic sami nemazou, takze bez tohohle by slozka rostla donekonecna - na SD
# karte v Raspberry to neni jedno.
#
#   ./cleanLogs.sh                 smaze logy starsi nez 7 dni
#   ./cleanLogs.sh --days 3        ... starsi nez 3 dny
#   ./cleanLogs.sh --keep 10       nechá 10 nejnovejsich od kazdeho druhu
#   ./cleanLogs.sh --all           smaze vsechny
#   ./cleanLogs.sh --dry-run       jen vypise, co by smazal, a skonci
#   ./cleanLogs.sh --all --force   smaze i ty, do kterych se prave pise
#
# Soubor, do ktereho se prave pise, se bez --force nemaze - viz FRESH_SECONDS
# nize. Smazat ho pod bezicim procesem neni tragedie (zapisuje dal do
# odpojeneho inodu), ale log by z nej zmizel a to je presne to, cemu se tu
# predchazi.
#
set -euo pipefail

LOGS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/logs"

# Druhy logu. Musi sedet s prefixy v nanoComm/main.cpp a backend/server.js.
PREFIXES=(nanoCommLog backendLog)

# Soubory mladsi nez tohle se povazuji za aktivni a preskakuji se.
FRESH_SECONDS=120

MODE="days"
DAYS=7
KEEP=10
DRY_RUN=0
FORCE=0


log()  { printf '[cleanLogs] %s\n' "$*"; }
die()  { printf '[cleanLogs] CHYBA: %s\n' "$*" >&2; exit 1; }


while [ $# -gt 0 ]; do
    case "$1" in
        --days)
            [ $# -ge 2 ] || die "--days chce cislo"
            MODE="days"; DAYS="$2"; shift 2
            ;;
        --keep)
            [ $# -ge 2 ] || die "--keep chce cislo"
            MODE="keep"; KEEP="$2"; shift 2
            ;;
        --all)
            MODE="all"; shift
            ;;
        --dry-run)
            DRY_RUN=1; shift
            ;;
        --force)
            FORCE=1; shift
            ;;
        -h|--help)
            # Napoveda je uvodni komentar souboru, at neexistuje dvakrat
            # a nerozejde se. Cte se do prvniho radku, ktery uz komentar neni.
            awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            die "neznamy prepinac '$1' (--days N, --keep N, --all, --dry-run, --force)"
            ;;
    esac
done

case "$MODE" in
    days) [[ "$DAYS" =~ ^[0-9]+$ ]] || die "--days chce cele cislo, ne '$DAYS'" ;;
    keep) [[ "$KEEP" =~ ^[0-9]+$ ]] || die "--keep chce cele cislo, ne '$KEEP'" ;;
esac

[ -d "$LOGS_DIR" ] || { log "Slozka $LOGS_DIR neexistuje, neni co mazat."; exit 0; }


now="$(date +%s)"
removed=0
skipped=0
freed=0


# Vrati 0, kdyz je soubor cerstvy, tedy nejspis prave otevreny nekterym
# z demonu. stat -c %Y je GNU, na Raspberry Pi OS i Archu k dispozici.
is_fresh() {
    local changed
    changed="$(stat -c %Y "$1" 2>/dev/null || echo 0)"
    [ $(( now - changed )) -lt "$FRESH_SECONDS" ]
}


remove_file() {
    local target="$1" size

    if [ "$FORCE" -eq 0 ] && is_fresh "$target"; then
        log "preskakuji (prave se do nej pise): $(basename "$target")"
        skipped=$(( skipped + 1 ))
        return
    fi

    size="$(stat -c %s "$target" 2>/dev/null || echo 0)"

    if [ "$DRY_RUN" -eq 1 ]; then
        log "smazal by: $(basename "$target") ($(( size / 1024 )) kB)"
    else
        rm -f -- "$target"
        log "smazano: $(basename "$target") ($(( size / 1024 )) kB)"
    fi

    removed=$(( removed + 1 ))
    freed=$(( freed + size ))
}


for prefix in "${PREFIXES[@]}"; do
    case "$MODE" in
        days)
            while IFS= read -r -d '' target; do
                remove_file "$target"
            done < <(find "$LOGS_DIR" -maxdepth 1 -type f -name "${prefix}-*.txt" -mtime "+$DAYS" -print0)
            ;;

        keep)
            # Nejnovejsi nahore, prvnich KEEP se preskoci, zbytek jde pryc.
            while IFS= read -r target; do
                [ -n "$target" ] || continue
                remove_file "$LOGS_DIR/$target"
            done < <(ls -1t "$LOGS_DIR" 2>/dev/null | grep -E "^${prefix}-.*\.txt$" | tail -n "+$(( KEEP + 1 ))")
            ;;

        all)
            while IFS= read -r -d '' target; do
                remove_file "$target"
            done < <(find "$LOGS_DIR" -maxdepth 1 -type f -name "${prefix}-*.txt" -print0)
            ;;
    esac
done


case "$MODE" in
    days) log "Rezim: starsi nez $DAYS dni" ;;
    keep) log "Rezim: nechat $KEEP nejnovejsich od kazdeho druhu" ;;
    all)  log "Rezim: vsechny" ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
    log "NANECISTO: smazalo by se $removed souboru, $(( freed / 1024 )) kB. Preskoceno aktivnich: $skipped."
else
    log "Smazano $removed souboru, uvolneno $(( freed / 1024 )) kB. Preskoceno aktivnich: $skipped."
fi

if [ "$skipped" -gt 0 ]; then
    log "Aktivni soubory zustaly. Kdyz je chces taky, pridej --force."
fi

log "Zbyva: $(find "$LOGS_DIR" -maxdepth 1 -type f -name '*.txt' | wc -l) souboru, celkem $(du -sk "$LOGS_DIR" 2>/dev/null | cut -f1) kB."
