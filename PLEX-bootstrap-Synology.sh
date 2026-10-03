#!/bin/sh
#
# PLEX-bootstrap-Synology.sh
# Version 8.5
# Interactive bootstrap for Synology DSM 7.x
# Plex + Radarr + Sonarr + Prowlarr + Decypharr + qBittorrent + Bazarr
#
# Goals:
#   - never assume NAS-specific paths;
#   - ask where stack.json, Plex libraries and Decypharr data are located;
#   - keep stack.json as the source of truth for configuration and secrets;
#   - support non-interactive execution through environment variables;
#   - remain safe to run again without deleting unknown stack.json keys.
#
# Environment variables available for non-interactive mode:
#   INTERACTIVE=0
#   NAS_IP=192.168.1.10
#   ARCH=avoton                  # optional, normally auto-detected from synoinfo.conf
#   STACK_DIR=/volumeX/PlexMediaServer
#   STACK_JSON=/volumeX/PlexMediaServer/stack.json
#   WATCHLIST_STATE=/volumeX/PlexMediaServer/watchlist-state.json
#   PLEX_DATA_ROOT=/volumeX/Media/Plex
#   PLEX_LIBRARY_ROOT=/volumeX/Media/Plex/media
#   MOVIES_ROOT=/volumeX/Media/Plex/media/Movies
#   SERIES_ROOT=/volumeX/Media/Plex/media/Series
#   DECYPHARR_ROOT=/volumeX/PlexMediaServer/decypharr
#   DECYPHARR_MOUNT=/volumeX/PlexMediaServer/decypharr/mount
#   DECYPHARR_DOWNLOADS=/volumeX/PlexMediaServer/decypharr/downloads
#   N8N_CONFIG_ROOT=/data/PlexMediaServer
#   N8N_MEDIA_ROOT=/data/media
#   DECYPHARR_APPDATA=/var/packages/decypharr/var
#   RADARR_PORT=7878 SONARR_PORT=8989 PLEX_PORT=32400 DECYPHARR_PORT=8282
#   RADARR_CATEGORY=radarr SONARR_CATEGORY=sonarr
#   INSTALL_PLEX=1 INSTALL_RADARR=1 INSTALL_SONARR=1 INSTALL_DECYPHARR=1
#   CONFIGURE_ARRS=1 INSTALL_BOOT_SYNC=1
#   DECYPHARR_SPK=/path/to/decypharr-....spk
#   ALLDEBRID_API_KEY=...   # only if stack.json does not exist or does not contain the key yet
#

set -u

SCRIPT_VERSION="8.5"
printf '\n[BOOT] PLEX Bootstrap Synology - v%s\n' "$SCRIPT_VERSION"
printf '[BOOT] Shell : %s\n' "${SHELL:-/bin/sh}"
printf '[BOOT] PID   : %s\n\n' "$$"

# Early integrity check: detect a truncated script before parsing the rest.
# DSM executes shell scripts progressively, so this check provides
# a readable error when a manual copy truncated the file.
if [ -f "$0" ]; then
    if ! tail -n 5 "$0" 2>/dev/null | grep -q '^# END-PLEX-BOOTSTRAP-SYNOLOGY-V8.5$'; then
        printf '[ERROR] The script is incomplete or truncated: %s\n' "$0" >&2
        printf '[ERROR] Do not copy it in chunks through vi/cat/heredoc.\n' >&2
        printf '[ERROR] Verify it with: wc -l "%s"\n' "$0" >&2
        exit 97
    fi
fi

ACLTOOL="/usr/syno/bin/synoacltool"
TMPBASE="${TMPDIR:-/tmp}/plex-bootstrap-synology"
CATALOG="$TMPBASE/catalog.json"
CATALOG_LINES="$TMPBASE/catalog.lines"
mkdir -p "$TMPBASE"

log()  { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

trim_trailing_slash() {
    value="$1"
    while [ "$value" != "/" ] && [ "${value%/}" != "$value" ]; do
        value="${value%/}"
    done
    printf '%s' "$value"
}

ask() {
    label="$1"
    default="$2"
    if [ "${INTERACTIVE:-1}" != "1" ]; then
        printf '%s' "$default"
        return 0
    fi
    if [ -n "$default" ]; then
        printf '%s [%s] : ' "$label" "$default" >&2
    else
        printf '%s : ' "$label" >&2
    fi
    IFS= read -r answer || answer=""
    [ -n "$answer" ] || answer="$default"
    printf '%s' "$answer"
}

ask_yes_no() {
    label="$1"
    default="$2"
    if [ "${INTERACTIVE:-1}" != "1" ]; then
        printf '%s' "$default"
        return 0
    fi
    if [ "$default" = "1" ]; then
        hint="Y/n"
    else
        hint="y/N"
    fi
    while :; do
        printf '%s [%s] : ' "$label" "$hint" >&2
        IFS= read -r answer || answer=""
        case "$answer" in
            "") printf '%s' "$default"; return 0 ;;
            o|O|oui|OUI|y|Y|yes|YES) printf '1'; return 0 ;;
            n|N|non|NON|no|NO) printf '0'; return 0 ;;
            *) printf 'Answer yes or no. Even a shell deserves usable input.\n' >&2 ;;
        esac
    done
}

ask_secret() {
    label="$1"
    if [ "${INTERACTIVE:-1}" != "1" ]; then
        printf '%s' "${ALLDEBRID_API_KEY:-}"
        return 0
    fi
    printf '%s : ' "$label" >&2
    old_stty="$(stty -g 2>/dev/null || true)"
    if [ -n "$old_stty" ]; then stty -echo 2>/dev/null || true; fi
    IFS= read -r answer || answer=""
    if [ -n "$old_stty" ]; then stty "$old_stty" 2>/dev/null || true; printf '\n' >&2; fi
    printf '%s' "$answer"
}

if [ "$(id -u)" -ne 0 ]; then
    err "Run this script as root: sudo -i"
    exit 1
fi

if [ ! -r /etc/VERSION ]; then
    err "/etc/VERSION is missing or unreadable."
    err "This script must run directly on Synology DSM, not on dockerini/n8n."
    exit 1
fi

command -v curl >/dev/null 2>&1 || {
    err "curl is required."
    exit 1
}

if [ ! -t 0 ] && [ -z "${INTERACTIVE+x}" ]; then
    INTERACTIVE=0
else
    INTERACTIVE="${INTERACTIVE:-1}"
fi

MODEL_RAW="$(cat /proc/sys/kernel/syno_hw_version 2>/dev/null || echo unknown)"
DSM_MAJOR="$(awk -F'\"' '/^majorversion=/{print $2}' /etc/VERSION 2>/dev/null || true)"
DSM_MINOR="$(awk -F'\"' '/^minorversion=/{print $2}' /etc/VERSION 2>/dev/null || true)"
DSM_MICRO="$(awk -F'\"' '/^micro=/{print $2}' /etc/VERSION 2>/dev/null || true)"
DSM_NANO="$(awk -F'\"' '/^nano=/{print $2}' /etc/VERSION 2>/dev/null || true)"
DSM_BUILD="$(awk -F'\"' '/^buildnumber=/{print $2}' /etc/VERSION 2>/dev/null || true)"
DSM_PRODUCT="$(awk -F'\"' '/^productversion=/{print $2}' /etc/VERSION 2>/dev/null || true)"
# The Synology package platform is not always visible in `uname -a`.
# The `unique` key is more reliable and follows the synology_<arch>_<model> format.
get_synology_unique() {
    unique=""

    if command -v synogetkeyvalue >/dev/null 2>&1; then
        unique="$(synogetkeyvalue /etc.defaults/synoinfo.conf unique 2>/dev/null || true)"
    fi

    if [ -z "$unique" ] && [ -x /bin/get_key_value ]; then
        unique="$(/bin/get_key_value /etc.defaults/synoinfo.conf unique 2>/dev/null || true)"
    fi

    if [ -z "$unique" ] && [ -r /etc.defaults/synoinfo.conf ]; then
        unique="$(sed -n 's/^unique=//p' /etc.defaults/synoinfo.conf | head -1 | tr -d "\"'")"
    fi

    if [ -z "$unique" ] && [ -r /etc/synoinfo.conf ]; then
        unique="$(sed -n 's/^unique=//p' /etc/synoinfo.conf | head -1 | tr -d "\"'")"
    fi

    printf '%s' "$unique"
}

SYNO_UNIQUE="$(get_synology_unique)"
DETECTED_ARCH="$(printf '%s' "$SYNO_UNIQUE" | sed -n 's/^synology_\([^_]*\)_.*/\1/p')"

if [ -z "$DETECTED_ARCH" ] && [ -r /proc/syno_platform ]; then
    DETECTED_ARCH="$(head -1 /proc/syno_platform 2>/dev/null | tr -d '[:space:]')"
fi

if [ -z "$DETECTED_ARCH" ]; then
    DETECTED_ARCH="$(uname -a 2>/dev/null | sed -n 's/.*synology_\([^_ ]*\)_.*/\1/p')"
fi

[ -n "$DSM_MAJOR" ] || DSM_MAJOR=7
[ -n "$DSM_MINOR" ] || DSM_MINOR=3
[ -n "$DSM_MICRO" ] || DSM_MICRO=0
[ -n "$DSM_NANO" ] || DSM_NANO=0

# ARCH can be supplied explicitly, which is useful on unusual or virtualized DSM systems.
ARCH="${ARCH:-$DETECTED_ARCH}"

DETECTED_IP="$(
    ip -4 addr show 2>/dev/null |
    awk '/inet / && $2 !~ /^127\./ && $2 !~ /^169\.254\./ {
        split($2,a,"/")
        print a[1]
        exit
    }'
)"
[ -n "$DETECTED_IP" ] || DETECTED_IP="127.0.0.1"

DEFAULT_VOLUME=""
for candidate in /volume[0-9]*; do
    if [ -d "$candidate" ]; then
        DEFAULT_VOLUME="$candidate"
        break
    fi
done
[ -n "$DEFAULT_VOLUME" ] || DEFAULT_VOLUME="/volume1"

# Plex creates a shared folder named PlexMediaServer on DSM.
# SynoPlex configuration/state always defaults to the Plex shared folder on
# the volume where it actually exists: /volumeX/PlexMediaServer.
# Explicit environment variables may still override this for advanced/manual
# deployments, but legacy VideoFactory paths are never auto-selected.
DEFAULT_PLEX_SHARED_ROOT=""
for candidate in /volume*/PlexMediaServer; do
    if [ -d "$candidate" ]; then
        DEFAULT_PLEX_SHARED_ROOT="$candidate"
        break
    fi
