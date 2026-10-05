# Deploying

There are two ways to run a deployment, and both start from one folder of settings.

- **Published images (recommended for servers).**
  Every release publishes `ghcr.io/nowshad7/meet-<service>:<version>` images with the plugins, config fragments, web defaults and scripts built in.
  The server needs only Docker, a compose file and the deployment folder; no clone of this repository and no `docker-jitsi-meet` checkout.
  See [Deploy from published images](#deploy-from-published-images).
- **A checkout of this repository.**
  `scripts/meet` runs the stock Jitsi images and mounts the plugins and config from the checkout.
  This is the contributor path and what the localhost example uses; the rest of this page describes it unless a section says otherwise.
  Requirements on the host: Linux with Docker and Compose v2, git, openssl and bash.

## Try it on localhost

`deployments/example/` runs on `https://localhost:8443` together with the [reference app](../examples/app-node/README.md) on `http://localhost:3000`.
`scripts/meet init example` and `scripts/meet up example` start it, as in [Develop from a checkout](../README.md#develop-from-a-checkout).
The [README quick start](../README.md#quick-start-localhost-published-images) runs the same localhost setup on the published images.

The example sets `JVB_ADVERTISE_IPS=127.0.0.1`, so only browsers on the same machine get media.
To test from another device on your network, add the host's LAN address, for example `JVB_ADVERTISE_IPS=127.0.0.1,192.168.1.20`, and open `https://192.168.1.20:8443` there after changing `PUBLIC_URL` to match.

## Deploy from published images

A release tag `vX.Y.Z` publishes six images, all built on the same pinned Jitsi release (`UPSTREAM_VERSION`) and tagged `X.Y.Z` and `latest`:

| Image | Built on | Adds |
|---|---|---|
| `meet-prosody` | `ghcr.io/jitsi/prosody` | The `mod_meet_*` plugins in `/prosody-plugins/` and the `prosody/conf.d/` fragments |
| `meet-web` | `ghcr.io/jitsi/web` | `custom-config.js`, `nginx-custom/`, the default brand and the landing page |
| `meet-jicofo` | `ghcr.io/jitsi/jicofo` | `JICOFO_ENABLE_REST=1` |
| `meet-jvb` | `ghcr.io/jitsi/jvb` | Nothing; published so one version pins every service |
| `meet-jibri` | `ghcr.io/jitsi/jibri` | The recording finalize script, set as `JIBRI_FINALIZE_RECORDING_SCRIPT_PATH` |
| `meet-app-proxy` | `nginx:alpine` | The app proxy config |

Nothing upstream is patched: the images only add files, and a small start-up step copies the config defaults to where the upstream start-up scripts already look for `/config` overrides.
The images appear on GHCR with the first release tag, `v1.0.0`; until then, build them locally as described in [upgrade.md](upgrade.md#cutting-a-release).

### The deployment folder

[deploy/](../deploy/) is the template for one deployment:

```text
acme/
  compose.yml           deploy/compose.yml from the release you run, unchanged
  .env                  settings, from deploy/env.example; commit it to your private repository
  secrets.env           generated once on the server, never committed
  brand/                files that replace or add to the default brand
  compose.override.yml  optional: your own mounts, for example lang/main.json or landing/
  data/                 runtime data (CONFIG), created on the server
```

### Set it up

1. Copy `deploy/` at the release tag you want and fill `.env`:

   ```bash
   mkdir acme && cd acme
   base=https://raw.githubusercontent.com/nowshad7/meet-service/v1.0.0/deploy
   curl -fsSL -O "$base/compose.yml" -O "$base/secrets.env.example"
   curl -fsSL "$base/env.example" -o .env
   mkdir brand
   $EDITOR .env
   ```

   Set `MEET_VERSION` to the release (`1.0.0`) and `COMPOSE_PROJECT_NAME`, then the same settings as any deployment (see [Settings](#settings)).
2. Generate the secrets once:

   ```bash
   while IFS= read -r line; do [[ $line == *= ]] && line+=$(openssl rand -hex 24); echo "$line"; done \
     <secrets.env.example >secrets.env && chmod 600 secrets.env
   ```

3. Create the data tree for the user the images run as (uid 1000):

   ```bash
   mkdir -p data/{web,jicofo,jvb,jibri} data/prosody/{config,prosody-plugins-custom} \
     data/storage/{web,prosody,transcripts,jibri/logs,jibri/recordings} data/tmp/web-load-test
   sudo chown -R 1000:1000 data
   ```

4. Start it:

   ```bash
   docker compose up -d
   docker compose ps
   ```

Every `docker compose` command works from the folder as usual: `logs -f prosody`, `restart web`, `down` (never `down -v`, it deletes all Jitsi state).
From any checkout of this repository, `tests/stack-check.sh --dir /path/to/acme` checks health and that every plugin in `MEET_PLUGINS` is loaded and answering.

### Settings for the image path

`.env` takes the same settings as a `deployment.env`, with three differences, because no `scripts/meet` runs to derive anything:

| Instead of | Set in `.env` |
|---|---|
| `MEET_FEATURES=recording` | `COMPOSE_PROFILES=recording`, `ENABLE_RECORDING=1`, `ENABLE_SERVICE_RECORDING=1` |
| `MEET_FEATURES=app-proxy` | `COMPOSE_PROFILES=app-proxy` and `MEET_APP_PROXY_HOST` (both features: `COMPOSE_PROFILES=recording,app-proxy`) |
| `scripts/meet` deriving the plugin settings | The derived values themselves, per plugin below |

| `MEET_PLUGINS` entry | Also set |
|---|---|
| `events` | `MEET_EVENTS=1` |
| `room-gate` | `PROSODY_RESERVATION_ENABLED=1`, `PROSODY_RESERVATION_REST_BASE_URL=${MEET_APP_API_URL}` |
| `control` | `muc_end_meeting,meet_control` appended to `XMPP_MODULES` |
| `single-session` | `meet_single_session` appended to `XMPP_MUC_MODULES` |
| `privacy` | `meet_privacy` appended to `XMPP_MUC_MODULES` |
| `AUTH_TYPE=jwt` | `JWT_ASAP_KEYSERVER=${MEET_APP_KEYS_URL}` and `XMPP_MUC_CONFIGURATION` as in `env.example` |

Keep `MEET_PLUGINS` itself in `.env`: the stack check reads it to know what must be loaded, which catches a plugin listed there but missing from the derived settings.
`scripts/meet env <name>` in a checkout prints the derived values for an existing `deployment.env`, which is the quickest way to move a deployment to the image path.
`.env` values may refer to earlier ones with `${NAME}`.
`MEET_IMAGE_REPO` (default `ghcr.io/nowshad7`) points at another registry, for example a fork's.

### Brand, landing page and language

- **Brand.**
  The default brand is built into `meet-web`.
  At start-up the container copies it to a working folder and then copies the deployment's `brand/` (mounted at `/meet/brand`) over it, so a deployment replaces or adds files by name, exactly as with `scripts/meet`.
  After changing a brand file, run `docker compose restart web`.
- **Landing page and language strings.**
  Mount them with `compose.override.yml`, which Compose reads automatically:

  ```yaml
  services:
    web:
      volumes:
        - ./landing:/usr/share/jitsi-meet/static/landing:ro
        - ./lang/main.json:/usr/share/jitsi-meet/lang/main.json:ro
  ```

A file in the data folder takes precedence over the built-in default of the same name, for example `data/web/custom-config.js` or `data/prosody/config/conf.d/meet.cfg.lua`.
An empty one would silently switch the defaults off, so the containers refuse to start with a message naming it.
This happens when a data folder that `scripts/meet` used is reused: Docker leaves empty files behind where it mounted single files.
Delete them once when you move such a deployment to the images:

```bash
rm -f data/web/custom-config.js data/web/custom-interface_config.js \
  data/prosody/config/conf.d/meet.cfg.lua data/prosody/config/conf.d/meet-events.cfg.lua
```

### Upgrade and roll back

Set `MEET_VERSION` to the new release, read its notes, replace `compose.yml` with the one from the same tag if it changed, and run `docker compose up -d`.
Rolling back is the same with the previous version.
See [upgrade.md](upgrade.md#deployments-on-published-images).

## A new deployment from a checkout

1. Create the folder from the template:

   ```bash
   scripts/meet new-deployment acme
   $EDITOR deployments/acme/deployment.env
   ```

   Start from [deployments/example-production/deployment.env](../deployments/example-production/deployment.env) for a public server with a domain and Let's Encrypt.
   Put branding in `deployments/acme/brand/` (see [Branding and wording](#branding-and-wording)).
2. On the server, clone this repository at a release tag, bring your deployment folder along and run:

   ```bash
   scripts/meet init acme      # fills empty secrets once, creates .data/acme, fetches upstream
   scripts/meet up acme
   scripts/meet health acme
   tests/stack-check.sh acme
   ```

3. Give the app team the values from [the contract](../contract/README.md#settings-agreed-per-deployment), including `MEET_APP_API_TOKEN` from `deployments/acme/secrets.env`.

### Keeping deployments outside this repository

Only `deployments/_template/` and the shipped examples are tracked; everything else under `deployments/` is gitignored.
To version your real deployments, keep them in a private repository or folder and point `MEET_DEPLOYMENTS_DIR` at it:

```bash
export MEET_DEPLOYMENTS_DIR=/srv/meet-deployments   # a private git repository, for example
scripts/meet new-deployment acme                    # creates /srv/meet-deployments/acme
scripts/meet up acme
```

A relative `MEET_DEPLOYMENTS_DIR` is resolved from the current directory.
The default is `deployments/` in this repository.
Every command reads the deployment from that folder, including its `compose.yml`, `brand/` and `secrets.env`; keep `secrets.env` out of git there too.

## Commands

| Command | What it does |
|---|---|
| `scripts/meet new-deployment <name>` | Copies `deployments/_template/` to `<deployments>/<name>/` |
| `scripts/meet init <name>` | Creates `secrets.env` from `secrets.env.example`, fills only empty values, creates the data tree, fetches upstream |
| `scripts/meet up <name> [service...]` | Builds the brand directory and starts the deployment; extra arguments go to `docker compose up -d` |
| `scripts/meet down <name>` | Stops it; `-v` is refused because it deletes all Jitsi state |
| `scripts/meet health <name>` | Container state, Prosody and JVB health, an operational bridge in Jicofo |
| `scripts/meet logs <name> [args]` | `docker compose logs` for the deployment, e.g. `logs acme -f prosody` |
| `scripts/meet env <name>` | Prints the derived upstream settings and compose files, never secrets |
| `scripts/meet compose <name> [args]` | Any other `docker compose` command, e.g. `compose acme restart web` |
| `scripts/meet upgrade-check`, `upgrade <tag>` | See [upgrade.md](upgrade.md) |

The compose project is `meet-<name>`.
Runtime data goes to `.data/<name>/` unless `CONFIG` is set in `deployment.env`.
As root, `init` hands the data tree to uid 1000, the user the images run as; as any other user it makes the tree world-writable, which is only acceptable on a development machine.

## Settings

`deployment.env` holds everything except secrets.
It takes any [docker-jitsi-meet variable](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker) (ports, `PUBLIC_URL`, `ENABLE_*`, `TOOLBAR_BUTTONS`, ...) plus these:

| Setting | Meaning |
|---|---|
| `MEET_FEATURES` | Optional containers: `recording`, `app-proxy` |
| `MEET_PLUGINS` | `events`, `room-gate`, `control`, `single-session`, `privacy` |
| `MEET_APP_API_URL` | Base URL of the app's endpoints (room gate, webhooks, recordings) |
| `MEET_APP_KEYS_URL` | Join-token public keys; becomes `JWT_ASAP_KEYSERVER` and the MUC `asap_key_server` |
| `MEET_APP_CONTROL_KEYS_URL` | Control-token public keys, for `control` |
| `MEET_APP_PROXY_HOST`, `MEET_APP_PROXY_ALIAS` | For `app-proxy`: the host name of the app on the docker host, and the name Prosody uses for it (default `app.internal`) |
| `MEET_CONTROL_BIND`, `MEET_CONTROL_PORT` | Where Prosody's HTTP port is published for control calls (default `127.0.0.1:5280`) |
| `MEET_TEXT_REMOVED`, `MEET_TEXT_PRIVATE_CHAT_ONLY`, `MEET_TEXT_PUBLIC_CHAT_OFF`, `MEET_TEXT_SEAT_REPLACED` | Optional wording for the notices users see; the defaults say "meeting" and "moderators" |
| `XMPP_MODULES`, `XMPP_MUC_MODULES` | Upstream modules to load; `scripts/meet` appends the plugins according to `MEET_PLUGINS` |

Do not set `JWT_ASAP_KEYSERVER`, `PROSODY_RESERVATION_*`, `ENABLE_RECORDING`, `JIBRI_FINALIZE_RECORDING_SCRIPT_PATH` or `JICOFO_ENABLE_REST`: `scripts/meet` derives them from the settings above.
`scripts/meet env <name>` shows the result.

`secrets.env` lives only on the server and is gitignored.
`secrets.env.example` lists the names: the XMPP component passwords and `MEET_APP_API_TOKEN`.
`init` generates any that are empty and never overwrites a value; regenerating XMPP passwords on a live stack would desync Prosody from Jicofo and JVB.

## TLS

HTTPS is the only working entry point: Jitsi builds its WebSocket URL from `PUBLIC_URL`, and browsers only grant camera and microphone on secure origins.

**Let's Encrypt.**
Point the domain's DNS at the server, open port 80 and set:

```bash
PUBLIC_URL=https://meet.example.org
HTTP_PORT=80
HTTPS_PORT=443
ENABLE_LETSENCRYPT=1
LETSENCRYPT_DOMAIN=meet.example.org
LETSENCRYPT_EMAIL=ops@example.org
LETSENCRYPT_ACME_SERVER=letsencrypt
ENABLE_HTTP_REDIRECT=1
```

The web container requests and renews the certificate itself.
Without `LETSENCRYPT_ACME_SERVER=letsencrypt`, upstream's acme.sh uses its own default certificate authority.
Use `LETSENCRYPT_USE_STAGING=1` while you test, to stay clear of rate limits.

**Your own certificate.**
Leave `ENABLE_LETSENCRYPT=0`, copy the full chain and key into `<CONFIG>/web/keys/` (default `.data/<name>/web/keys/`) and restart the web container:

```bash
mkdir -p .data/acme/web/keys
cp fullchain.pem .data/acme/web/keys/cert.crt
cp privkey.pem   .data/acme/web/keys/cert.key
scripts/meet compose acme restart web
```

Repeat that whenever the certificate is renewed.

**Behind a reverse proxy or load balancer** that terminates TLS, forward to `HTTPS_PORT` (or set `DISABLE_HTTPS=1` and forward to `HTTP_PORT`), keep `PUBLIC_URL` on the public `https://` address and pass WebSocket upgrades through.

## Firewall

| Port | Protocol | Open to | Purpose |
|---|---|---|---|
| `HTTPS_PORT` (443) | TCP | Everyone | Web app, signalling over WebSocket |
| `HTTP_PORT` (80) | TCP | Everyone | Redirect to HTTPS and Let's Encrypt challenges |
| `JVB_PORT` (10000) | UDP | Everyone | Audio and video |
| `MEET_CONTROL_PORT` (5280) | TCP | The app servers only | Control calls; see below |

Everything else stays closed: Prosody's 5222, 5269 and 5347, Jicofo's REST port (`JICOFO_REST_PORT`, loopback), JVB's private port (`JVB_COLIBRI_PORT`, loopback) and Jibri's API.
On a cloud host, set `JVB_ADVERTISE_IPS` to the public address; behind NAT, list both the public and the private address.

## Control port for an app on another host

Control calls (`/kick-user`, `/allow-user`, `/end-meeting`) go to Prosody's HTTP port, which listens on `127.0.0.1:5280` by default.
That is enough when the app runs on the same host.
When it runs elsewhere, pick one:

1. **Private network (simplest).**
   Bind the port to the server's private address, `MEET_CONTROL_BIND=10.0.0.5`, and allow only the app servers to reach it in the firewall.
2. **TLS reverse proxy.**
   Keep the loopback bind and publish a separate HTTPS virtual host (nginx, Caddy, a load balancer) that forwards only `POST /kick-user`, `/allow-user` and `/end-meeting` to `127.0.0.1:5280`, restricted to the app's addresses.
3. **Tunnel.**
   Reach the loopback port through WireGuard, an SSH tunnel or your cloud's private link.

Never publish 5280 to the internet: the control token protects the calls, but Prosody's HTTP port serves more than these routes.

## Branding and wording

`web/brand/` is the default brand: `branding.json` (Jitsi dynamic branding palette and logo), `brand.css`, `logo.svg`, `custom-interface_config.js` (app name and display names), `plugin.head.html` (included at the end of every page's `<head>`) and `close.html` (shown when a meeting ends).
`scripts/meet up` copies it to `.data/<name>/meet/brand/` and then copies `<deployment>/brand/` over it, so a deployment replaces or adds files by name.
Everything in the result is served at `/static/brand/`.
After changing a brand file, run `scripts/meet up <name>`: static files update in place, and `custom-interface_config.js` also needs `scripts/meet compose <name> restart web`.

An LMS deployment, for example, could ship:

```text
deployments/campus/
  deployment.env        MEET_TEXT_* below
  brand/
    logo.svg            replaces the default logo
    branding.json       its own palette
    custom-interface_config.js   APP_NAME = 'Campus Live'
    close.html          "Class ended. You can close this tab."
  lang/main.json        its own English strings
  compose.yml           mounts lang/main.json
```

The notices the plugins send are plain settings:

```bash
MEET_TEXT_REMOVED="An instructor removed you from this class."
MEET_TEXT_PRIVATE_CHAT_ONLY="In this class, messages go to the instructor and TAs only."
MEET_TEXT_PUBLIC_CHAT_OFF="Class chat is off for learners. Send a private message instead."
MEET_TEXT_SEAT_REPLACED="You joined this class from another tab or device."
```

To change Jitsi's own interface strings, copy `lang/main.json` from the `ghcr.io/jitsi/web` image of the pinned release, edit it, keep it in the deployment and mount it with a deployment `compose.yml`:

```bash
docker run --rm --entrypoint cat ghcr.io/jitsi/web:$(cat UPSTREAM_VERSION) \
  /usr/share/jitsi-meet/lang/main.json > deployments/campus/lang/main.json
```

```yaml
services:
  web:
    volumes:
      - ${MEET_DEPLOYMENT_DIR}/lang/main.json:/usr/share/jitsi-meet/lang/main.json:ro
```

`scripts/meet` passes a deployment's `compose.yml` last, so it can add or override anything a brand file cannot express; `${MEET_DEPLOYMENT_DIR}` points at the deployment folder and `${MEET_ROOT}` at this repository.
Regenerate a copied `main.json` on every Jitsi upgrade (see [upgrade.md](upgrade.md)).

## Development notes

- Keep `ENABLE_P2P=0` so two-person calls exercise the bridge like production does.
- On a host without internet access set `JVB_DISABLE_STUN=1` and list the host addresses in `JVB_ADVERTISE_IPS`.
- Set `ENABLE_HSTS=0` while you use a self-signed certificate, or browsers remember to refuse it.
