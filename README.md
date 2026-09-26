# PLEX Bootstrap Synology

## Purpose

`PLEX-bootstrap-Synology.sh` bootstraps and maintains a native Synology DSM 7 media stack built around Plex, the *Arr applications, Decypharr, qBittorrent, Bazarr, and an n8n orchestration workflow.

The bootstrap is designed to be rerunnable. Existing configuration is preserved wherever possible, and `stack.json` remains the central source of truth for service URLs, API keys, paths, and secrets.

## Managed components

The target stack contains:

- **Plex Media Server** for media playback and libraries.
- **Radarr** for movies.
- **Sonarr** for TV series.
- **Prowlarr** for indexer management.
- **Decypharr** as the primary qBittorrent-compatible download client backed by AllDebrid.
- **qBittorrent** as a second download client and fallback path.
- **Bazarr** for subtitles.
- **n8n** for orchestration, Plex Watchlist processing, client selection, health checks, and post-download handling.

## Target architecture

```text
                         Prowlarr
                            |
                            v
                    Radarr / Sonarr
                      |         |
                      | downloadClientId
                      v
                 n8n routing policy
                  /             \
                 /               \
        Decypharr :8282      qBittorrent
             |                    |
             v                    v
          AllDebrid          BitTorrent swarm
                 \               /
                  \             /
                   v           v
                  Radarr / Sonarr
                        |
                        v
                 Movies / Series
                        |
                        v
                       Plex
```

Radarr and Sonarr keep **both** Decypharr and qBittorrent configured. n8n explicitly selects the client for each grab through the `downloadClientId` supported by the Radarr and Sonarr APIs.

The preferred route is Decypharr. qBittorrent is used as fallback when Decypharr explicitly refuses a grab. A timeout or ambiguous network failure must **not** trigger an automatic fallback, because the first request may already have been accepted and blindly retrying through qBittorrent could create a duplicate download.

## Reference files

Bootstrap script:

```text
PLEX-bootstrap-Synology.sh
```

Documentation:

```text
PLEX-bootstrap-Synology.md
```

Main configuration file on a new default installation:

```text
/volume1/PlexMediaServer/stack.json
```

Persistent Watchlist state:

```text
/volume1/PlexMediaServer/watchlist-state.json
```

Existing deployments using custom paths such as `/volume1/VideoFactory/_Plex/stack.json` are not migrated automatically.

Decypharr runtime configuration:

```text
/var/packages/decypharr/var/data/config.json
```

DSM boot synchronization script:

```text
/usr/local/etc/rc.d/S99decypharr-stack-sync.sh
```

The Decypharr runtime file is generated from `stack.json`. Do not treat the runtime file as the permanent configuration source.

## Recommended directory layout

On a new installation, SynoPlex configuration/state and Decypharr default to the Plex-created `PlexMediaServer` shared folder:

```text
/volume1/
|
+-- PlexMediaServer/
|   +-- stack.json
|   +-- watchlist-state.json
|   +-- decypharr/
|       +-- mount/
|       +-- downloads/
|
+-- VideoFactory/
    +-- _Plex/
        +-- media/
        |   +-- Movies/
        |   +-- Series/
        +-- downloads/
            +-- qbittorrent/
```

The bootstrap does not require `/volume1` specifically. It detects an existing `/volume*/PlexMediaServer` directory and uses it as the default state root. Explicit `STACK_JSON`, `WATCHLIST_STATE`, `DECYPHARR_ROOT`, and related variables always override these defaults. Existing deployments are not migrated automatically.

## Default ports

| Service | Default port |
|---|---:|
| Plex | 32400 |
| Radarr | 7878 or detected existing port |
| Sonarr | 8989 or detected existing port |
| Prowlarr | 9696 or detected existing port |
| Decypharr | 8282 |
| qBittorrent | 8095 or detected existing port |
| Bazarr | 6767 |

Existing *Arr ports are read from their `config.xml` files when available. Existing qBittorrent WebUI settings are also inspected when possible.