done
[ -n "$DEFAULT_PLEX_SHARED_ROOT" ] || DEFAULT_PLEX_SHARED_ROOT="$DEFAULT_VOLUME/PlexMediaServer"

DEFAULT_STACK_DIR="$DEFAULT_PLEX_SHARED_ROOT"
DEFAULT_PLEX_DATA_ROOT="$DEFAULT_VOLUME/Media/Plex"
DEFAULT_DECYPHARR_ROOT="$DEFAULT_PLEX_SHARED_ROOT/decypharr"

# Detect the actual ports used by existing *Arr packages.
# SynoCommunity normally stores config.xml under /var/packages/<pkg>/var,
# but keep an @appdata fallback for DSM variations.
find_arr_config() {
    pkg="$1"
    cfg=""

    if [ -d "/var/packages/$pkg/var" ]; then
        cfg="$(find "/var/packages/$pkg/var" -type f -name config.xml 2>/dev/null | head -1)"
    fi

    if [ -z "$cfg" ]; then
        for appdata in /volume*/@appdata/"$pkg"; do
            [ -d "$appdata" ] || continue
            cfg="$(find "$appdata" -type f -name config.xml 2>/dev/null | head -1)"
            [ -n "$cfg" ] && break
        done
    fi

    printf '%s' "$cfg"
}

detect_arr_port() {
    pkg="$1"
    fallback="$2"
    cfg="$(find_arr_config "$pkg")"

    if [ -n "$cfg" ] && [ -r "$cfg" ]; then
        port="$(sed -n 's:.*<Port>\([0-9][0-9]*\)</Port>.*:\1:p' "$cfg" | head -1)"
        case "$port" in
            ''|*[!0-9]*) ;;
            *) printf '%s' "$port"; return 0 ;;
        esac
    fi

    printf '%s' "$fallback"
}

DETECTED_RADARR_PORT="$(detect_arr_port radarr 7878)"
DETECTED_SONARR_PORT="$(detect_arr_port sonarr 8989)"
DETECTED_PROWLARR_PORT="$(detect_arr_port prowlarr 9696)"

detect_qbit_port() {
    fallback="$1"
    cfg=""

    for candidate in \
        /var/packages/qbittorrent/var/.config/qBittorrent/qBittorrent.conf \
        /var/packages/qbittorrent/var/config/qBittorrent/qBittorrent.conf \
        /volume*/@appdata/qbittorrent/.config/qBittorrent/qBittorrent.conf \
        /volume*/@appdata/qbittorrent/config/qBittorrent/qBittorrent.conf
    do
        [ -f "$candidate" ] || continue
        cfg="$candidate"
        break
    done

    if [ -n "$cfg" ]; then
        port="$(sed -n 's/^[[:space:]]*WebUI\\Port[[:space:]]*=[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$cfg" | head -1)"
        case "$port" in
            ''|*[!0-9]*) ;;
            *) printf '%s' "$port"; return 0 ;;
        esac
    fi

    printf '%s' "$fallback"
}

DETECTED_QBIT_PORT="$(detect_qbit_port 8095)"

printf '\n============================================================\n'
printf ' PLEX BOOTSTRAP SYNOLOGY : PLEX + ARR + DECYPHARR + QBIT + BAZARR\n'
printf '============================================================\n'
printf 'Detected NAS        : %s\n' "$MODEL_RAW"
printf 'DSM                : %s build %s\n' "${DSM_PRODUCT:-$DSM_MAJOR.$DSM_MINOR.$DSM_MICRO}" "${DSM_BUILD:-unknown}"
printf 'Unique identifier   : %s\n' "${SYNO_UNIQUE:-not detected}"
printf 'Architecture        : %s\n' "${ARCH:-not detected}"
printf 'Suggested volume    : %s\n' "$DEFAULT_VOLUME"
printf 'Plex config root    : %s\n' "$DEFAULT_PLEX_SHARED_ROOT"
printf '\nValues in brackets are defaults.\n'
printf 'Press Enter to keep them. Human progress occasionally survives defaults.\n\n'

NAS_IP="${NAS_IP:-$(ask "NAS IP/DNS used by Radarr/Sonarr" "$DETECTED_IP")}" 

if [ -z "${ARCH:-}" ]; then
    ARCH="$(ask "Synology architecture for SynoCommunity packages (e.g. avoton, apollolake, v1000)" "")"
fi

if [ -z "${ARCH:-}" ]; then
    warn "Synology architecture was not detected. The bootstrap will continue."
    warn "It will only be required if a SynoCommunity package actually needs to be installed."
fi

if [ -n "${STACK_JSON:-}" ]; then
    STACK_JSON="$(trim_trailing_slash "$STACK_JSON")"
    STACK_DIR="$(dirname "$STACK_JSON")"
else
    STACK_DIR="${STACK_DIR:-$(ask "SynoPlex configuration directory (/volumeX/PlexMediaServer)" "$DEFAULT_STACK_DIR")}" 
    STACK_DIR="$(trim_trailing_slash "$STACK_DIR")"
    STACK_JSON="$STACK_DIR/stack.json"
fi

WATCHLIST_STATE="${WATCHLIST_STATE:-$STACK_DIR/watchlist-state.json}"
WATCHLIST_STATE="$(trim_trailing_slash "$WATCHLIST_STATE")"

# Owner of stack.json.
# Prefer the current owner when it is not root, then SUDO_USER,
# otherwise root. The operator can always override this value.
DEFAULT_STACK_OWNER=""
if [ -f "$STACK_JSON" ]; then
    DEFAULT_STACK_OWNER="$(stat -c '%U' "$STACK_JSON" 2>/dev/null || true)"
    [ "$DEFAULT_STACK_OWNER" = "UNKNOWN" ] && DEFAULT_STACK_OWNER=""
    [ "$DEFAULT_STACK_OWNER" = "root" ] && DEFAULT_STACK_OWNER=""
fi

if [ -z "$DEFAULT_STACK_OWNER" ] && [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER:-}" != "root" ]; then
    DEFAULT_STACK_OWNER="$SUDO_USER"
fi

[ -n "$DEFAULT_STACK_OWNER" ] || DEFAULT_STACK_OWNER="root"

STACK_OWNER="${STACK_OWNER:-$(ask "DSM account owning stack.json (root = root-only access)" "$DEFAULT_STACK_OWNER")}"

if ! id "$STACK_OWNER" >/dev/null 2>&1; then
    err "DSM account not found for stack.json: $STACK_OWNER"
    exit 1
fi

STACK_GROUP="$(id -gn "$STACK_OWNER" 2>/dev/null || true)"
[ -n "$STACK_GROUP" ] || STACK_GROUP="users"

DEFAULT_N8N_STACK_READER=""

N8N_STACK_READER="${N8N_STACK_READER:-$(ask "DSM account used by n8n to read stack.json (empty = none)" "$DEFAULT_N8N_STACK_READER")}"
if [ -n "$N8N_STACK_READER" ] && ! id "$N8N_STACK_READER" >/dev/null 2>&1; then
    err "n8n DSM account not found: $N8N_STACK_READER"
    exit 1
fi

N8N_CONFIG_ROOT="${N8N_CONFIG_ROOT:-$(ask "n8n mount path for the PlexMediaServer share" "/data/PlexMediaServer")}"
N8N_CONFIG_ROOT="$(trim_trailing_slash "$N8N_CONFIG_ROOT")"
N8N_MEDIA_ROOT="${N8N_MEDIA_ROOT:-$(ask "n8n mount path for the media share/root" "/data/media")}"
N8N_MEDIA_ROOT="$(trim_trailing_slash "$N8N_MEDIA_ROOT")"

PLEX_DATA_ROOT="${PLEX_DATA_ROOT:-$(ask "Plex data root" "$DEFAULT_PLEX_DATA_ROOT")}" 
PLEX_DATA_ROOT="$(trim_trailing_slash "$PLEX_DATA_ROOT")"
PLEX_LIBRARY_ROOT="${PLEX_LIBRARY_ROOT:-$(ask "Plex library root" "$PLEX_DATA_ROOT/media")}" 
PLEX_LIBRARY_ROOT="$(trim_trailing_slash "$PLEX_LIBRARY_ROOT")"
MOVIES_ROOT="${MOVIES_ROOT:-$(ask "Movies library directory" "$PLEX_LIBRARY_ROOT/Movies")}" 
MOVIES_ROOT="$(trim_trailing_slash "$MOVIES_ROOT")"
SERIES_ROOT="${SERIES_ROOT:-$(ask "Series library directory" "$PLEX_LIBRARY_ROOT/Series")}" 
SERIES_ROOT="$(trim_trailing_slash "$SERIES_ROOT")"

DEFAULT_DECYPHARR_FROM_PLEX="$DEFAULT_DECYPHARR_ROOT"
DECYPHARR_ROOT="${DECYPHARR_ROOT:-$(ask "Decypharr data root" "$DEFAULT_DECYPHARR_FROM_PLEX")}" 
DECYPHARR_ROOT="$(trim_trailing_slash "$DECYPHARR_ROOT")"
DECYPHARR_MOUNT="${DECYPHARR_MOUNT:-$(ask "Decypharr virtual library mount point" "$DECYPHARR_ROOT/mount")}" 
DECYPHARR_MOUNT="$(trim_trailing_slash "$DECYPHARR_MOUNT")"
DECYPHARR_DOWNLOADS="${DECYPHARR_DOWNLOADS:-$(ask "Decypharr working/download directory" "$DECYPHARR_ROOT/downloads")}" 
DECYPHARR_DOWNLOADS="$(trim_trailing_slash "$DECYPHARR_DOWNLOADS")"

QBIT_DOWNLOADS="${QBIT_DOWNLOADS:-$(ask "qBittorrent download directory (fallback/manual)" "$PLEX_DATA_ROOT/downloads/qbittorrent")}" 
QBIT_DOWNLOADS="$(trim_trailing_slash "$QBIT_DOWNLOADS")"

DECYPHARR_APPDATA="${DECYPHARR_APPDATA:-$(ask "Decypharr package internal data" "/var/packages/decypharr/var")}" 
DECYPHARR_APPDATA="$(trim_trailing_slash "$DECYPHARR_APPDATA")"
DECYPHARR_CONFIG_DIR="$DECYPHARR_APPDATA/data"
DECYPHARR_CONFIG="$DECYPHARR_CONFIG_DIR/config.json"
DECYPHARR_CACHE_DIR="$DECYPHARR_APPDATA/cache/dfs"
DECYPHARR_SYNC="$DECYPHARR_APPDATA/sync_from_stack.py"
DECYPHARR_BOOT_SYNC="/usr/local/etc/rc.d/S99decypharr-stack-sync.sh"

