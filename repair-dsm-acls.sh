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
# Add an explicit level-0 ACL while preserving every existing DSM ACE.
# Inherited permissions alone are not enough for all DSM media directories.
shared_ace() {
    shared_target="$1"; shared_user="$2"; shared_rights="$3"
    [ -e "$shared_target" ] && [ ! -L "$shared_target" ] || return 0
    if ! exists_user "$shared_user"; then
        echo "WARN: DSM media user missing: $shared_user" >&2
        return 0
    fi
    shared_rule="user:$shared_user:allow:$shared_rights"
    shared_current="$("$ACLTOOL" -get "$shared_target" 2>/dev/null)" || {
        echo "WARN: cannot read ACL: $shared_target" >&2
        return 0
    }
    if printf '%s\n' "$shared_current" | grep -F -- "$shared_rule (level:0)" >/dev/null 2>&1; then
        return 0
    fi
    if printf '%s\n' "$shared_current" | grep -F -- "user:$shared_user:deny:" >/dev/null 2>&1; then
        echo "WARN: deny ACE needs manual review: $shared_target / $shared_user" >&2
        return 0
    fi
    "$ACLTOOL" -add "$shared_target" "$shared_rule" >/dev/null 2>&1 ||
        echo "WARN: could not add shared ACL: $shared_target / $shared_user" >&2
}
shared_dir() {
    shared_dir_path="$1"
    [ -d "$shared_dir_path" ] && [ ! -L "$shared_dir_path" ] || return 0
    for shared_member in $MEDIA_SERVICE_USERS; do
        shared_ace "$shared_dir_path" "$shared_member" 'rwxpdDaARWc--:fd--'
    done
}
shared_file() {
    shared_file_path="$1"
    [ -f "$shared_file_path" ] && [ ! -L "$shared_file_path" ] || return 0
    for shared_member in $MEDIA_SERVICE_USERS; do
        shared_ace "$shared_file_path" "$shared_member" 'rwxpdDaARWc--:---n'
    done
}

RADARR_USER="$(pkg_user radarr)"
SONARR_USER="$(pkg_user sonarr)"
QBIT_USER="$(pkg_user qbittorrent)"
BAZARR_USER="$(pkg_user bazarr)"
DECYPHARR_USER="$(pkg_user decypharr)"
PLEX_USER=PlexMediaServer
MEDIA_SERVICE_USERS="$QBIT_USER $PLEX_USER $BAZARR_USER $RADARR_USER $SONARR_USER $DECYPHARR_USER VideoFactory"

echo "ACL repair (add-only): seven equal media RWX users: $MEDIA_SERVICE_USERS; admin=${STACK_OWNER:-none}"
echo "Media root: $MEDIA_ROOT"

# Shared read/write/traverse access applies ONLY to the managed media tree.
# The parent _Plex folder is included to prevent qBittorrent traversal errors.
PLEXROOT="$(dirname "$MEDIA_ROOT")"
QBIT_PARENT="$(dirname "$QBIT_DOWNLOADS")"
for shared_root in "$PLEXROOT" "$MEDIA_ROOT" "$MEDIA_ROOT/downloads" \
    "$MOVIES_ROOT" "$SERIES_ROOT" "$QBIT_PARENT" "$QBIT_DOWNLOADS" \
    "$QBIT_DOWNLOADS/$RADARR_CATEGORY" "$QBIT_DOWNLOADS/$SONARR_CATEGORY"; do
    case "$shared_root" in
        "$PLEXROOT"|"$PLEXROOT"/*) shared_dir "$shared_root" ;;
        *) echo "WARN: skipping shared ACL outside Plex tree: $shared_root" >&2 ;;
    esac
done

# Existing files may have explicit ACLs that block inheritance from the root.
# Opt out on very large, known-healthy libraries with ACL_REPAIR_EXISTING=0.
repair_media_tree() {
    repair_root="$1"
    [ "${ACL_REPAIR_EXISTING:-1}" = 1 ] || return 0
    [ -d "$repair_root" ] || return 0
    case "$repair_root" in
        "$PLEXROOT"/*) ;;
        *) echo "WARN: refusing media ACL scan outside Plex tree: $repair_root" >&2; return 0 ;;
    esac
    echo "Repairing existing ACLs: $repair_root"
    find "$repair_root" \( -type d -o -type f \) -print 2>/dev/null |
    while IFS= read -r entry; do
        if [ -d "$entry" ]; then
            shared_dir "$entry"
            dir_rw "$entry" "$STACK_OWNER"
            dir_rw "$entry" "$N8N_STACK_READER"
        elif [ -f "$entry" ]; then
            shared_file "$entry"
            file_rw "$entry" "$STACK_OWNER"
            file_rw "$entry" "$N8N_STACK_READER"
        fi
    done
}
repair_media_tree "$MOVIES_ROOT"
repair_media_tree "$SERIES_ROOT"
repair_media_tree "$QBIT_DOWNLOADS/$RADARR_CATEGORY"
repair_media_tree "$QBIT_DOWNLOADS/$SONARR_CATEGORY"

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

# stack.json and Decypharr FUSE retain their own restricted ACLs.
# Prowlarr manages indexers, not media files. It requires no library write ACL.
echo "ACL repair finished. Existing ACL entries were not removed."
echo "Check: sudo -u PlexMediaServer ls '$SERIES_ROOT/Slam Dunk/Season 1' | head"
