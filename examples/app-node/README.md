# Reference app (Node.js)

A minimal app that implements the whole [app contract](../../contract/README.md) with nothing but the Node.js standard library.
Read it as a worked example, then build the same four pieces into your own app in whatever language it uses.

| Contract part | Where |
|---|---|
| Join token: RS256 JWT with `kid`, public key at `{keys URL}/{sha256(kid)}.pem` | `joinClaims`, `signJwt`, `GET /meet/keys/*` |
| Room gate: approve rooms the app issued tokens for, refuse others with a message | `POST /meet/api/conference`, `GET`/`DELETE /meet/api/conference/{id}` |
| Webhooks: bearer-checked, stored, answered fast | `POST /meet/api/events/*`, `PUT /meet/api/recordings/finished` |
| Control calls: signed with a separate control key | `POST /control/{kick-user,allow-user,end-meeting}`, `GET /meet/control-keys/*` |

## Run it

The [localhost example deployment](../../deployments/example/) starts it next to Jitsi:

```bash
scripts/meet init example
scripts/meet up example
```

Then open <http://localhost:3000>.

| Endpoint | Use |
|---|---|
| `GET /` | A form that signs a join token and redirects to the meeting |
| `GET /join?room=&name=&id=&moderator=1&privacy=1` | The same, scriptable |
| `GET /events` | The last 200 webhooks and room gate calls the app received |
| `POST /control/kick-user?room=&user=[&ban=false]` | Remove a user; `ban=false` lets them rejoin at once |
| `POST /control/allow-user?room=&user=` | Lift a ban |
| `POST /control/end-meeting?room=` | End the meeting for everyone |

The `/control/*` and `/events` endpoints have no authentication of their own, so the example publishes the app on `127.0.0.1` only.
In a real app they belong behind your own login and moderator checks.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | required | The deployment's public URL; meeting links point there |
| `JWT_APP_ID` | required | `iss` of every token |
| `MEET_APP_API_TOKEN` | required | Bearer token the service sends on every call |
| `MEET_CONTROL_URL` | `http://127.0.0.1:5280` | Prosody's HTTP port for control calls |
| `XMPP_MUC_DOMAIN` | `muc.meet.jitsi` | Used to build the room JID for control calls |
| `APP_TENANT` | `acme` | Tenant (`sub` claim and first URL segment) |
| `APP_PORT` | `3000` | Listen port |
| `APP_RECORDINGS_DIR` | `$TMPDIR/meet-recordings` | Where uploaded recordings are written |

## What a real app does differently

- Keeps the private keys in a secret store and rotates them by publishing a new `kid` next to the old one.
  This example generates fresh key pairs at every start.
- Decides who may join which room and as what from its own data, instead of trusting query parameters.
- Approves rooms from its schedule in a database; this example keeps issued rooms in memory, so after a restart old links are refused by the room gate.
- Stores webhooks under a unique key and processes them asynchronously, since the same event can arrive twice.

## Tests

```bash
node --test examples/app-node/app.test.mjs
```

The tests check token signatures against the served keys, room gate answers, webhook authentication, recording storage and that control calls are signed with the control key, never the join key.
