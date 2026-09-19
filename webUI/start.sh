#!/usr/bin/env bash
#
# Spusti celou frezku jednim prikazem: nejdriv nanoComm (C++ demon), pak
# backend (Node). Poradi je dane - backend se pri startu pripojuje na TCP
# 5000 a 5001, ktere otevira az nanoComm. Kdyby sel prvni, spojeni by
# selhalo a job by se nedal poslat.
#
#   ./start.sh            spusti (a v pripade potreby prelozi) obe casti
#   ./start.sh --build    jen prelozi nanoComm a skonci
#   ./start.sh --check    jen overi prostredi, nic nespousti
#
set -euo pipefail

WEBUI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NANOCOMM_DIR="$WEBUI_DIR/nanoComm"
BACKEND_DIR="$WEBUI_DIR/backend"
BUILD_DIR="$NANOCOMM_DIR/build"

# Porty, na kterych to pobezi. 5000/5001 otevira nanoComm, 3300 backend.
NANO_PORT=5000
EMERGENCY_PORT=5001
WEB_PORT=3300

# Seriovy port Nana. Musi sedet s cestou v nanoComm/main.cpp - tady se jen
# kontroluje, jestli vubec existuje a jde na nej cist.
SERIAL_PORT="${CNC_SERIAL_PORT:-/dev/arduino0}"

NANOCOMM_PID=""


log()  { printf '[start] %s\n' "$*"; }
warn() { printf '[start] VAROVANI: %s\n' "$*" >&2; }
die()  { printf '[start] CHYBA: %s\n' "$*" >&2; exit 1; }


# --- prostredi -------------------------------------------------------------
# Cilova masina je Raspberry Pi s Raspberry Pi OS (Debian). Nazvy baliku nize
# jsou proto debianovske; na jinem systemu se jen vypisou jako voditko.
OS_ID="unknown"
OS_NAME="$(uname -s)"
ARCH="$(uname -m)"

if [ -r /etc/os-release ]; then
    OS_ID="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-unknown}")"
    OS_NAME="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-$(uname -s)}")"
fi

# Raspberry Pi OS se hlasi jako "debian", starsi jako "raspbian".
is_debian_like() {
    case "$OS_ID" in
        (debian|raspbian|ubuntu) return 0 ;;
    esac

    grep -qs 'ID_LIKE=.*debian' /etc/os-release
}


MISSING_PACKAGES=()


need_command() {
    local commandName="$1" debianPackage="$2"

    if command -v "$commandName" >/dev/null 2>&1; then
        return 0
    fi

    MISSING_PACKAGES+=("$debianPackage")
    return 1
}


# Hlavicka se neda hledat pres command -v, tak se zkusi opravdu prelozit.
# -fsyntax-only nic negeneruje, jde jen o to, jestli ji prekladac najde.
need_header() {
    local header="$1" debianPackage="$2"

    if printf '#include <%s>\nint main() { return 0; }\n' "$header" \
        | "${CXX:-c++}" -x c++ -std=c++20 -fsyntax-only - >/dev/null 2>&1; then
        return 0
    fi

    MISSING_PACKAGES+=("$debianPackage")
    return 1
}