## Prerequisites

- Synology DSM 7.x.
- Root access through SSH.
- Internet access from the NAS when packages or Decypharr releases must be downloaded.
- SynoCommunity configured when SynoCommunity packages are required.
- A valid AllDebrid API key.
- Python 3. The bootstrap can attempt to install a SynoCommunity Python runtime when necessary.
- FUSE support for the Decypharr DFS mount.

## Installation

Copy the bootstrap to the NAS, for example:

```text
/volume1/VideoFactory/_Plex/PLEX-bootstrap-Synology.sh
```

Open an SSH session and become root:

```bash
sudo -i
cd /volume1/VideoFactory/_Plex
chmod 755 PLEX-bootstrap-Synology.sh
```

Validate the script before execution:

```bash
/bin/ash -n PLEX-bootstrap-Synology.sh
echo $?
```

Expected result:

```text
0
```

Run the bootstrap:

```bash
./PLEX-bootstrap-Synology.sh
```

## Interactive configuration

The bootstrap asks for the NAS address, directories, ports, installation choices, and ownership settings.

New-install defaults on the reference volume are:

```text
NAS address          : 192.168.0.4
stack.json directory : /volume1/PlexMediaServer
watchlist-state.json : /volume1/PlexMediaServer/watchlist-state.json
Plex data root       : /volume1/VideoFactory/_Plex
Plex library root    : /volume1/VideoFactory/_Plex/media
Movies               : /volume1/VideoFactory/_Plex/media/Movies
Series               : /volume1/VideoFactory/_Plex/media/Series
Decypharr root       : /volume1/PlexMediaServer/decypharr
Decypharr mount      : /volume1/PlexMediaServer/decypharr/mount
Decypharr downloads  : /volume1/PlexMediaServer/decypharr/downloads
Decypharr appdata    : /var/packages/decypharr/var
qBittorrent downloads: /volume1/VideoFactory/_Plex/downloads/qbittorrent
```

Existing installations keep their current locations when explicit paths are supplied. The bootstrap does not move an existing `stack.json`, Watchlist state file, or Decypharr tree.

On the reference installation, Radarr currently uses port `8310`, which is detected automatically from its existing configuration.

## stack.json ownership and n8n access

`stack.json` contains secrets, so it must not be made world-readable.

The recommended model is:

```text
Floppy       -> owner, read/write
VideoFactory -> read-only through DSM ACL, used by the n8n CIFS mount
root         -> implicit administrative access
others       -> no direct access
```

The file remains protected with Unix mode `0600` for its owner, while DSM ACL entries grant narrowly scoped access where required.

The reference n8n host mounts the NAS share as:

```text
//192.168.0.4/VideoFactory -> /data/video-factory
SMB account: videofactory / VideoFactory
```

n8n therefore expects the configuration at:

```text
/data/video-factory/_Plex/stack.json
```

The bootstrap explicitly asks for the DSM account used by n8n to read `stack.json` and applies the required DSM ACL without granting write permission to that account.

### Permission verification

On the Synology NAS:

```bash
ls -l /volume1/VideoFactory/_Plex/stack.json
/usr/syno/bin/synoacltool -get /volume1/VideoFactory/_Plex
/usr/syno/bin/synoacltool -get /volume1/VideoFactory/_Plex/stack.json
```

Test the owner:

```bash
su -s /bin/sh -c \
  'test -r /volume1/VideoFactory/_Plex/stack.json && echo READ_OK' \
  Floppy
```

Test the n8n SMB account:

```bash
su -s /bin/sh -c \
  'test -r /volume1/VideoFactory/_Plex/stack.json && echo N8N_READ_OK' \
  VideoFactory
```

## Package behavior

For each component, the bootstrap first checks whether the package is already installed. Existing installations are preserved and reused.

It can install or reuse:

```text
PlexMediaServer
radarr
sonarr
prowlarr
qbittorrent
bazarr
decypharr
```

