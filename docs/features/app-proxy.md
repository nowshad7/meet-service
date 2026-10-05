# App proxy

`MEET_FEATURES=app-proxy` lets Prosody reach an app that runs on the docker host behind a name-based virtual host.

## What it does

Prosody's DNS resolver ignores `/etc/hosts`, so `extra_hosts` alone cannot reach a name-based vhost on the host.
`compose/app-proxy.yml` runs nginx on the deployment's network under the alias `MEET_APP_PROXY_ALIAS` and forwards everything to `MEET_APP_PROXY_HOST` on the docker host with the right `Host` header.
It allows unbuffered request bodies of any size and 600 second timeouts, for recording uploads.
Point `MEET_APP_API_URL` and the key URLs at `http://<MEET_APP_PROXY_ALIAS>/...`.

Production apps on their own hosts do not need it.

## Settings

| Setting | Use |
|---|---|
| `MEET_APP_PROXY_HOST` | Host name of the app's vhost on the docker host |
| `MEET_APP_PROXY_ALIAS` | Name Prosody and Jibri use; default `app.internal` |

## Tests

`tests/meet-test.sh` checks that the compose file is added.
