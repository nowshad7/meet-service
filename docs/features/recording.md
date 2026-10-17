# Recording

`MEET_FEATURES=recording` runs Jibri and hands each finished recording to the app.

## What it does

`scripts/meet` adds upstream `jibri.yml` and `compose/recording.yml`, and sets `ENABLE_RECORDING=1`, `ENABLE_SERVICE_RECORDING=1` and `JIBRI_FINALIZE_RECORDING_SCRIPT_PATH=/usr/local/bin/meet-finalize.sh`.
When a recording stops, Jibri runs `services/recording-finalize/finalize.sh` with the recording directory, which holds one mp4 and `metadata.json`.
The script detaches at once so the recorder returns to the pool, then uploads the mp4 with `PUT {MEET_APP_API_URL}/recordings/finished?key=<directory>&meeting_url=<url>`.
The directory name is the idempotency key.
It retries after 30 s, 1, 2, 5 and 7 minutes (about 15 minutes in total); the files are deleted only once the app answers `2xx`.
Progress is logged to `/storage/logs/recording-finalize.log` in the Jibri container.

A failed upload can be re-run by hand from any recorder, since they share the recordings folder:

```bash
scripts/meet compose <name> exec jibri /usr/local/bin/meet-finalize.sh /storage/recordings/<directory>
```

End-to-end encryption makes server-side recording impossible.

Browser-side extras, such as starting a recording automatically when a moderator joins, belong in a deployment's brand as scripts loaded from its `plugin.head.html`.

## Several recorders

One Jibri records one room at a time, so run one per simultaneous recording.
`MEET_RECORDERS=N` (default `1`) in `deployment.env`, or in `.env` on the image path, runs `N` replicas of the `jibri` service; this is upstream's way of running several Jibri instances.
Each replica:

- joins the Jibri brewery under its own nickname, which the image picks at random on every start when `JIBRI_INSTANCE_ID` is unset, so keep `JIBRI_INSTANCE_ID` unset when `MEET_RECORDERS` is above 1;
- writes its generated config and runtime state to its own `/run`, `/tmp` and `/dev/shm`, and only reads the shared `<CONFIG>/jibri` folder;
- records into its own `<session id>/` folder in the shared `/storage/recordings` (`<CONFIG>/storage/jibri/recordings` on the host) and runs the finalize script there, so every recording takes the same upload path whichever replica made it.

Jicofo gives each new recording to an idle recorder; when all are busy, the recording does not start and the moderator is told so.
Its stats (`/stats` on the Jicofo REST port) count the recorders under `jibri_detector`: `count` is how many joined the brewery and `available` how many are idle.
`scripts/meet health <name>` reports `jibri: OK, N/N recorders registered, M available` and fails when fewer than `MEET_RECORDERS` joined; `tests/stack-check.sh` fails when fewer joined than are running.
Apply a new count with `scripts/meet up <name>`, or `docker compose up -d` on the image path.
Lowering it removes replicas even while they record, so change it between classes.

The replicas share `/storage/logs`.
Each Jibri's Java logs get their own file (`log.0.txt`, `log.0.txt.1`, `log.0.txt.2`, and the same for `ffmpeg` and `browser`), while `recording-finalize.log`, `chromedriver.log`, `xorg.log` and `pulse.log` are shared by all of them.
`docker compose logs jibri` prefixes each line with its replica (`jibri-1`, `jibri-2`, ...).

### Host resources per recorder

Each recorder runs Chrome, a virtual display and ffmpeg encoding 1280x720 at 30 fps (`JIBRI_RECORDING_*`).

| Resource | Per recorder |
|---|---|
| Shared memory | `shm_size: 2gb`; the image refuses to start with less, but the host only commits the memory Chrome uses |
| CPU | About one core while recording, more for rooms showing many videos |
| RAM | Under 1 GB measured with one video in the room; plan 2 to 3 GB for full classes |
| Disk | One hour of 720p is about 0.5 to 1 GB, held until the upload succeeds |

Three recorders measured on one host each used 75 to 100 % of a core and 760 to 935 MiB while recording a room with one camera.
For three simultaneous class recordings, plan at least 4 free cores and 6 to 9 GB of RAM beyond the rest of the stack.

## Settings

| Setting | Use |
|---|---|
| `MEET_FEATURES` contains `recording` | Adds the containers and settings above |
| `MEET_RECORDERS` | Recorders, one per simultaneous recording (default `1`) |
| `MEET_APP_API_URL`, `MEET_APP_API_TOKEN` | Upload target and bearer token |
| `JIBRI_*` | Upstream Jibri settings, passed through |

## Contract

[Webhooks](../../contract/README.md#3-webhooks): the recording upload.
Moderators need `context.features.recording` in their join token to start a recording.

## Tests

`tests/finalize-test.sh` covers the upload request, deletion on success, retries and keeping the files on failure.
`tests/run.sh` checks that `deploy/compose.yml` runs `MEET_RECORDERS` recorders and refuses a non-number, and `tests/meet-test.sh` the same setting and the health report in `scripts/meet`.