Decypharr is installed from an explicitly supplied SPK, a compatible local SPK, or the configured GitHub release source when required.

## stack.json behavior

The bootstrap performs a non-destructive JSON merge. Unknown keys are preserved.

Managed sections include at least:

```text
plex
radarr
sonarr
prowlarr
qbittorrent
bazarr
decypharr
paths
```

API keys for Radarr, Sonarr, and Prowlarr are collected from their native configuration files when available.

The AllDebrid key is read from existing compatible locations inside `stack.json`. New or updated bootstrap-managed configuration stores it under `decypharr.alldebrid_api_key`. If no compatible key can be found, the bootstrap prompts for it without echoing the secret to the terminal.

## Decypharr configuration

Decypharr listens on the configured port, normally:

```text
8282
```

Radarr and Sonarr use Decypharr through its qBittorrent-compatible API.

The standard categories are:

```text
Radarr -> radarr
Sonarr -> sonarr
```

The runtime configuration is generated from `stack.json` and synchronized again at DSM boot.

Radarr and Sonarr are not injected into Decypharr's `arrs` list by the bootstrap. Decypharr discovers those instances natively from the qBittorrent-compatible download clients configured in Radarr and Sonarr. Legacy bootstrap-created `source=config` Radarr/Sonarr entries are removed while unrelated manual Arr entries are preserved.

The expected API state is two auto-discovered instances:

```text
radarr      type=radarr  source=auto
tv-sonarr   type=sonarr  source=auto
```

Verify Decypharr:

```bash
curl -s http://127.0.0.1:8282/version
synopkg status decypharr
```

Inspect the generated configuration:

```bash
/bin/python3 -m json.tool \
  /var/packages/decypharr/var/data/config.json
```

Inspect synchronization logs:

```bash
tail -100 /var/packages/decypharr/var/stack-sync.log
```

## Radarr and Sonarr download clients

Both applications must contain **two** enabled qBittorrent-compatible clients.

### Radarr

Decypharr:

```text
Name     : Decypharr
Host     : NAS address
Port     : 8282
Category : radarr
Priority : 1
```

qBittorrent:

```text
Name     : qBittorrent
Host     : NAS address
Port     : configured qBittorrent port
Category : radarr
Priority : 10
```

### Sonarr

Decypharr:

```text
Name     : Decypharr
Host     : NAS address
Port     : 8282
Category : sonarr
Priority : 1
```

qBittorrent:

```text
Name     : qBittorrent
Host     : NAS address
Port     : configured qBittorrent port
Category : sonarr
Priority : 10
```

The n8n workflow reconciles these clients from `stack.json` and uses the *Arr API `downloadClientId` value to select the client per grab.

## n8n workflow

Workflow name:

```text
PLEX Bootstrap Synology - Orchestrator
```

The workflow handles:

- periodic Plex Watchlist scans;
- multi-user Watchlist reconciliation;
- Radarr and Sonarr creation/monitoring;
- explicit per-release download client selection;
- Decypharr-first routing;
- qBittorrent fallback after explicit Decypharr rejection;
- Decypharr and qBittorrent health checks;
- download-client reconciliation in Radarr and Sonarr;
- completed qBittorrent download handling and seeding protection;
- safe cleanup when items are removed from the Plex Watchlist.

### Routing policy

```text
Release selected
      |
      v
Attempt Decypharr
      |
      +-- accepted ----------------------> Decypharr / AllDebrid
      |
      +-- HTTP 400 or HTTP 409
                |
                v
          qBittorrent fallback

Timeout / unknown network state
      |
      v
No automatic fallback
```

This policy prevents accidental duplicate downloads when the state of the first request is uncertain.

## Prowlarr

Prowlarr centralizes indexers for Radarr and Sonarr.

Open:

```text
http://NAS:9696
```

Configure Radarr and Sonarr as Prowlarr applications using the URLs and API keys stored in `stack.json`.

