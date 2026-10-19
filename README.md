# PLEX Bootstrap Synology

**Install and configure a native Synology DSM 7.x Plex media stack with one command.**

PLEX Bootstrap Synology v8.3 manages Plex Media Server, Radarr, Sonarr, Prowlarr, Decypharr, qBittorrent and Bazarr. An n8n orchestration workflow is provided separately for Plex Watchlists and download routing.

> **Before you run it:** This script installs packages and changes local service configuration, directories and DSM permissions. Review the [bootstrap script](./PLEX-bootstrap-Synology.sh) if you are not familiar with it, and back up any existing configuration.

## Quick installation: one line

Connect to the **Synology NAS itself** over SSH with a DSM administrator account that can run **sudo**. From a writable, trusted directory, paste this **single line**:

~~~sh
curl -fsSL https://raw.githubusercontent.com/floppy69/synoplex_bootstrap/main/PLEX-bootstrap-Synology.sh -o PLEX-bootstrap-Synology.sh && /bin/sh -n PLEX-bootstrap-Synology.sh && sudo /bin/sh PLEX-bootstrap-Synology.sh
~~~

The command downloads the current main-branch script, checks its shell syntax and launches the interactive installer with administrator privileges. It saves the downloaded script locally so it can be inspected and run again.

**Do not use a direct pipe such as curl | sh.** The bootstrap reads its answers from standard input; piping the downloaded script into a shell would consume that input and can turn the installation into non-interactive mode.

Follow the prompts to confirm the NAS address, installation paths, package choices, ports, the DSM account used by n8n and the AllDebrid API key. Press Enter to accept detected or suggested values. Secrets entered through the interactive key prompt are not echoed.

If Plex cannot be installed through the DSM package catalog, install the official Plex package using DSM Package Center and run the same command again.

### Requirements

- Synology **DSM 7.x**, with SSH enabled.
- A DSM account authorized to use **sudo**.
- Network access to GitHub and to the relevant package sources.
- **curl** available on the NAS.
- The **SynoCommunity** package source for missing community packages.
- A valid **AllDebrid API key** for a new Decypharr configuration.
- FUSE support for the Decypharr mount. Python 3 is needed for JSON operations; the bootstrap attempts to find or install a suitable runtime.

Run this **on the NAS**, not inside the n8n Docker container or on a separate Linux machine.

## What the bootstrap configures

| Component | Purpose | Typical port |
| --- | --- | ---: |
| Plex Media Server | Movies and TV libraries | 32400 |
| Radarr | Movie management | 7878 |
| Sonarr | TV series management | 8989 |
| Prowlarr | Indexer management | 9696 |
| Decypharr | AllDebrid-backed, qBittorrent-compatible client | 8282 |
| qBittorrent | Secondary/fallback download client | 8095 |
| Bazarr | Subtitles | 6767 |

These are **defaults**, not a claim about your existing setup. The bootstrap detects existing Radarr, Sonarr, Prowlarr and qBittorrent ports where possible. For example, a Radarr installation already using port 8310 is not supposed to be reset to 7878.

The installer:

1. Detects DSM, hardware architecture, installed packages and existing configuration.
2. Installs missing packages where compatible sources are available, or reuses installed packages.
3. Initializes or safely merges the configuration file, preserving unknown JSON keys.
4. Creates the Watchlist state file if it does not exist.
5. Prepares media/download directories and applies restricted DSM ACLs.
6. Configures Decypharr from the central configuration, including optional DSM boot synchronization.
7. Configures the Decypharr download client in Radarr and Sonarr where the APIs are reachable.

Decypharr 2.7 or newer is the default target for v8.3. Existing older Decypharr installations can be upgraded when a compatible package is available.

## Default paths

For a **new installation**, the default state location is the Plex-created shared folder on the first detected storage volume:

~~~text
/volume1/
├── PlexMediaServer/
│   ├── stack.json
│   ├── watchlist-state.json
│   └── decypharr/
│       ├── mount/
│       └── downloads/
└── VideoFactory/
    └── _Plex/
        ├── media/
        │   ├── Movies/
        │   └── Series/
        └── downloads/
            └── qbittorrent/
~~~

Other volume numbers are supported. Plex must create its shared folder before it can be used as the default state root.

**Existing deployments are not automatically migrated.** A previous configuration in /volumeX/VideoFactory/_Plex/stack.json or /volumeX/VideoFactory/_Plex/_Config/stack.json is detected and reused. Explicit path environment variables override automatic detection.

### Central configuration

**stack.json** is the source of truth for paths, service endpoints, API keys and Decypharr settings. The generated Decypharr runtime file lives at:

~~~text
/var/packages/decypharr/var/data/config.json
~~~

When enabled, the DSM boot synchronization hook is:

~~~text
/usr/local/etc/rc.d/S99decypharr-stack-sync.sh
~~~

