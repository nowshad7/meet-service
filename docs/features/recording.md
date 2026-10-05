# Recording

`MEET_FEATURES=recording` runs Jibri and hands each finished recording to the app.

## What it does

`scripts/meet` adds upstream `jibri.yml` and `compose/recording.yml`, and sets `ENABLE_RECORDING=1`, `ENABLE_SERVICE_RECORDING=1` and `JIBRI_FINALIZE_RECORDING_SCRIPT_PATH=/usr/local/bin/meet-finalize.sh`.
When a recording stops, Jibri runs `services/recording-finalize/finalize.sh` with the recording directory, which holds one mp4 and `metadata.json`.
The script detaches at once so the recorder returns to the pool, then uploads the mp4 with `PUT {MEET_APP_API_URL}/recordings/finished?key=<directory>&meeting_url=<url>`.
The directory name is the idempotency key.
It retries after 30 s, 1, 2, 5 and 7 minutes (about 15 minutes in total); the files are deleted only once the app answers `2xx`.
Progress is logged to `/storage/logs/recording-finalize.log` in the Jibri container.

A failed upload can be re-run by hand:

```bash
scripts/meet compose <name> exec jibri /usr/local/bin/meet-finalize.sh /storage/recordings/<directory>
```

One Jibri records one room and needs about 2 to 3 GB of RAM, so run one Jibri per concurrent recording: `scripts/meet up <name> --scale jibri=N`.
End-to-end encryption makes server-side recording impossible.

Browser-side extras, such as starting a recording automatically when a moderator joins, belong in a deployment's brand as scripts loaded from its `plugin.head.html`.

## Settings

| Setting | Use |
|---|---|
| `MEET_FEATURES` contains `recording` | Adds the containers and settings above |
| `MEET_APP_API_URL`, `MEET_APP_API_TOKEN` | Upload target and bearer token |
| `JIBRI_*` | Upstream Jibri settings, passed through |

## Contract

[Webhooks](../../contract/README.md#3-webhooks): the recording upload.
Moderators need `context.features.recording` in their join token to start a recording.

## Tests

`tests/finalize-test.sh` covers the upload request, deletion on success, retries and keeping the files on failure.