## Bazarr

Bazarr needs read/write access to the movie and series directories because subtitle files are stored alongside the media.

Open:

```text
http://NAS:6767
```

Configure Radarr and Sonarr using their respective URLs and API keys from `stack.json`, then configure subtitle languages and providers.

## Plex

Open:

```text
http://NAS:32400/web
```

Recommended libraries:

Movies:

```text
/volume1/VideoFactory/_Plex/media/Movies
```

Series:

```text
/volume1/VideoFactory/_Plex/media/Series
```

Plex only requires read access to the media library and the Decypharr mounted content required by the deployment.

## ACL model

The bootstrap applies DSM ACLs for the service accounts.

Typical intent:

| Account | Access |
|---|---|
| PlexMediaServer | Read media and Decypharr mount |
| sc-radarr | Read/write Movies and required download paths |
| sc-sonarr | Read/write Series and required download paths |
| sc-decypharr | Read/write Decypharr data, mount, and downloads |
| sc-qbittorrent | Read/write qBittorrent download directory |
| sc-bazarr | Read/write Movies and Series for subtitles |
| stack.json owner | Read/write stack configuration |
| n8n SMB account | Read-only stack.json access |

Do not solve ACL problems with `chmod 777`. `stack.json` contains credentials and API keys.

## Post-installation validation

Check package state:

```bash
synopkg status PlexMediaServer
synopkg status radarr
synopkg status sonarr
synopkg status prowlarr
synopkg status qbittorrent
synopkg status bazarr
synopkg status decypharr
```

All installed components should report a running state.

Check service URLs:

```text
Plex        http://NAS:32400/web
Radarr      http://NAS:<detected-port>
Sonarr      http://NAS:8989
Prowlarr    http://NAS:9696
Decypharr   http://NAS:8282
qBittorrent http://NAS:<detected-port>
Bazarr      http://NAS:6767
```

## End-to-end test

1. Add a small movie to the Plex Watchlist.
2. Let the n8n workflow reconcile the Watchlist.
3. Confirm Radarr creates or monitors the movie.
4. Confirm the n8n execution reports the chosen download client.
5. Verify the torrent appears in only one download client.
6. When the download completes, verify Radarr imports it into Movies.
7. Confirm Plex detects the imported media.
8. Repeat with a TV episode through Sonarr.

Useful monitoring commands:

```bash
tail -f /var/packages/decypharr/var/logs/*
```

```bash
find /volume1/VideoFactory/_Decypharr \
  -maxdepth 4 \
  \( -type f -o -type l \) \
  2>/dev/null
```

```bash
find /volume1/VideoFactory/_Plex/media \
  -maxdepth 4 \
  \( -type f -o -type l \) \
  2>/dev/null
```

## Maintenance

### Rerun the bootstrap

The bootstrap is intended to be rerunnable:

```bash
./PLEX-bootstrap-Synology.sh
```

Existing installed packages are reused and existing unknown `stack.json` keys are preserved.

### Change the AllDebrid API key

Update `stack.json`, then run:

```bash
/usr/local/etc/rc.d/S99decypharr-stack-sync.sh
```

or restart Decypharr.

### Validate stack.json

```bash
/bin/python3 -m json.tool \
  /volume1/PlexMediaServer/stack.json >/dev/null \
  && echo JSON_OK
```

For an existing/custom deployment, validate the configured `STACK_JSON` path instead.

### Validate the bootstrap itself

```bash
/bin/ash -n PLEX-bootstrap-Synology.sh
```

## Security notes

- Keep `stack.json` private.
- Do not print API keys in workflow execution data.
- n8n only needs read access to `stack.json`.
- The DSM boot synchronization process runs as root and can read the protected file.
- Use explicit DSM ACL entries instead of weakening Unix permissions for the entire share.
- Do not automatically send the same torrent to Decypharr and qBittorrent.

## Version

This document corresponds to **PLEX Bootstrap Synology 8.2**.