PLEX_PORT="${PLEX_PORT:-$(ask "Plex port" "32400")}" 
RADARR_PORT="${RADARR_PORT:-$(ask "Radarr port" "$DETECTED_RADARR_PORT")}" 
SONARR_PORT="${SONARR_PORT:-$(ask "Sonarr port" "$DETECTED_SONARR_PORT")}" 
PROWLARR_PORT="${PROWLARR_PORT:-$(ask "Prowlarr port" "$DETECTED_PROWLARR_PORT")}" 
QBIT_PORT="${QBIT_PORT:-$(ask "qBittorrent port" "$DETECTED_QBIT_PORT")}" 
BAZARR_PORT="${BAZARR_PORT:-$(ask "Bazarr port" "6767")}" 
DECYPHARR_PORT="${DECYPHARR_PORT:-$(ask "Decypharr port" "8282")}" 
RADARR_CATEGORY="${RADARR_CATEGORY:-$(ask "Decypharr category used by Radarr" "radarr")}" 
SONARR_CATEGORY="${SONARR_CATEGORY:-$(ask "Decypharr category used by Sonarr" "sonarr")}" 

INSTALL_PLEX="${INSTALL_PLEX:-$(ask_yes_no "Install Plex if missing" "1")}" 
INSTALL_RADARR="${INSTALL_RADARR:-$(ask_yes_no "Install Radarr if missing" "1")}" 
INSTALL_SONARR="${INSTALL_SONARR:-$(ask_yes_no "Install Sonarr if missing" "1")}" 
INSTALL_PROWLARR="${INSTALL_PROWLARR:-$(ask_yes_no "Install Prowlarr if missing" "1")}" 
INSTALL_QBIT="${INSTALL_QBIT:-$(ask_yes_no "Install qBittorrent if missing" "1")}" 
INSTALL_BAZARR="${INSTALL_BAZARR:-$(ask_yes_no "Install Bazarr if missing" "1")}" 
INSTALL_DECYPHARR="${INSTALL_DECYPHARR:-$(ask_yes_no "Install Decypharr if missing" "1")}" 
CONFIGURE_ARRS="${CONFIGURE_ARRS:-$(ask_yes_no "Automatically configure Radarr/Sonarr to use Decypharr" "1")}" 
INSTALL_BOOT_SYNC="${INSTALL_BOOT_SYNC:-$(ask_yes_no "Resynchronize Decypharr from stack.json at every DSM boot" "1")}" 