report_missing() {
    if [ ${#MISSING_PACKAGES[@]} -eq 0 ]; then
        return 0
    fi

    warn "Chybi: ${MISSING_PACKAGES[*]}"

    if is_debian_like; then
        warn "Nainstaluj:  sudo apt install ${MISSING_PACKAGES[*]}"
    else
        warn "Nazvy baliku jsou debianovske, na $OS_ID hledej ekvivalenty."
    fi

    return 1
}


platform_notes() {
    log "System: $OS_NAME ($ARCH)"

    case "$ARCH" in
        armv7l|armv6l)
            warn "32bitovy ARM: npm balik sqlite3 pro nej nema hotovou binarku a preklada se ze zdroje."
            warn "Chce to python3 a build-essential a na Pi to trva i pres deset minut."
            ;;
    esac

    local memMB
    memMB="$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || echo 0)"

    if [ "$memMB" -gt 0 ] && [ "$memMB" -lt 700 ]; then
        warn "Jen ${memMB} MB RAM. main.cpp taha nlohmann/json, ktery je sablonove tezky, a preklad muze dojet na OOM."
        warn "Kdyz spadne, pridej swap: sudo dphys-swapfile swapoff; sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile; sudo dphys-swapfile setup; sudo dphys-swapfile swapon"
    fi
}


# Kdyz skonci tenhle script, musi skoncit i nanoComm. Bez toho by po Ctrl+C
# zustal viset na pozadi, drzel by porty 5000/5001 a dalsi spusteni by
# skoncilo na "Address already in use".
cleanup() {
    if [ -n "$NANOCOMM_PID" ] && kill -0 "$NANOCOMM_PID" 2>/dev/null; then
        log "Zastavuji nanoComm (PID $NANOCOMM_PID)"
        kill "$NANOCOMM_PID" 2>/dev/null || true
        wait "$NANOCOMM_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM


# CLion stavi do cmake-build-debug/, rucni build do build/. Bereme tu novejsi,
# aby se po rucnim prekladu nespustila stara binarka z IDE.
find_binary() {
    local newest=""
    local candidate

    for candidate in "$BUILD_DIR/nanoComm" "$NANOCOMM_DIR/cmake-build-debug/nanoComm"; do
        [ -x "$candidate" ] || continue

        if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then
            newest="$candidate"
        fi
    done

    printf '%s' "$newest"
}


# cmake_minimum_required v CMakeLists.txt je vys, nez co ma RPi OS bookworm
# (3.25). Radsi to rekneme rovnou nez nechat cmake vypsat svoji hlasku
# uprostred jineho vystupu.
check_cmake_version() {
    local required have
    required="$(grep -oE 'cmake_minimum_required\(VERSION[[:space:]]+[0-9.]+' "$NANOCOMM_DIR/CMakeLists.txt" \
                | grep -oE '[0-9.]+$' || true)"
    have="$(cmake --version | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' || true)"

    [ -n "$required" ] && [ -n "$have" ] || return 0

    if [ "$(printf '%s\n%s\n' "$required" "$have" | sort -V | head -1)" != "$required" ]; then
        warn "CMakeLists.txt chce cmake >= $required, k dispozici je $have."
        warn "Sniz cmake_minimum_required v $NANOCOMM_DIR/CMakeLists.txt, nic v nem novejsi cmake nepotrebuje."
    fi
}


# Co je potreba k prekladu. Kontroluje se drive, nez se pusti cmake, aby
# clovek dostal jednu srozumitelnou radku misto chyby uprostred prekladu.
check_build_deps() {
    MISSING_PACKAGES=()

    need_command c++ build-essential || true
    need_command cmake cmake || true

    # Hlavicku ma smysl hledat, az kdyz je cim prekladat.
    if command -v c++ >/dev/null 2>&1; then
        need_header nlohmann/json.hpp nlohmann-json3-dev || true
    fi

    report_missing
}


build_nanocomm() {
    platform_notes

    if ! check_build_deps; then
        die "Chybi neco k prekladu, viz radky vys."
    fi

    check_cmake_version

    log "Prekladam nanoComm do $BUILD_DIR"
    cmake -S "$NANOCOMM_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release

    # Bez -j zamerne: main.cpp je jedina prekladova jednotka, takze
    # paralelizace nic nezrychli, jen by na Pi zbytecne zvedla spotrebu pameti.
    cmake --build "$BUILD_DIR"
}


# Vrati 0, kdyz je potreba prelozit: binarka chybi, nebo je starsi nez zdrojak.
needs_build() {
    local binary
    binary="$(find_binary)"

    if [ -z "$binary" ]; then
        log "Binarka nanoComm nikde neni"
        return 0
    fi

    if [ "$NANOCOMM_DIR/main.cpp" -nt "$binary" ]; then
        log "main.cpp je novejsi nez $binary, prekladam znovu"
        return 0
    fi

    return 1
}


# Zjisti, jestli na portu nekdo posloucha, BEZ navazani spojeni. To je tady
# podstatne: nanoComm bere prvni prijate spojeni na 5000 jako backend, takze
# obycejny probe pres /dev/tcp by mu ten slot sebral, hned by videl EOF
# a prisel by o povelovy kanal jeste driv, nez se backend vubec pripoji.
port_is_listening() {
    if command -v ss >/dev/null 2>&1; then
        ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
        return
    fi

    # Zaloha bez iproute2: /proc/net/tcp ma port hexadecimalne a stav 0A =
    # LISTEN.
    local hex
    hex="$(printf '%04X' "$1")"
    grep -qiE "^[[:space:]]*[0-9]+: [0-9A-F]{8}:$hex [0-9A-F:]+ 0A " /proc/net/tcp /proc/net/tcp6 2>/dev/null
}


# Ceka, az nanoComm otevre svuj TCP port. Pevny sleep by byl bud zbytecne
# dlouhy, nebo na pomalejsim Pi kratky - tohle se prizpusobi.
wait_for_port() {
    local port="$1" attempt

    for attempt in $(seq 1 100); do
        port_is_listening "$port" && return 0

        if [ -n "$NANOCOMM_PID" ] && ! kill -0 "$NANOCOMM_PID" 2>/dev/null; then
            die "nanoComm skoncil driv, nez otevrel port $port. Bezi Nano na spravnem /dev? Vypis je vys."
        fi

        sleep 0.1
    done

    return 1
}


check_environment() {
    platform_notes

    MISSING_PACKAGES=()
    need_command node nodejs || true
    need_command npm npm || true
    need_command pcb2gcode pcb2gcode || true
    report_missing || true

    command -v node >/dev/null || die "node neni nainstalovany, bez nej backend nespustim"

    command -v pcb2gcode >/dev/null \
        || warn "pcb2gcode neni v PATH, generovani G-kodu z gerberu nepojede"

    [ -d "$BACKEND_DIR/node_modules" ] \
        || warn "chybi $BACKEND_DIR/node_modules, spust v $BACKEND_DIR prikaz 'npm install'"

    # Uzivatel musi byt v dialout, jinak nanoComm na seriovy port nedosahne.
    # Skupina se projevi az po odhlaseni, takze to je castá zaseknuta vec.
    if [ -e "$SERIAL_PORT" ] && [ ! -r "$SERIAL_PORT" ]; then
        warn "$SERIAL_PORT existuje, ale neni citelny. Chybi clenstvi ve skupine dialout?"
        warn "  sudo usermod -aG dialout $USER   a pak se odhlas a prihlas (nebo restartuj)"
    fi

    if [ ! -e "$SERIAL_PORT" ]; then
        warn "$SERIAL_PORT neexistuje - Nano neni pripojene, nebo se enumerovalo jinam."
        warn "  ls -l /dev/serial/by-id/   ukaze, co je opravdu pripojene"
    fi

    local port
    for port in "$NANO_PORT" "$EMERGENCY_PORT" "$WEB_PORT"; do
        if port_is_listening "$port"; then
            die "port $port uz nekdo drzi - bezi jina instance? (ss -ltnp | grep $port)"
        fi
    done
}


case "${1:-}" in
    --build)
        build_nanocomm
        log "Hotovo: $(find_binary)"
        exit 0
        ;;

    --check)
        check_environment
        needs_build && log "nanoComm je potreba prelozit (./start.sh --build)" \
                    || log "nanoComm je aktualni: $(find_binary)"
        log "Prostredi je v poradku"
        exit 0
        ;;

    "")
        ;;

    *)
        die "neznamy prepinac '$1' (pouzij --build, --check nebo nic)"
        ;;
esac


check_environment

if needs_build; then
    build_nanocomm
fi

NANOCOMM_BIN="$(find_binary)"
[ -n "$NANOCOMM_BIN" ] || die "preklad probehl, ale binarka nanoComm nikde neni"

log "Spoustim nanoComm: $NANOCOMM_BIN"
"$NANOCOMM_BIN" &
NANOCOMM_PID=$!

if ! wait_for_port "$NANO_PORT"; then
    die "nanoComm bezi (PID $NANOCOMM_PID), ale za 10 s neotevrel port $NANO_PORT"
fi

log "nanoComm posloucha na $NANO_PORT a $EMERGENCY_PORT (PID $NANOCOMM_PID)"
log "Spoustim backend, frontend bude na portu $WEB_PORT"

cd "$BACKEND_DIR"
node server.js
