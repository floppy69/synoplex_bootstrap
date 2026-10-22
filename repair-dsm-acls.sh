#!/bin/sh
# SynoPlex DSM 7 native ACL repair. Run as root on the NAS.
# This script NEVER deletes, resets or forcibly inherits an existing ACL.
set -eu

ACLTOOL=/usr/syno/bin/synoacltool
MEDIA_ROOT="${MEDIA_ROOT:-/volume1/VideoFactory/_Plex/media}"
MOVIES_ROOT="${MOVIES_ROOT:-$MEDIA_ROOT/Movies}"
SERIES_ROOT="${SERIES_ROOT:-$MEDIA_ROOT/Series}"
QBIT_DOWNLOADS="${QBIT_DOWNLOADS:-/volume1/VideoFactory/_Plex/media/downloads/qbittorrent}"
STACK_DIR="${STACK_DIR:-/volume1/PlexMediaServer}"
DECYPHARR_ROOT="${DECYPHARR_ROOT:-$STACK_DIR/decypharr}"
[ -d "$DECYPHARR_ROOT" ] || DECYPHARR_ROOT=/volume1/VideoFactory/_Decypharr
STACK_OWNER="${STACK_OWNER:-${SUDO_USER:-}}"
N8N_STACK_READER="${N8N_STACK_READER:-}"
RADARR_CATEGORY="${RADARR_CATEGORY:-radarr}"
SONARR_CATEGORY="${SONARR_CATEGORY:-sonarr}"

if [ "$(id -u)" -ne 0 ] || [ ! -x "$ACLTOOL" ]; then
    echo "ERROR: run as root on Synology DSM (sudo sh repair-dsm-acls.sh)" >&2
    exit 1
fi
if [ ! -d "$SERIES_ROOT" ] || [ ! -d "$MOVIES_ROOT" ]; then
    echo "ERROR: library paths not found; set MEDIA_ROOT or MOVIES_ROOT/SERIES_ROOT" >&2
    exit 1
fi
case "$SERIES_ROOT:$MOVIES_ROOT" in
    /volume[0-9]*/*:/volume[0-9]*/*) ;;
    *) echo "ERROR: refusing unsafe library root(s)" >&2; exit 1 ;;
esac

pkg_user() {
    pkg="$1"
    privilege="/var/packages/$pkg/conf/privilege"
    user=""
    if [ -f "$privilege" ]; then
        user="$(sed -n 's/.*"username"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$privilege" | head -1)"
    fi
    [ -n "$user" ] || user="sc-$pkg"
    printf '%s' "$user"
}
exists_user() { [ -n "$1" ] && id "$1" >/dev/null 2>&1; }
add_acl() {
    target="$1"; ace="$2"
    [ -e "$target" ] || return 0
    if "$ACLTOOL" -get "$target" 2>/dev/null | grep -F -- "$ace" >/dev/null 2>&1; then return 0; fi
    "$ACLTOOL" -add "$target" "$ace" >/dev/null 2>&1 || {
        echo "WARN: unable to add ACL on $target: $ace" >&2
        return 0
    }
}
dir_ro() {
    exists_user "$2" || return 0
    add_acl "$1" "user:$2:allow:r-x---a-R-c--:fd--"
}
dir_rw() {
    exists_user "$2" || return 0
    add_acl "$1" "user:$2:allow:rwxpdDaARWc--:fd--"
}
file_ro() {
    exists_user "$2" || return 0
    add_acl "$1" "user:$2:allow:r-----a-R-c--:---n"
}
file_rw() {
    exists_user "$2" || return 0
    add_acl "$1" "user:$2:allow:rwxpdDaARWc--:---n"
}
RADARR_USER="$(pkg_user radarr)"
SONARR_USER="$(pkg_user sonarr)"
QBIT_USER="$(pkg_user qbittorrent)"
BAZARR_USER="$(pkg_user bazarr)"
DECYPHARR_USER="$(pkg_user decypharr)"
PLEX_USER=PlexMediaServer

echo "ACL repair (add-only): Plex=$PLEX_USER Radarr=$RADARR_USER Sonarr=$SONARR_USER Bazarr=$BAZARR_USER qBit=$QBIT_USER Decypharr=$DECYPHARR_USER admin=${STACK_OWNER:-none}"
echo "Media root: $MEDIA_ROOT"