validate_abs_path() {
    value="$1"
    label="$2"
    case "$value" in
        /*) return 0 ;;
        *) err "$label must be an absolute path: $value"; return 1 ;;
    esac
}

validate_port() {
    value="$1"
    label="$2"
    case "$value" in
        ''|*[!0-9]*) err "$label must be a number: $value"; return 1 ;;
    esac
    if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
        err "$label must be between 1 and 65535: $value"
        return 1
    fi
}

for path_item in \
    "$STACK_DIR|stack.json directory" \
    "$WATCHLIST_STATE|watchlist-state.json" \
    "$PLEX_DATA_ROOT|Plex root" \
    "$PLEX_LIBRARY_ROOT|Plex library" \
    "$MOVIES_ROOT|Movies library" \
    "$SERIES_ROOT|Series library" \
    "$DECYPHARR_ROOT|Decypharr root" \
    "$DECYPHARR_MOUNT|Montage Decypharr" \
    "$DECYPHARR_DOWNLOADS|Decypharr downloads" \
    "$QBIT_DOWNLOADS|qBittorrent downloads" \
    "$DECYPHARR_APPDATA|Appdata Decypharr" \
    "$N8N_CONFIG_ROOT|n8n PlexMediaServer mount" \
    "$N8N_MEDIA_ROOT|n8n media mount"
do
    value="${path_item%%|*}"
    label="${path_item#*|}"
    validate_abs_path "$value" "$label" || exit 1
done

validate_port "$PLEX_PORT" "Plex port" || exit 1
validate_port "$RADARR_PORT" "Radarr port" || exit 1
validate_port "$SONARR_PORT" "Sonarr port" || exit 1
validate_port "$PROWLARR_PORT" "Prowlarr port" || exit 1
validate_port "$QBIT_PORT" "qBittorrent port" || exit 1
validate_port "$BAZARR_PORT" "Bazarr port" || exit 1
validate_port "$DECYPHARR_PORT" "Decypharr port" || exit 1

[ -n "$RADARR_CATEGORY" ] || { err "Radarr category cannot be empty."; exit 1; }
[ -n "$SONARR_CATEGORY" ] || { err "Sonarr category cannot be empty."; exit 1; }

PORT_LIST="$PLEX_PORT $RADARR_PORT $SONARR_PORT $PROWLARR_PORT $QBIT_PORT $BAZARR_PORT $DECYPHARR_PORT"
for p1 in $PORT_LIST; do
    count=0
    for p2 in $PORT_LIST; do
        [ "$p1" = "$p2" ] && count=$((count + 1))
    done
    if [ "$count" -gt 1 ]; then
        err "Port $p1 is used by multiple services. Each service must use a unique port."
        exit 1
    fi
done

if [ "$INSTALL_DECYPHARR" != "1" ] && [ ! -d /var/packages/decypharr ]; then
    err "Decypharr is missing and its installation has been disabled."
    err "This stack requires Decypharr for AllDebrid integration."
    exit 1
fi

DECYPHARR_SPK="${DECYPHARR_SPK:-}"
if [ "$INSTALL_DECYPHARR" = "1" ] && [ ! -d /var/packages/decypharr ] && [ -z "$DECYPHARR_SPK" ]; then
    DECYPHARR_SPK="$(ask "Optional local Decypharr SPK (Enter = automatic search/GitHub release)" "")"
fi

CREATE_STACK=0
ALLDEBRID_API_KEY="${ALLDEBRID_API_KEY:-}"
if [ ! -f "$STACK_JSON" ]; then
    warn "stack.json n'existe pas encore : $STACK_JSON"
    if [ "$(ask_yes_no "Create a new stack.json at this location" "1")" = "1" ]; then
        CREATE_STACK=1
        if [ -z "$ALLDEBRID_API_KEY" ]; then
            ALLDEBRID_API_KEY="$(ask_secret "AllDebrid API key to store in the new stack.json")"
        fi
        if [ -z "$ALLDEBRID_API_KEY" ]; then
            err "An AllDebrid API key is required to initialize a new stack.json."
            exit 1
        fi
    else
        err "Installation cancelled: stack.json is required."
        exit 1
    fi
fi

printf '\n------------------ SELECTED CONFIGURATION -------------------\n'
printf 'NAS / access         : %s\n' "$NAS_IP"
printf 'stack.json           : %s\n' "$STACK_JSON"
printf 'watchlist-state.json : %s\n' "$WATCHLIST_STATE"
printf 'stack.json owner     : %s:%s (0600 + ACL)\n' "$STACK_OWNER" "$STACK_GROUP"
printf 'n8n stack reader     : %s\n' "${N8N_STACK_READER:-none}"
printf 'n8n config root      : %s\n' "$N8N_CONFIG_ROOT"
printf 'n8n media root       : %s\n' "$N8N_MEDIA_ROOT"
printf 'Plex data            : %s\n' "$PLEX_DATA_ROOT"
printf 'Plex library         : %s\n' "$PLEX_LIBRARY_ROOT"
printf 'Movies               : %s\n' "$MOVIES_ROOT"
printf 'Series               : %s\n' "$SERIES_ROOT"
printf 'Decypharr data       : %s\n' "$DECYPHARR_ROOT"
printf 'Decypharr mount      : %s\n' "$DECYPHARR_MOUNT"
printf 'Decypharr downloads  : %s\n' "$DECYPHARR_DOWNLOADS"
printf 'qBittorrent downloads: %s\n' "$QBIT_DOWNLOADS"
printf 'Decypharr appdata    : %s\n' "$DECYPHARR_APPDATA"
printf 'Ports                : Plex=%s Radarr=%s Sonarr=%s Prowlarr=%s qBit=%s Bazarr=%s Decypharr=%s\n' "$PLEX_PORT" "$RADARR_PORT" "$SONARR_PORT" "$PROWLARR_PORT" "$QBIT_PORT" "$BAZARR_PORT" "$DECYPHARR_PORT"
printf 'Categories           : Radarr=%s Sonarr=%s\n' "$RADARR_CATEGORY" "$SONARR_CATEGORY"
printf 'Installation         : Plex=%s Radarr=%s Sonarr=%s Prowlarr=%s qBit=%s Bazarr=%s Decypharr=%s\n' "$INSTALL_PLEX" "$INSTALL_RADARR" "$INSTALL_SONARR" "$INSTALL_PROWLARR" "$INSTALL_QBIT" "$INSTALL_BAZARR" "$INSTALL_DECYPHARR"
printf 'Auto-config *Arr     : %s\n' "$CONFIGURE_ARRS"
printf 'Boot sync            : %s\n' "$INSTALL_BOOT_SYNC"
printf '%s\n' '------------------------------------------------------------'

if [ "$INTERACTIVE" = "1" ]; then
    if [ "$(ask_yes_no "Start installation with this configuration" "1")" != "1" ]; then
        warn "Installation cancelled before any change."
        exit 0
    fi
fi

# Media paths can be prepared immediately. The PlexMediaServer shared folder
# is deliberately not created here: on a fresh NAS, let the Plex package create
# its DSM shared folder first.
mkdir -p "$PLEX_DATA_ROOT" "$PLEX_LIBRARY_ROOT" "$MOVIES_ROOT" "$SERIES_ROOT" "$QBIT_DOWNLOADS"
chmod 755 "$PLEX_DATA_ROOT" "$PLEX_LIBRARY_ROOT" "$MOVIES_ROOT" "$SERIES_ROOT" 2>/dev/null || true
chmod 775 "$QBIT_DOWNLOADS" 2>/dev/null || true
log "Media directory tree created/verified"

PLEXROOT="$PLEX_DATA_ROOT"
MEDIA_ROOT="$PLEX_DATA_ROOT"
LEGACY_DOWNLOADS="$PLEX_DATA_ROOT/downloads"
mkdir -p "$LEGACY_DOWNLOADS/radarr" "$LEGACY_DOWNLOADS/sonarr"

# ---------------------------------------------------------------------------
# SynoCommunity catalog, loaded only when an installation requires it
# ---------------------------------------------------------------------------

CATALOG_READY=0

ensure_catalog() {
    [ "$CATALOG_READY" = "1" ] && return 0

    if [ -z "${ARCH:-}" ]; then
        err "Unknown Synology architecture: unable to select a SynoCommunity SPK."
        err "Diagnostic utile : synogetkeyvalue /etc.defaults/synoinfo.conf unique"
        err "You can also rerun with ARCH=avoton (or the actual architecture of your NAS)."
        return 1
    fi

    if [ -z "${DSM_BUILD:-}" ]; then
        err "DSM build was not detected in /etc/VERSION."
        return 1
    fi

    CATALOG_URL="https://packages.synocommunity.com/?package_update_channel=stable&build=$DSM_BUILD&language=enu&major=$DSM_MAJOR&micro=$DSM_MICRO&arch=$ARCH&minor=$DSM_MINOR&nano=$DSM_NANO"

    info "Fetching SynoCommunity catalog for $ARCH / DSM $DSM_MAJOR.$DSM_MINOR build $DSM_BUILD..."
    if ! curl -fsSL --connect-timeout 15 --max-time 120 "$CATALOG_URL" -o "$CATALOG"; then
        err "Unable to fetch the SynoCommunity catalog."
        return 1
    fi

    if [ ! -s "$CATALOG" ] || ! grep -q '"packages"' "$CATALOG"; then
        err "Invalid SynoCommunity response."
        return 1
    fi

    sed 's/},[[:space:]]*{/}\
{/g' "$CATALOG" > "$CATALOG_LINES"
    CATALOG_READY=1
    log "SynoCommunity catalog loaded"
    return 0
}

catalog_line() {
    pkg="$1"
    grep "\"package\"[[:space:]]*:[[:space:]]*\"$pkg\"" "$CATALOG_LINES" | head -1
}

catalog_field() {
    pkg="$1"
    field="$2"
    line="$(catalog_line "$pkg")"
    [ -n "$line" ] || return 0

    printf '%s\n' "$line" |
        sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" |
        sed 's#\\/#/#g' |
        head -1
}

catalog_exists() {
    [ -n "$(catalog_line "$1")" ]
}

is_installed() {
    [ -d "/var/packages/$1" ]
}

INSTALLING=""
FAILED=""

install_pkg() {
    pkg="$1"
    label="${2:-$1}"

    if is_installed "$pkg"; then
        log "$label already installed"
        return 0
    fi

    ensure_catalog || return 1

    case " $INSTALLING " in
        *" $pkg "*) return 0 ;;
    esac

    if ! catalog_exists "$pkg"; then
        warn "$label ($pkg) is missing from the SynoCommunity catalog for $ARCH / DSM build $DSM_BUILD"
        return 1
    fi

    INSTALLING="$INSTALLING $pkg"

    deps="$(catalog_field "$pkg" deppkgs)"
    if [ -n "$deps" ]; then
        for rawdep in $(printf '%s' "$deps" | tr ':,;' '   '); do
            dep="$(printf '%s' "$rawdep" | sed 's/[<>=].*$//')"
            [ -n "$dep" ] || continue
            if catalog_exists "$dep"; then
                install_pkg "$dep" "$dep" || warn "Dependency not installed: $dep (required by $pkg)"
            fi
        done
    fi

    link="$(catalog_field "$pkg" link)"
    version="$(catalog_field "$pkg" version)"
    md5_expected="$(catalog_field "$pkg" md5)"
    spk="$TMPBASE/$pkg.spk"

    [ -n "$link" ] || {
        warn "Download link not found for $label"
        return 1
    }

    info "$label ${version:+($version)}: downloading"
    if ! curl -fL --connect-timeout 15 --max-time 900 "$link" -o "$spk"; then
        warn "Unable to download: $label"
        return 1
    fi

    if [ -n "$md5_expected" ] && command -v md5sum >/dev/null 2>&1; then
        md5_actual="$(md5sum "$spk" | awk '{print $1}')"
        if [ "$md5_actual" != "$md5_expected" ]; then
            warn "MD5 incorrect pour $label"
            rm -f "$spk"
            return 1
        fi
    fi

    info "$label: installing"
    synopkg install "$spk" >"$TMPBASE/install-$pkg.log" 2>&1 || true

    if is_installed "$pkg"; then
        log "$label installed"
        return 0
    fi

    warn "Installation failed: $label"
    tail -50 "$TMPBASE/install-$pkg.log" 2>/dev/null || true
    return 1
}

# ---------------------------------------------------------------------------
# Plex / Radarr / Sonarr
# ---------------------------------------------------------------------------

install_plex() {
    if is_installed PlexMediaServer; then
        log "Plex Media Server already installed"
        return 0
    fi

    [ "$INSTALL_PLEX" = "1" ] || return 1

    info "Attempting to install Plex Media Server from the DSM catalog..."
    synopkg install_from_server PlexMediaServer >"$TMPBASE/install-PlexMediaServer.log" 2>&1 || true

    if is_installed PlexMediaServer; then
        log "Plex Media Server installed"
        return 0
    fi

    warn "Plex could not be installed automatically by DSM."
    warn "Install the official Plex SPK from Package Center / Plex, then rerun the script."
    return 1
}

if [ "$INSTALL_PLEX" = "1" ] || is_installed PlexMediaServer; then
    install_plex || FAILED="$FAILED PlexMediaServer"
fi
if [ "$INSTALL_RADARR" = "1" ] || is_installed radarr; then
    install_pkg radarr "Radarr" || FAILED="$FAILED radarr"
fi
if [ "$INSTALL_SONARR" = "1" ] || is_installed sonarr; then
    install_pkg sonarr "Sonarr" || FAILED="$FAILED sonarr"
fi
if [ "$INSTALL_PROWLARR" = "1" ] || is_installed prowlarr; then
    install_pkg prowlarr "Prowlarr" || FAILED="$FAILED prowlarr"
fi
if [ "$INSTALL_QBIT" = "1" ] || is_installed qbittorrent; then
    install_pkg qbittorrent "qBittorrent" || FAILED="$FAILED qbittorrent"
fi
if [ "$INSTALL_BAZARR" = "1" ] || is_installed bazarr; then
    install_pkg bazarr "Bazarr" || FAILED="$FAILED bazarr"
fi

# Plex has now been installed/reused, so its PlexMediaServer shared folder may
# safely become the default home for SynoPlex state and Decypharr.
# Never fabricate the PlexMediaServer root as a plain directory: DSM/Plex owns
# creation of that shared folder.
if [ "$STACK_DIR" = "$DEFAULT_PLEX_SHARED_ROOT" ] && [ ! -d "$DEFAULT_PLEX_SHARED_ROOT" ]; then
    err "PlexMediaServer shared folder was not created by Plex: $DEFAULT_PLEX_SHARED_ROOT"
    err "Fix/install Plex first, or provide an explicit STACK_JSON path."
    exit 1
fi

mkdir -p "$STACK_DIR" "$DECYPHARR_ROOT" "$DECYPHARR_MOUNT" "$DECYPHARR_DOWNLOADS"
chmod 755 "$DECYPHARR_ROOT" "$DECYPHARR_MOUNT" 2>/dev/null || true
chmod 775 "$DECYPHARR_DOWNLOADS" 2>/dev/null || true
log "SynoPlex configuration root: $STACK_DIR"
log "SynoPlex state and Decypharr directories created/verified"

# Keep the Plex Watchlist state beside stack.json.
# Existing state is preserved verbatim.
if [ ! -f "$WATCHLIST_STATE" ]; then
    cat > "$WATCHLIST_STATE" <<'EOF_WATCHLIST_STATE'
{
  "version": 2,
  "initialized": false,
  "current": [],
  "pendingRemoved": []
}
EOF_WATCHLIST_STATE
    chown "$STACK_OWNER:$STACK_GROUP" "$WATCHLIST_STATE" 2>/dev/null || true
    chmod 600 "$WATCHLIST_STATE" 2>/dev/null || true
    log "Watchlist state initialized: $WATCHLIST_STATE"
else
    log "Watchlist state already exists: $WATCHLIST_STATE"
fi

# Python is used only to safely edit JSON. Even a NAS deserves better than sed on secrets.
find_python() {
    if command -v python3 >/dev/null 2>&1; then
        command -v python3
        return 0
    fi

    for p in \
        /var/packages/python*/target/bin/python3 \
        /var/packages/python*/target/bin/python3.* \
        /volume*/@appstore/python*/bin/python3 \
        /volume*/@appstore/python*/bin/python3.*
    do
        [ -x "$p" ] && {
            printf '%s' "$p"
            return 0
        }
    done
    return 1
}

PYTHON="$(find_python 2>/dev/null || true)"
if [ -z "$PYTHON" ]; then
    info "Python 3 is missing; installing the SynoCommunity runtime to edit stack.json safely..."
    install_pkg python312 "Python 3.12" || install_pkg python314 "Python 3.14" || true
    PYTHON="$(find_python 2>/dev/null || true)"
fi

if [ -z "$PYTHON" ]; then
    err "Python 3 was not found. Cannot safely merge stack.json and the Decypharr configuration."
    exit 1
fi
log "Python JSON : $PYTHON"

if [ "$CREATE_STACK" = "1" ] && [ ! -f "$STACK_JSON" ]; then
    export STACK_JSON ALLDEBRID_API_KEY
    "$PYTHON" <<'PYCREATESTACK'
import json, os, pathlib
p = pathlib.Path(os.environ["STACK_JSON"])
p.parent.mkdir(parents=True, exist_ok=True)
data = {"decypharr": {"alldebrid_api_key": os.environ["ALLDEBRID_API_KEY"]}}
with p.open("w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.chmod(p, 0o600)
PYCREATESTACK
    if [ $? -ne 0 ]; then
        err "Unable to create stack.json."
        exit 1
    fi
    chown "$STACK_OWNER:$STACK_GROUP" "$STACK_JSON" 2>/dev/null || true
    chmod 600 "$STACK_JSON" 2>/dev/null || true
    log "New stack.json created: $STACK_JSON"
fi

export STACK_JSON
HAS_ALLDEBRID="$($PYTHON - <<'PYCHECKSTACK'
import json, os
p=os.environ["STACK_JSON"]
try:
    d=json.load(open(p, encoding="utf-8"))
except Exception:
    print("INVALID"); raise SystemExit

def norm(v): return ''.join(c for c in str(v).lower() if c.isalnum())
def secret(o):
    if not isinstance(o,dict): return None
    for k,v in o.items():
        if norm(k) in {"apikey","token","key","secret","apitoken"} and isinstance(v,str) and v.strip(): return v.strip()

def walk(x):
    if isinstance(x,dict):
        ident=' '.join(str(x.get(k,'')) for k in ('provider','name','type','service'))
        if 'alldebrid' in norm(ident):
            s=secret(x)
            if s: return s
        for k,v in x.items():
            nk=norm(k)
            if nk in {"alldebridapikey","alldebridtoken","alldebridkey","alldebridapitoken"} and isinstance(v,str) and v.strip(): return v.strip()
            if 'alldebrid' in nk:
                s=secret(v)
                if s: return s
        for v in x.values():
            s=walk(v)
            if s: return s
    elif isinstance(x,list):
        for v in x:
            s=walk(v)
            if s: return s
    return None
print("1" if walk(d) else "0")
PYCHECKSTACK
)"

