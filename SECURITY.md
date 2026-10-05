# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.
Report them privately through GitHub's [private vulnerability reporting](https://github.com/nowshad7/meet-service/security/advisories/new) for this repository.

Include what you found, how to reproduce it and which version or commit you tested.
You will get an answer within a week, and a fix or a plan as soon as the problem is confirmed.
Please give us a reasonable time to release a fix before you disclose it.

## Scope

In scope: the Prosody plugins, config fragments, scripts, compose overrides, web defaults, contract and reference app in this repository.

Vulnerabilities in Jitsi Meet, Prosody, Jicofo, the videobridge or Jibri themselves belong upstream; see [Jitsi's security policy](https://jitsi.org/security/).
If you are unsure where a problem belongs, report it here and we will help route it.

## Supported versions

Security fixes go into the latest release.
Keep deployments on the latest release tag and the Jitsi version it pins.

## Hardening checklist for operators

- Use `AUTH_TYPE=jwt` with `JWT_ALLOW_EMPTY=0` and `ENABLE_GUESTS=0` unless you really want anonymous rooms.
- Use a control key pair that is different from the join key pair, and keep its private key on the app server only.
- Never publish Prosody's ports, Jicofo's REST port or JVB's private port; see [docs/deploy.md](docs/deploy.md#firewall).
- Use HTTPS for `MEET_APP_*` URLs whenever they leave the host.
- Keep `secrets.env` out of version control.
