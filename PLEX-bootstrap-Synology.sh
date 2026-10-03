#!/bin/sh
#
# PLEX-bootstrap-Synology.sh
# Version 8.7.3
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
#   Movies and Series are always created directly below PLEX_DATA_ROOT
#   DECYPHARR_ROOT=/volumeX/PlexMediaServer/decypharr
#   DECYPHARR_MOUNT=/volumeX/PlexMediaServer/decypharr/mount
#   DECYPHARR_DOWNLOADS=/volumeX/PlexMediaServer/decypharr/downloads
#   N8N_CONFIG_ROOT=/data/PlexMediaServer
#   N8N_MEDIA_ROOT=/data/media
#   DECYPHARR_APPDATA=/var/packages/decypharr/var
#   RADARR_PORT=7878 SONARR_PORT=8989 PLEX_PORT=32400 DECYPHARR_PORT=8282
#   RADARR_CATEGORY=radarr SONARR_CATEGORY=sonarr
#   QBIT_USERNAME=synoplex
#   QBIT_PASSWORD=...            # optional; generated securely when omitted
#   INSTALL_PLEX=1 INSTALL_RADARR=1 INSTALL_SONARR=1 INSTALL_DECYPHARR=1
#   CONFIGURE_SERVICES=1 INSTALL_BOOT_SYNC=1
#   DECYPHARR_SPK=/path/to/decypharr-....spk
#   ALLDEBRID_API_KEY=...   # only if stack.json does not exist or does not contain the key yet
#

set -u

SCRIPT_VERSION="8.7.3"
printf '\n[BOOT] PLEX Bootstrap Synology - v%s\n' "$SCRIPT_VERSION"
printf '[BOOT] Shell : %s\n' "${SHELL:-/bin/sh}"
printf '[BOOT] PID   : %s\n\n' "$$"

# Early integrity check: detect a truncated script before parsing the rest.
# DSM executes shell scripts progressively, so this check provides
# a readable error when a manual copy truncated the file.
if [ -f "$0" ]; then
    if ! tail -n 5 "$0" 2>/dev/null | grep -q '^# END-PLEX-BOOTSTRAP-SYNOLOGY-V8.7.3