if [ "$HAS_ALLDEBRID" = "INVALID" ]; then
    err "stack.json existe mais n'est pas un JSON valide : $STACK_JSON"
    exit 1
fi

if [ "$HAS_ALLDEBRID" != "1" ]; then
    warn "No AllDebrid API key detected in $STACK_JSON"
    if [ -z "$ALLDEBRID_API_KEY" ]; then
        ALLDEBRID_API_KEY="$(ask_secret "AllDebrid API key to add to stack.json")"
    fi
    if [ -z "$ALLDEBRID_API_KEY" ]; then
        err "AllDebrid API key is missing: Decypharr cannot be configured."
        exit 1
    fi
    export ALLDEBRID_API_KEY
    "$PYTHON" <<'PYADDKEY'
import json, os, pathlib, stat, tempfile
p=pathlib.Path(os.environ["STACK_JSON"])
with p.open(encoding="utf-8") as f: data=json.load(f)
if not isinstance(data,dict): raise SystemExit("stack.json must contain a JSON object")
decy = data.get("decypharr")
if not isinstance(decy, dict):
    decy = {}
    data["decypharr"] = decy
decy["alldebrid_api_key"] = os.environ["ALLDEBRID_API_KEY"]
st=os.stat(p)
fd,tmp=tempfile.mkstemp(prefix='.stack.',dir=str(p.parent))
try:
    with os.fdopen(fd,'w',encoding='utf-8') as f:
        json.dump(data,f,indent=2,ensure_ascii=False); f.write('\n')
    os.chmod(tmp, stat.S_IMODE(st.st_mode) or 0o600)
    try: os.chown(tmp,st.st_uid,st.st_gid)
    except PermissionError: pass
    os.replace(tmp,p)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PYADDKEY
    if [ $? -ne 0 ]; then
        err "Unable to add the AllDebrid API key to stack.json."
        exit 1
    fi
    log "AllDebrid API key added to stack.json"
fi

# ---------------------------------------------------------------------------
# Native DSM Decypharr installation
# ---------------------------------------------------------------------------

install_local_decypharr_spk() {
    spk="$1"
    [ -f "$spk" ] || return 1
    info "Installing Decypharr from: $spk"
    synopkg install "$spk" >"$TMPBASE/install-decypharr.log" 2>&1 || true
    is_installed decypharr
}

install_decypharr() {
    if is_installed decypharr; then
        log "Decypharr already installed"
        return 0
    fi

    [ "$INSTALL_DECYPHARR" = "1" ] || return 1

    if [ -n "${DECYPHARR_SPK:-}" ]; then
        if install_local_decypharr_spk "$DECYPHARR_SPK"; then
            log "Decypharr installed from DECYPHARR_SPK"
            return 0
        fi
    fi

    # First look for an SPK already present on the NAS.
    for candidate in \
        "$PLEXROOT"/decypharr-*-dsm${DSM_MAJOR}.${DSM_MINOR}-${ARCH}.spk \
        "$STACK_DIR"/decypharr-*-dsm${DSM_MAJOR}.${DSM_MINOR}-${ARCH}.spk \
        /volume*/decypharr-*-dsm${DSM_MAJOR}.${DSM_MINOR}-${ARCH}.spk
    do
        [ -f "$candidate" ] || continue
        if install_local_decypharr_spk "$candidate"; then
            log "Decypharr installed from the local SPK"
            return 0
        fi
    done

    # Otherwise, try the latest GitHub release from the ESI69190/decypharr fork.
    release_json="$TMPBASE/decypharr-release.json"
    if curl -fsSL --connect-timeout 15 --max-time 60 \
        "https://api.github.com/repos/ESI69190/decypharr/releases/latest" \
        -o "$release_json"; then

        asset_url="$($PYTHON - "$release_json" "$ARCH" "$DSM_MAJOR.$DSM_MINOR" <<'PY'
import json, sys
p, arch, dsm = sys.argv[1:]
with open(p, encoding='utf-8') as f:
    data = json.load(f)
suffix = f"-dsm{dsm}-{arch}.spk"
for a in data.get("assets", []):
    name = str(a.get("name", ""))
    if name.endswith(suffix):
        print(a.get("browser_download_url", ""))
        break
PY
)"

        checksum_url="$($PYTHON - "$release_json" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    data = json.load(f)
for a in data.get("assets", []):
    if a.get("name") == "SHA256SUMS":
        print(a.get("browser_download_url", ""))
        break
PY
)"

        if [ -n "$asset_url" ]; then
            spk="$TMPBASE/$(basename "$asset_url")"
            info "Downloading Decypharr SPK: $(basename "$spk")"
            if curl -fL --connect-timeout 15 --max-time 900 "$asset_url" -o "$spk"; then
                if [ -n "$checksum_url" ] && command -v sha256sum >/dev/null 2>&1; then
                    checks="$TMPBASE/SHA256SUMS"
                    if curl -fsSL "$checksum_url" -o "$checks"; then
                        expected="$(awk -v n="$(basename "$spk")" '$2==n || $2=="*"n {print $1; exit}' "$checks")"
                        if [ -n "$expected" ]; then
                            actual="$(sha256sum "$spk" | awk '{print $1}')"
                            if [ "$actual" != "$expected" ]; then
                                warn "SHA256 invalide pour le SPK Decypharr"
                                rm -f "$spk"
                                return 1
                            fi
                            log "SHA256 Decypharr valide"
                        fi
                    fi
                fi

                if install_local_decypharr_spk "$spk"; then
                    log "Decypharr installed from GitHub Release"
                    return 0
                fi
            fi
        else
            warn "No DSM $DSM_MAJOR.$DSM_MINOR / $ARCH asset found in the latest Decypharr release."
        fi
    else
        warn "No usable Decypharr GitHub release found."
    fi

    warn "Decypharr could not be installed automatically."
    warn "Fournis un SPK avec : DECYPHARR_SPK=/chemin/decypharr-...spk $0"
    return 1
}

install_decypharr || FAILED="$FAILED decypharr"

if ! is_installed decypharr; then
    err "Decypharr is missing. Radarr/Sonarr are installed, but the integration cannot be completed."
    err "Rerun with DECYPHARR_SPK=/path/to/decypharr-...-dsm${DSM_MAJOR}.${DSM_MINOR}-${ARCH}.spk"
    exit 1
fi

# The DSM package has now created its @appdata. Only the required directories are completed here.
mkdir -p "$DECYPHARR_CONFIG_DIR" "$DECYPHARR_CACHE_DIR"

DECYPHARR_USER="$(
    if [ -f /var/packages/decypharr/conf/privilege ]; then
        sed -n 's/.*"username"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
            /var/packages/decypharr/conf/privilege | head -1
    fi
)"
[ -n "$DECYPHARR_USER" ] || DECYPHARR_USER="sc-decypharr"

if id "$DECYPHARR_USER" >/dev/null 2>&1; then
    DECYPHARR_GID="$(id -g "$DECYPHARR_USER")"
    chown "$DECYPHARR_USER:$DECYPHARR_GID" \
        "$DECYPHARR_ROOT" \
        "$DECYPHARR_MOUNT" \
        "$DECYPHARR_DOWNLOADS" \
        "$DECYPHARR_CONFIG_DIR" \
        "$DECYPHARR_CACHE_DIR" 2>/dev/null || true
    chmod 755 "$DECYPHARR_ROOT" "$DECYPHARR_MOUNT" "$DECYPHARR_CONFIG_DIR" "$DECYPHARR_CACHE_DIR" 2>/dev/null || true
    chmod 775 "$DECYPHARR_DOWNLOADS" 2>/dev/null || true
    log "Decypharr directories assigned to $DECYPHARR_USER"
else
    warn "Decypharr service account not found: $DECYPHARR_USER"
fi

# Stop cleanly before replacing the runtime configuration and touching the FUSE mount point.
synopkg stop decypharr >"$TMPBASE/stop-decypharr.log" 2>&1 || true

# ---------------------------------------------------------------------------
# Initial start of Radarr / Sonarr / Plex and retrieval of their API keys
# ---------------------------------------------------------------------------

start_pkg() {
    pkg="$1"
    is_installed "$pkg" || return 0
    synopkg start "$pkg" >"$TMPBASE/start-$pkg.log" 2>&1 || true
}

for pkg in PlexMediaServer radarr sonarr prowlarr qbittorrent bazarr; do
    start_pkg "$pkg"
done

sleep 5

get_arr_api_key() {
    pkg="$1"
    cfg=""

    if [ -d "/var/packages/$pkg/var" ]; then
        cfg="$(find "/var/packages/$pkg/var" -type f -name config.xml 2>/dev/null | head -1)"
    fi

    if [ -z "$cfg" ]; then
        for appdata in /volume*/@appdata/$pkg; do
            [ -d "$appdata" ] || continue
            cfg="$(find "$appdata" -type f -name config.xml 2>/dev/null | head -1)"
            [ -n "$cfg" ] && break
        done
    fi

    [ -n "${cfg:-}" ] || return 0
    sed -n 's:.*<ApiKey>\([^<]*\)</ApiKey>.*:\1:p' "$cfg" | head -1
}

wait_for_api_key() {
    pkg="$1"
    i=0
    while [ "$i" -lt 45 ]; do
        key="$(get_arr_api_key "$pkg")"
        if [ -n "${key:-}" ]; then
            printf '%s' "$key"
            return 0
        fi
        sleep 1
        i=$((i + 1))
    done
    return 1
}

RADARR_KEY="$(wait_for_api_key radarr 2>/dev/null || true)"
SONARR_KEY="$(wait_for_api_key sonarr 2>/dev/null || true)"
PROWLARR_KEY="$(wait_for_api_key prowlarr 2>/dev/null || true)"

if is_installed radarr && [ -z "$RADARR_KEY" ]; then
    err "Unable to retrieve the Radarr API key."
    exit 1