# Traversal on ancestors and immediate library roots.
PLEXROOT="$(dirname "$MEDIA_ROOT")"
for root in "$PLEXROOT" "$MEDIA_ROOT"; do
    dir_ro "$root" "$PLEX_USER"
    dir_ro "$root" "$RADARR_USER"
    dir_ro "$root" "$SONARR_USER"
    dir_ro "$root" "$BAZARR_USER"
    dir_rw "$root" "$STACK_OWNER"
    dir_ro "$root" "$N8N_STACK_READER"
done

# A new directory may have its own explicit ACL and no inherited Plex ACE.
# Walk both existing files and directories, preserving every old ACE.
repair_library() {
    root="$1"; arr_user="$2"
    echo "Repairing $root"
    find "$root" \( -type d -o -type f \) -print 2>/dev/null |
    while IFS= read -r entry; do
        if [ -d "$entry" ]; then
            dir_ro "$entry" "$PLEX_USER"
            dir_rw "$entry" "$arr_user"
            dir_rw "$entry" "$BAZARR_USER"
            dir_rw "$entry" "$STACK_OWNER"
            dir_rw "$entry" "$N8N_STACK_READER"
        elif [ -f "$entry" ]; then
            file_ro "$entry" "$PLEX_USER"
            file_rw "$entry" "$arr_user"
            file_rw "$entry" "$BAZARR_USER"
            file_rw "$entry" "$STACK_OWNER"
            file_rw "$entry" "$N8N_STACK_READER"
        fi
    done
}
repair_library "$MOVIES_ROOT" "$RADARR_USER"
repair_library "$SERIES_ROOT" "$SONARR_USER"

# Package-specific download access, without granting clients broad media writes.
dir_rw "$QBIT_DOWNLOADS" "$QBIT_USER"
dir_ro "$QBIT_DOWNLOADS" "$SONARR_USER"
dir_ro "$QBIT_DOWNLOADS" "$RADARR_USER"
dir_rw "$QBIT_DOWNLOADS" "$N8N_STACK_READER"
dir_rw "$QBIT_DOWNLOADS/$RADARR_CATEGORY" "$QBIT_USER"
dir_rw "$QBIT_DOWNLOADS/$SONARR_CATEGORY" "$QBIT_USER"
dir_rw "$QBIT_DOWNLOADS/$RADARR_CATEGORY" "$RADARR_USER"
dir_rw "$QBIT_DOWNLOADS/$SONARR_CATEGORY" "$SONARR_USER"
dir_rw "$QBIT_DOWNLOADS/$RADARR_CATEGORY" "$N8N_STACK_READER"
dir_rw "$QBIT_DOWNLOADS/$SONARR_CATEGORY" "$N8N_STACK_READER"

# Configuration files retain their own ACLs and are never exposed publicly.
dir_rw "$STACK_DIR" "$STACK_OWNER"
dir_ro "$STACK_DIR" "$N8N_STACK_READER"
file_ro "$STACK_DIR/stack.json" "$N8N_STACK_READER"
file_rw "$STACK_DIR/watchlist-state.json" "$N8N_STACK_READER"
for user in "$RADARR_USER" "$SONARR_USER" "$DECYPHARR_USER"; do
    dir_ro "$STACK_DIR" "$user"
    dir_ro "$DECYPHARR_ROOT" "$user"
done
dir_rw "$DECYPHARR_ROOT" "$DECYPHARR_USER"
dir_rw "$DECYPHARR_ROOT/mount" "$DECYPHARR_USER"
dir_rw "$DECYPHARR_ROOT/downloads" "$DECYPHARR_USER"
dir_rw "$DECYPHARR_ROOT/downloads/$RADARR_CATEGORY" "$RADARR_USER"
dir_rw "$DECYPHARR_ROOT/downloads/$SONARR_CATEGORY" "$SONARR_USER"
dir_ro "$DECYPHARR_ROOT/mount" "$PLEX_USER"
dir_ro "$DECYPHARR_ROOT/mount" "$RADARR_USER"
dir_ro "$DECYPHARR_ROOT/mount" "$SONARR_USER"

# Prowlarr manages indexers, not media files. It requires no library write ACL.
echo "ACL repair finished. Existing ACL entries were not removed."
echo "Check: sudo -u PlexMediaServer ls '$SERIES_ROOT/Slam Dunk/Season 1' | head"