Do not edit the generated Decypharr runtime file as the permanent source of configuration: synchronization can overwrite it.

## n8n orchestration (separate setup)

The repository includes [PLEX Bootstrap Synology - Orchestrator.json](./PLEX%20Bootstrap%20Synology%20-%20Orchestrator.json).

**The one-line installer does not install n8n or automatically import this workflow.** After installing the NAS services:

1. Import the JSON workflow into your existing n8n instance.
2. Configure the n8n credentials, connections and scheduling for your environment.
3. Mount or otherwise expose the **actual directory containing stack.json** to n8n with read-only access for the configuration file.
4. Verify the workflow reads that exact path, then test one movie and one TV episode from Plex Watchlists.

**Important for new installations:** If stack.json is at /volume1/PlexMediaServer/stack.json, an SMB mount exposing only /volume1/VideoFactory **will not contain that file**. Adjust the n8n mount/path or explicitly choose a configuration path accessible to the workflow. Do not weaken permissions or publish API keys to make it work.

The intended orchestration is:

~~~text
Plex Watchlist
      |
      v
     n8n
      |
      v
Radarr / Sonarr <---- Prowlarr
      |
      +--> Decypharr --> AllDebrid
      |
      +--> qBittorrent (fallback)
      |
      v
   Plex libraries
~~~

Radarr and Sonarr can have both download clients configured. The n8n workflow selects the appropriate client per grab. It should use qBittorrent as a fallback only after an explicit Decypharr rejection, **not after an ambiguous timeout**, to avoid duplicate downloads.

Use the categories **radarr** and **sonarr** for their corresponding applications; do not substitute tv-sonarr unless your configuration explicitly requires it.

## After installation

The installer prints the detected service URLs, configuration paths and package status. Check the services from an SSH session on the NAS:

~~~sh
sudo synopkg status PlexMediaServer
sudo synopkg status radarr
sudo synopkg status sonarr
sudo synopkg status prowlarr
sudo synopkg status qbittorrent
sudo synopkg status bazarr
sudo synopkg status decypharr
curl -fsS http://127.0.0.1:8282/version
~~~

The default Plex URL is **http://NAS-IP:32400/web**. Use the IP address and ports reported by your installation for the other interfaces.

Once the n8n workflow is configured, test one Plex Watchlist movie and one series episode. Confirm the selected client receives the grab only once, Radarr/Sonarr import the completed media, and Plex detects the result.

If a package is missing or failed, inspect the final bootstrap report and the related installation logs under /tmp/plex-bootstrap-synology.

## Updating or rerunning

Run the **same one-line command** from the Quick installation section whenever you want to download the latest main-branch bootstrap and rerun it. The script is designed to preserve existing paths and configuration where possible, but it can install packages, upgrade Decypharr and reconcile managed settings. Make a backup before rerunning it on a production NAS.

To run the script you already downloaded, without fetching a new copy:

~~~sh
sudo /bin/sh ./PLEX-bootstrap-Synology.sh
~~~

To prevent an automatic Decypharr upgrade on a rerun:

~~~sh
sudo env UPGRADE_DECYPHARR=0 /bin/sh ./PLEX-bootstrap-Synology.sh
~~~

The bootstrap also supports environment overrides such as STACK_JSON, WATCHLIST_STATE, DECYPHARR_ROOT and NAS_IP. For unattended runs, set INTERACTIVE=0 **and provide all required configuration and secrets securely**. The default quick-install command intentionally remains interactive.

## Security

- Treat stack.json as a **secret**. It contains API keys and must not be world-readable.
- The installer uses ownership and DSM ACLs to grant the required service accounts access. Never solve permissions problems with chmod 777.
- Give n8n read-only access to stack.json, not unrestricted access to the NAS.
- Keep secrets out of shell history, Git commits and n8n execution logs.
- The one-line command executes code from the main branch with elevated permissions. Use the manual review method below when you need to inspect or pin the script before running it.

### Manual download and review

~~~sh
curl -fsSL https://raw.githubusercontent.com/floppy69/synoplex_bootstrap/main/PLEX-bootstrap-Synology.sh -o PLEX-bootstrap-Synology.sh
/bin/sh -n PLEX-bootstrap-Synology.sh
less PLEX-bootstrap-Synology.sh
sudo /bin/sh PLEX-bootstrap-Synology.sh
~~~

## Files

- [PLEX-bootstrap-Synology.sh](./PLEX-bootstrap-Synology.sh): DSM 7 bootstrap, v8.3.
- [PLEX Bootstrap Synology - Orchestrator.json](./PLEX%20Bootstrap%20Synology%20-%20Orchestrator.json): n8n workflow.
- [README.md](./README.md): installation, configuration and verification.

---

**Supported target:** Synology DSM 7.x. **Bootstrap version:** 8.3. **Decypharr minimum target:** 2.7.