fi
if is_installed sonarr && [ -z "$SONARR_KEY" ]; then
    err "Unable to retrieve the Sonarr API key."
    exit 1
fi

# ---------------------------------------------------------------------------
# Non-destructive stack.json merge
# ---------------------------------------------------------------------------

export STACK_JSON NAS_IP RADARR_PORT SONARR_PORT PROWLARR_PORT QBIT_PORT BAZARR_PORT PLEX_PORT DECYPHARR_PORT
export RADARR_KEY SONARR_KEY PROWLARR_KEY DECYPHARR_MOUNT DECYPHARR_DOWNLOADS QBIT_DOWNLOADS
export MOVIES_ROOT SERIES_ROOT MEDIA_ROOT ALLDEBRID_API_KEY RADARR_CATEGORY SONARR_CATEGORY WATCHLIST_STATE
export STACK_DIR N8N_CONFIG_ROOT N8N_MEDIA_ROOT

"$PYTHON" <<'PY'
import json, os, stat, tempfile

path = os.environ["STACK_JSON"]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
if not isinstance(data, dict):
    raise SystemExit("stack.json must contain a JSON object")

nas = os.environ["NAS_IP"]

def obj(name):
    current = data.get(name)
    if not isinstance(current, dict):
        current = {}
        data[name] = current
    return current

obj("nas")["host"] = nas

if os.environ.get("ALLDEBRID_API_KEY"):
    obj("decypharr")["alldebrid_api_key"] = os.environ["ALLDEBRID_API_KEY"]

plex = obj("plex")
plex["url"] = f"http://{nas}:{os.environ['PLEX_PORT']}"

radarr = obj("radarr")
radarr["url"] = f"http://{nas}:{os.environ['RADARR_PORT']}"
if os.environ.get("RADARR_KEY"):
    radarr["api_key"] = os.environ["RADARR_KEY"]

sonarr = obj("sonarr")
sonarr["url"] = f"http://{nas}:{os.environ['SONARR_PORT']}"
if os.environ.get("SONARR_KEY"):
    sonarr["api_key"] = os.environ["SONARR_KEY"]

prowlarr = obj("prowlarr")
prowlarr["url"] = f"http://{nas}:{os.environ['PROWLARR_PORT']}"
if os.environ.get("PROWLARR_KEY"):
    prowlarr["api_key"] = os.environ["PROWLARR_KEY"]

qbittorrent = obj("qbittorrent")
qbittorrent["url"] = f"http://{nas}:{os.environ['QBIT_PORT']}"
qbittorrent["download_folder"] = os.environ["QBIT_DOWNLOADS"]
qbittorrent.setdefault("role", "fallback_manual")

bazarr = obj("bazarr")
bazarr["url"] = f"http://{nas}:{os.environ['BAZARR_PORT']}"

decy = obj("decypharr")
decy.update({
    "url": f"http://{nas}:{os.environ['DECYPHARR_PORT']}",
    "mount_path": os.environ["DECYPHARR_MOUNT"],
    "download_folder": os.environ["DECYPHARR_DOWNLOADS"],
    "categories": [os.environ["RADARR_CATEGORY"], os.environ["SONARR_CATEGORY"]],
    "default_download_action": "symlink",
})

paths = obj("paths")
paths["config_root"] = os.environ["STACK_DIR"]
paths["media_root"] = os.environ["MEDIA_ROOT"]
paths["n8n_config_root"] = os.environ["N8N_CONFIG_ROOT"]
paths["n8n_media_root"] = os.environ["N8N_MEDIA_ROOT"]
paths["movies"] = os.environ["MOVIES_ROOT"]
paths["series"] = os.environ["SERIES_ROOT"]
paths["decypharr_mount"] = os.environ["DECYPHARR_MOUNT"]
paths["decypharr_downloads"] = os.environ["DECYPHARR_DOWNLOADS"]
paths["qbittorrent_downloads"] = os.environ["QBIT_DOWNLOADS"]
paths["watchlist_state"] = os.environ["WATCHLIST_STATE"]

st = os.stat(path)
mode = stat.S_IMODE(st.st_mode)
fd, tmp = tempfile.mkstemp(prefix=".stack.", dir=os.path.dirname(path) or ".")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode if mode else 0o600)
    try:
        os.chown(tmp, st.st_uid, st.st_gid)
    except PermissionError:
        pass
    os.replace(tmp, path)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)
PY
if [ $? -ne 0 ]; then
    err "Unable to merge settings into stack.json."
    exit 1
fi

if chown "$STACK_OWNER:$STACK_GROUP" "$STACK_JSON" 2>/dev/null; then
    chmod 600 "$STACK_JSON" 2>/dev/null || true
    log "stack.json permissions: owner $STACK_OWNER:$STACK_GROUP, mode 0600"
else
    warn "Unable to apply owner $STACK_OWNER:$STACK_GROUP to $STACK_JSON"
fi

log "stack.json merged without deleting existing keys"

# ---------------------------------------------------------------------------
# Decypharr runtime generator from stack.json
# ---------------------------------------------------------------------------

cat > "$DECYPHARR_SYNC" <<'PY'
#!/usr/bin/env python3
import json
import os
import pwd
import stat
import tempfile

STACK_JSON = os.environ.get("STACK_JSON", "/var/packages/decypharr/var/stack.json")
CONFIG_JSON = os.environ.get("DECYPHARR_CONFIG", "/var/packages/decypharr/var/data/config.json")
MOUNT_PATH = os.environ.get("DECYPHARR_MOUNT", "/var/packages/decypharr/var/mount")
DOWNLOAD_FOLDER = os.environ.get("DECYPHARR_DOWNLOADS", "/var/packages/decypharr/var/downloads")
CACHE_DIR = os.environ.get("DECYPHARR_CACHE_DIR", "/var/packages/decypharr/var/cache/dfs")
PORT = str(os.environ.get("DECYPHARR_PORT", "8282"))
RADARR_CATEGORY = os.environ.get("RADARR_CATEGORY", "radarr")
SONARR_CATEGORY = os.environ.get("SONARR_CATEGORY", "sonarr")


def normalize(v):
    return "".join(ch for ch in str(v).lower() if ch.isalnum())


def secret_value(obj):
    if not isinstance(obj, dict):
        return None
    for k, v in obj.items():
        nk = normalize(k)
        if nk in {"apikey", "token", "key", "secret", "apitoken"} and isinstance(v, str) and v.strip():
            return v.strip()
    return None


def find_alldebrid_key(root):
    # Handle common explicit cases first.
    paths = [
        ("alldebrid",),
        ("all_debrid",),
        ("all-debrid",),
        ("debrid", "alldebrid"),
        ("debrids", "alldebrid"),
    ]
    for path in paths:
        cur = root
        ok = True
        for p in path:
            if not isinstance(cur, dict) or p not in cur:
                ok = False
                break
            cur = cur[p]
        if ok:
            val = secret_value(cur)
            if val:
                return val

    def walk(x):
        if isinstance(x, dict):
            # Objet provider de type {provider: alldebrid, api_key: ...}
            ident = " ".join(str(x.get(k, "")) for k in ("provider", "name", "type", "service"))
            if "alldebrid" in normalize(ident):
                val = secret_value(x)
                if val:
                    return val

            # Flat key: alldebrid_api_key, alldebridToken, etc.
            for k, v in x.items():
                nk = normalize(k)
                if nk in {"alldebridapikey", "alldebridtoken", "alldebridkey", "alldebridapitoken"}:
                    if isinstance(v, str) and v.strip():
                        return v.strip()

            # Nested object named alldebrid.
            for k, v in x.items():
                if "alldebrid" in normalize(k):
                    val = secret_value(v)
                    if val:
                        return val

            for v in x.values():
                found = walk(v)
                if found:
                    return found
        elif isinstance(x, list):
            for v in x:
                found = walk(v)
                if found:
                    return found
        return None

    return walk(root)


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            v = json.load(f)
        return v
    except FileNotFoundError:
        return default
    except json.JSONDecodeError as e:
        raise SystemExit(f"JSON invalide dans {path}: {e}")


def endpoint(stack, name, default_port):
    section = stack.get(name, {})
    if not isinstance(section, dict):
        section = {}
    url = str(section.get("url") or "").rstrip("/")
    token = str(section.get("api_key") or section.get("token") or "")
    if not url:
        host = str((stack.get("nas") or {}).get("host") or "127.0.0.1")
        url = f"http://{host}:{default_port}"
    return url, token


def choose_uid_gid():
    for user in ("PlexMediaServer", "sc-decypharr"):
        try:
            p = pwd.getpwnam(user)
            return p.pw_uid, p.pw_gid
        except KeyError:
            pass
    return os.getuid(), os.getgid()


def config_owner():
    if os.path.exists(CONFIG_JSON):
        st = os.stat(CONFIG_JSON)
        return st.st_uid, st.st_gid
    try:
        p = pwd.getpwnam("sc-decypharr")
        return p.pw_uid, p.pw_gid
    except KeyError:
        return os.getuid(), os.getgid()


stack = load_json(STACK_JSON, {})
if not isinstance(stack, dict):
    raise SystemExit("stack.json must contain a JSON object")

api_key = find_alldebrid_key(stack)
if not api_key:
    raise SystemExit("AllDebrid API key not found in stack.json")

radarr_url, radarr_key = endpoint(stack, "radarr", "7878")
sonarr_url, sonarr_key = endpoint(stack, "sonarr", "8989")

cfg = load_json(CONFIG_JSON, {})
if not isinstance(cfg, dict):
    cfg = {}

cfg["bind_address"] = cfg.get("bind_address") or "0.0.0.0"
cfg["port"] = PORT
cfg["app_url"] = cfg.get("app_url") or f"http://{(stack.get('nas') or {}).get('host', '127.0.0.1')}:{PORT}"
cfg["log_level"] = cfg.get("log_level") or "info"
cfg["download_folder"] = DOWNLOAD_FOLDER
cfg["categories"] = [RADARR_CATEGORY, SONARR_CATEGORY]
cfg["default_download_action"] = "symlink"
cfg["folder_naming"] = cfg.get("folder_naming") or "original_no_ext"
cfg["refresh_interval"] = cfg.get("refresh_interval") or "30s"
cfg["max_active_downloads"] = int(cfg.get("max_active_downloads") or 5)
cfg["retries"] = int(cfg.get("retries") or 3)
cfg["use_auth"] = False

# Preserve other providers, but always reinject AllDebrid from stack.json.
debrids = cfg.get("debrids")
if not isinstance(debrids, list):
    debrids = []
new_debrids = []
replaced = False
for d in debrids:
    if not isinstance(d, dict):
        continue
    if normalize(d.get("provider", "")) == "alldebrid" or "alldebrid" in normalize(d.get("name", "")):
        nd = dict(d)
        nd["provider"] = "alldebrid"
        nd["name"] = "alldebrid"
        nd["api_key"] = api_key
        nd["download_uncached"] = True
        new_debrids.append(nd)
        replaced = True
    else:
        new_debrids.append(d)
if not replaced:
    new_debrids.append({
        "provider": "alldebrid",
        "name": "alldebrid",
        "api_key": api_key,
        "download_uncached": True,
    })
cfg["debrids"] = new_debrids

# Radarr/Sonarr are auto-discovered natively by Decypharr from the
# qBittorrent-compatible clients configured in the *Arr applications.
# Do not inject duplicate source=config instances.
# Remove only legacy bootstrap-managed entries.
arrs = cfg.get("arrs")
if isinstance(arrs, list):
    cfg["arrs"] = [
        a for a in arrs
        if not (
            isinstance(a, dict)
            and normalize(a.get("name", "")) in {"radarr", "sonarr"}
            and a.get("source") == "config"
        )
    ]

uid, gid = choose_uid_gid()
mount = cfg.get("mount") if isinstance(cfg.get("mount"), dict) else {}
mount["type"] = "dfs"
mount["mount_path"] = MOUNT_PATH
dfs = mount.get("dfs") if isinstance(mount.get("dfs"), dict) else {}
dfs.update({
    "cache_dir": CACHE_DIR,
    "chunk_size": dfs.get("chunk_size") or "10MB",
    "disk_cache_size": dfs.get("disk_cache_size") or "50GB",
    "cache_expiry": dfs.get("cache_expiry") or "24h",
    "cache_cleanup_interval": dfs.get("cache_cleanup_interval") or "1h",
    "daemon_timeout": dfs.get("daemon_timeout") or "30m",
    "uid": uid,
    "gid": gid,
    "umask": "022",
})
mount["dfs"] = dfs
cfg["mount"] = mount

os.makedirs(os.path.dirname(CONFIG_JSON), exist_ok=True)
mode = 0o600
if os.path.exists(CONFIG_JSON):
    mode = stat.S_IMODE(os.stat(CONFIG_JSON).st_mode) or 0o600
owner_uid, owner_gid = config_owner()
fd, tmp = tempfile.mkstemp(prefix=".config.", dir=os.path.dirname(CONFIG_JSON))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    try:
        os.chown(tmp, owner_uid, owner_gid)
    except PermissionError:
        pass
    os.replace(tmp, CONFIG_JSON)
finally:
    if os.path.exists(tmp):
        os.unlink(tmp)

masked = api_key[:4] + "..." + api_key[-4:] if len(api_key) >= 10 else "***"
print(f"Decypharr runtime synchronized from {STACK_JSON}; AllDebrid={masked}")
PY

chmod 700 "$DECYPHARR_SYNC"

# Run the generator immediately. stack.json remains the managed source of truth.
export DECYPHARR_CONFIG DECYPHARR_CACHE_DIR
"$PYTHON" "$DECYPHARR_SYNC" || {
    err "Unable to generate the Decypharr runtime configuration from stack.json."
    exit 1
}
chmod 600 "$DECYPHARR_CONFIG" 2>/dev/null || true
log "Decypharr configuration generated from stack.json"

# ---------------------------------------------------------------------------
# Synchronization at every DSM boot
# ---------------------------------------------------------------------------

if [ "$INSTALL_BOOT_SYNC" = "1" ]; then
mkdir -p /usr/local/etc/rc.d
cat > "$DECYPHARR_BOOT_SYNC" <<EOF_BOOT
#!/bin/sh
case "\${1:-start}" in
  start)
    PY=""
    if command -v python3 >/dev/null 2>&1; then
      PY="\$(command -v python3)"
    else
      for p in /var/packages/python*/target/bin/python3 /var/packages/python*/target/bin/python3.* /volume*/@appstore/python*/bin/python3 /volume*/@appstore/python*/bin/python3.*; do
        if [ -x "\$p" ]; then PY="\$p"; break; fi
      done
    fi
    [ -n "\$PY" ] || exit 0
    STACK_JSON='$STACK_JSON' \\
    DECYPHARR_CONFIG='$DECYPHARR_CONFIG' \\
    DECYPHARR_MOUNT='$DECYPHARR_MOUNT' \\
    DECYPHARR_DOWNLOADS='$DECYPHARR_DOWNLOADS' \\
    DECYPHARR_CACHE_DIR='$DECYPHARR_CACHE_DIR' \\
    DECYPHARR_PORT='$DECYPHARR_PORT' \\
    RADARR_CATEGORY='$RADARR_CATEGORY' \\
    SONARR_CATEGORY='$SONARR_CATEGORY' \\
      "\$PY" '$DECYPHARR_SYNC' >> '$DECYPHARR_APPDATA/stack-sync.log' 2>&1 || exit 0
    if [ -d /var/packages/decypharr ]; then
      synopkg restart decypharr >> '$DECYPHARR_APPDATA/stack-sync.log' 2>&1 || true
    fi
    ;;
  stop)
    ;;
esac
exit 0
EOF_BOOT
chmod 755 "$DECYPHARR_BOOT_SYNC"
log "Boot synchronization installed: $DECYPHARR_BOOT_SYNC"
else
    rm -f "$DECYPHARR_BOOT_SYNC" 2>/dev/null || true
    info "Boot synchronization disabled"
fi

# ---------------------------------------------------------------------------
# FUSE / DSM permissions
# ---------------------------------------------------------------------------

if [ -e /dev/fuse ]; then
    chmod 0666 /dev/fuse 2>/dev/null || true
else
    warn "/dev/fuse is missing. The Decypharr DFS mount will not work."
fi

if [ -f /etc/fuse.conf ]; then
    grep -Eq '^[[:space:]]*user_allow_other[[:space:]]*$' /etc/fuse.conf || \
        printf '\nuser_allow_other\n' >> /etc/fuse.conf
else
    printf 'user_allow_other\n' > /etc/fuse.conf 2>/dev/null || true
fi

pkg_user() {
    pkg="$1"
    fallback="sc-$pkg"
    privilege="/var/packages/$pkg/conf/privilege"
    if [ -f "$privilege" ]; then
        u="$(sed -n 's/.*"username"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$privilege" | head -1)"
        if [ -n "$u" ]; then
            printf '%s' "$u"
            return 0
        fi
    fi
    printf '%s' "$fallback"
}

acl_remove_user_entries() {
    target="$1"
    user="$2"
    [ -x "$ACLTOOL" ] || return 0
    [ -e "$target" ] || return 0

    indexes="$(
        "$ACLTOOL" -get "$target" 2>/dev/null |
        awk -v needle="user:$user:" '
            index($0, needle) {
                gsub(/\[/, "", $1)
                gsub(/\]/, "", $1)
                print $1
            }
        ' | sort -rn
    )"
    for idx in $indexes; do
        "$ACLTOOL" -del "$target" "$idx" >/dev/null 2>&1 || true
    done
}

acl_set_ro() {
    target="$1"
    user="$2"
    id "$user" >/dev/null 2>&1 || return 0
    acl_remove_user_entries "$target" "$user"
    "$ACLTOOL" -add "$target" "user:$user:allow:r-x---a-R-c--:fd--" >/dev/null 2>&1 || \
        warn "Unable to apply read-only ACL: $user -> $target"
}

acl_set_file_ro() {
    target="$1"
    user="$2"
    [ -n "$user" ] || return 0
    id "$user" >/dev/null 2>&1 || return 0
    acl_remove_user_entries "$target" "$user"
    "$ACLTOOL" -add "$target" "user:$user:allow:r-----a-R-c--:---n" >/dev/null 2>&1 || \
        warn "Unable to apply file read ACL: $user -> $target"
}

acl_set_rw() {
    target="$1"
    user="$2"
    id "$user" >/dev/null 2>&1 || return 0
    acl_remove_user_entries "$target" "$user"
    "$ACLTOOL" -add "$target" "user:$user:allow:rwxpdDaARWc--:fd--" >/dev/null 2>&1 || \
        warn "Unable to apply read/write ACL: $user -> $target"
}

if [ -x "$ACLTOOL" ]; then
    PLEX_USER="PlexMediaServer"
    RADARR_USER="$(pkg_user radarr)"
    SONARR_USER="$(pkg_user sonarr)"
    PROWLARR_USER="$(pkg_user prowlarr)"
    QBIT_USER="$(pkg_user qbittorrent)"
    BAZARR_USER="$(pkg_user bazarr)"
    DECYPHARR_USER="$(pkg_user decypharr)"

    # Ne jamais enfermer l'administrateur humain hors de stack.json.
    # Adding service ACLs to a DSM directory can break inheritance
    # from the parent, so explicitly reapply the selected stack.json
    # owner's permissions on its directory.
    acl_set_rw "$STACK_DIR" "$STACK_OWNER"

    # Grant the configured n8n SMB account access to the selected state directory
    # and read-only access to stack.json without exposing secrets to everyone.
    if [ -n "$N8N_STACK_READER" ]; then
        acl_set_ro "$STACK_DIR" "$N8N_STACK_READER"
        acl_set_file_ro "$STACK_JSON" "$N8N_STACK_READER"
    fi

    acl_set_ro "$PLEXROOT" "$PLEX_USER"
    acl_set_ro "$PLEX_LIBRARY_ROOT" "$PLEX_USER"
    acl_set_ro "$MOVIES_ROOT" "$PLEX_USER"
    acl_set_ro "$SERIES_ROOT" "$PLEX_USER"
    acl_set_ro "$DECYPHARR_ROOT" "$PLEX_USER"
    acl_set_ro "$DECYPHARR_MOUNT" "$PLEX_USER"

    acl_set_ro "$PLEXROOT" "$RADARR_USER"
    acl_set_rw "$MOVIES_ROOT" "$RADARR_USER"
    acl_set_rw "$DECYPHARR_DOWNLOADS" "$RADARR_USER"
    acl_set_ro "$DECYPHARR_MOUNT" "$RADARR_USER"

    acl_set_ro "$PLEXROOT" "$SONARR_USER"
    acl_set_rw "$SERIES_ROOT" "$SONARR_USER"
    acl_set_rw "$DECYPHARR_DOWNLOADS" "$SONARR_USER"
    acl_set_ro "$DECYPHARR_MOUNT" "$SONARR_USER"

    # qBittorrent is kept as a fallback/manual download client.
    # It does not need direct write access to the Plex library.
    acl_set_ro "$PLEXROOT" "$QBIT_USER"
    acl_set_rw "$QBIT_DOWNLOADS" "$QBIT_USER"

    # Bazarr must be able to write subtitles next to media files.
    acl_set_ro "$PLEXROOT" "$BAZARR_USER"
    acl_set_rw "$PLEX_LIBRARY_ROOT" "$BAZARR_USER"
    acl_set_rw "$MOVIES_ROOT" "$BAZARR_USER"
    acl_set_rw "$SERIES_ROOT" "$BAZARR_USER"

    acl_set_rw "$DECYPHARR_ROOT" "$DECYPHARR_USER"
    acl_set_rw "$DECYPHARR_MOUNT" "$DECYPHARR_USER"
    acl_set_rw "$DECYPHARR_DOWNLOADS" "$DECYPHARR_USER"

    log "DSM ACLs applied (stack.json: admin=$STACK_OWNER, n8n=${N8N_STACK_READER:-none})"
else
    warn "synoacltool was not found: DSM ACLs were not applied"
fi

# ---------------------------------------------------------------------------
# Start Decypharr and test /version
# ---------------------------------------------------------------------------

if is_installed decypharr; then
    synopkg restart decypharr >"$TMPBASE/restart-decypharr.log" 2>&1 || \
        synopkg start decypharr >"$TMPBASE/start-decypharr.log" 2>&1 || true

    i=0
    while [ "$i" -lt 60 ]; do
        if curl -fsS --max-time 3 "http://127.0.0.1:$DECYPHARR_PORT/version" >/dev/null 2>&1; then
            log "Decypharr is responding on port $DECYPHARR_PORT"
            break
        fi
        sleep 1
        i=$((i + 1))
    done

    if [ "$i" -ge 60 ]; then
        warn "Decypharr is not responding yet at http://127.0.0.1:$DECYPHARR_PORT/version"
        warn "Consulte : $TMPBASE/restart-decypharr.log et $DECYPHARR_APPDATA/logs/"
    fi
fi

# ---------------------------------------------------------------------------
# Automatically configure Radarr/Sonarr to use Decypharr
# ---------------------------------------------------------------------------

if [ "$CONFIGURE_ARRS" = "1" ] && is_installed decypharr; then
    export DECYPHARR_HOST="$NAS_IP"
    export RADARR_URL="http://127.0.0.1:$RADARR_PORT"
    export SONARR_URL="http://127.0.0.1:$SONARR_PORT"
    export RADARR_ROOT="$MOVIES_ROOT"
    export SONARR_ROOT="$SERIES_ROOT"
    export RADARR_CATEGORY SONARR_CATEGORY

    "$PYTHON" <<'PY' || warn "Automatic Radarr/Sonarr configuration was not fully applied."
import json
import os
import urllib.error
import urllib.request

DECY_HOST = os.environ["DECYPHARR_HOST"]
DECY_PORT = int(os.environ.get("DECYPHARR_PORT", "8282"))


def request(base, api_key, method, path, payload=None):
    url = base.rstrip("/") + path
    body = None
    headers = {"X-Api-Key": api_key, "Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read().decode("utf-8", "replace")
            return json.loads(raw) if raw.strip() else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {url} -> HTTP {e.code}: {detail[:1000]}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"{method} {url} -> connection failed: {e.reason}") from e


def set_field(client, name, value):
    for f in client.get("fields", []):
        if f.get("name") == name:
            f["value"] = value
            return True
    return False


def configure_arr(name, base, api_key, category, root_folder):
    if not api_key:
        print(f"[{name}] API key missing, configuration skipped")
        return

    schemas = request(base, api_key, "GET", "/api/v3/downloadclient/schema") or []
    schema = None
    for s in schemas:
        impl = str(s.get("implementation", ""))
        impl_name = str(s.get("implementationName", ""))
        if "qbittorrent" in (impl + impl_name).lower():
            schema = s
            break
    if schema is None:
        raise RuntimeError(f"[{name}] qBittorrent schema not found")

    client = json.loads(json.dumps(schema))
    client["name"] = "Decypharr"
    client["enable"] = True
    client["priority"] = 1
    client["removeCompletedDownloads"] = True
    client["removeFailedDownloads"] = False
    client["tags"] = []

    set_field(client, "host", DECY_HOST)
    set_field(client, "port", DECY_PORT)
    set_field(client, "useSsl", False)
    set_field(client, "urlBase", "")
    set_field(client, "username", base.rstrip("/"))
    set_field(client, "password", api_key)
    set_field(client, "category", category)\n    set_field(client, "movieCategory", category)\n    set_field(client, "tvCategory", category)

    existing = request(base, api_key, "GET", "/api/v3/downloadclient") or []
    found = next((x for x in existing if str(x.get("name", "")).lower() == "decypharr"), None)
    if found:
        client["id"] = found["id"]
        request(base, api_key, "PUT", f"/api/v3/downloadclient/{found['id']}", client)
        print(f"[{name}] Decypharr client updated")
    else:
        request(base, api_key, "POST", "/api/v3/downloadclient", client)
        print(f"[{name}] Decypharr client created")

    roots = request(base, api_key, "GET", "/api/v3/rootfolder") or []
    norm = lambda p: str(p).rstrip("/")
    if not any(norm(x.get("path", "")) == norm(root_folder) for x in roots):
        try:
            request(base, api_key, "POST", "/api/v3/rootfolder", {"path": root_folder})
            print(f"[{name}] root folder added: {root_folder}")
        except Exception as e:
            print(f"[{name}] root folder was not added automatically: {e}")


failures = []
for args in (
    ("Radarr", os.environ["RADARR_URL"], os.environ.get("RADARR_KEY", ""), os.environ.get("RADARR_CATEGORY", "radarr"), os.environ["RADARR_ROOT"]),
    ("Sonarr", os.environ["SONARR_URL"], os.environ.get("SONARR_KEY", ""), os.environ.get("SONARR_CATEGORY", "sonarr"), os.environ["SONARR_ROOT"]),
):
    try:
        configure_arr(*args)
    except Exception as e:
        failures.append(f"{args[0]}: {e}")
        print(f"[{args[0]}] ERROR: {e}")

if failures:
    raise SystemExit(1)
PY
fi

# ---------------------------------------------------------------------------
# Rapport
# ---------------------------------------------------------------------------

printf '\n============================================================\n'
printf '   PLEX + RADARR + SONARR + DECYPHARR - RAPPORT\n'
printf '============================================================\n'
printf 'NAS                 : %s\n' "$NAS_IP"
printf 'Plex                : http://%s:%s/web\n' "$NAS_IP" "$PLEX_PORT"
printf 'Radarr              : http://%s:%s\n' "$NAS_IP" "$RADARR_PORT"
printf 'Sonarr              : http://%s:%s\n' "$NAS_IP" "$SONARR_PORT"
printf 'Prowlarr            : http://%s:%s\n' "$NAS_IP" "$PROWLARR_PORT"
printf 'qBittorrent         : http://%s:%s\n' "$NAS_IP" "$QBIT_PORT"
printf 'Bazarr              : http://%s:%s\n' "$NAS_IP" "$BAZARR_PORT"
printf 'Decypharr           : http://%s:%s\n' "$NAS_IP" "$DECYPHARR_PORT"
printf 'API locale Radarr   : http://127.0.0.1:%s\n' "$RADARR_PORT"
printf 'API locale Sonarr   : http://127.0.0.1:%s\n' "$SONARR_PORT"
printf 'Radarr category     : %s\n' "$RADARR_CATEGORY"
printf 'Sonarr category     : %s\n' "$SONARR_CATEGORY"
printf '\n'
printf 'Movies              : %s\n' "$MOVIES_ROOT"
printf 'Series              : %s\n' "$SERIES_ROOT"
printf 'Decypharr mount     : %s\n' "$DECYPHARR_MOUNT"
printf 'Decypharr downloads : %s\n' "$DECYPHARR_DOWNLOADS"
printf 'qBittorrent downloads: %s\n' "$QBIT_DOWNLOADS"
printf 'Decypharr config    : %s\n' "$DECYPHARR_CONFIG"
printf 'Source of truth     : %s\n' "$STACK_JSON"
printf 'Watchlist state     : %s\n' "$WATCHLIST_STATE"
printf 'n8n config mount    : PlexMediaServer -> %s\n' "$N8N_CONFIG_ROOT"
printf 'n8n media mount     : media root -> %s\n' "$N8N_MEDIA_ROOT"
printf 'stack.json owner    : %s:%s (0600 + ACL)\n' "$STACK_OWNER" "$STACK_GROUP"
printf 'n8n stack reader    : %s\n' "${N8N_STACK_READER:-none}"
if [ "$INSTALL_BOOT_SYNC" = "1" ]; then printf 'Boot sync           : %s\n' "$DECYPHARR_BOOT_SYNC"; else printf 'Boot sync           : disabled\n'; fi
printf '\n'

for pkg in PlexMediaServer radarr sonarr prowlarr qbittorrent bazarr decypharr; do
    if is_installed "$pkg"; then
        printf '  %-18s INSTALLE  ' "$pkg"
        synopkg status "$pkg" 2>/dev/null | tr '\n' ' '
        printf '\n'
    else
        printf '  %-18s MISSING\n' "$pkg"
    fi
done

if [ -n "$FAILED" ]; then
    printf '\n'
    warn "Components still failing:$FAILED"
    warn "Diagnostics : $TMPBASE"
fi

printf '\nUseful checks:\n'
printf '  curl http://127.0.0.1:%s/version\n' "$DECYPHARR_PORT"
printf '  curl -s http://127.0.0.1:%s/api/arrs | python3 -m json.tool\n' "$DECYPHARR_PORT"
printf '  synogetkeyvalue /etc.defaults/synoinfo.conf unique\n'
printf '  synopkg status decypharr\n'
printf '  synopkg status radarr\n'
printf '  synopkg status sonarr\n'
printf '  synopkg status prowlarr\n'
printf '  synopkg status qbittorrent\n'
printf '  synopkg status bazarr\n'
printf '  tail -100 %s/stack-sync.log\n' "$DECYPHARR_APPDATA"
printf '\n'
printf 'Important: stack.json remains the configuration source of truth.\n'
if [ "$INSTALL_BOOT_SYNC" = "1" ]; then printf 'The Decypharr runtime is regenerated from stack.json at every DSM boot.\n'; fi

printf '============================================================\n'
# END-PLEX-BOOTSTRAP-SYNOLOGY-V8.5
