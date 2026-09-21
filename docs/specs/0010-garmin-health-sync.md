---
id: 0010-garmin-health-sync
state: DRAFT
attempt: 0
max_attempts: 3
branch: feat/0010-garmin-health-sync
delivery: manual
acceptance: []
failures: []
---

# 0010 - Garmin health sync (ingester + token lifecycle)

> **Delivery track: manual, NOT `/implement-spec`.** Every other spec here is TypeScript on the
> NestJS bot, verified over HTTP against the isolated test Cloud Function
> ([README.md](README.md)). This one is a **separate Python service** with an **external credential**
> and a **live external dependency** (Garmin's servers). The `spec-verifier` cannot log into Garmin,
> has no credentials, and drives only the test function over HTTP - so it cannot run these acceptance
> criteria, and this spec must never be marked `READY` for the unattended pipeline. It is built and
> verified by hand. `state` stays `DRAFT`; the `delivery: manual` flag marks it. The acceptance
> criteria below are real, but they are **manual/local checks**, written to be run by you (or Claude
> locally, with your Garmin credentials), not by the pipeline.
>
> **Before you start (manual gate):** a manual track has no pipeline gate, so implementation needs
> the owner's explicit go-ahead. This is the human checkpoint - Claude must **notify the owner and
> wait for confirmation** before building any of this; do not begin on seeing the spec alone.

## Context

We proved in a POC that Garmin's daily wellness data - sleep, HRV, stress, body battery, resting
heart rate, steps - plus activities can be pulled with the unofficial `garminconnect` library, and
that a token minted by one interactive login keeps working for later unattended runs. This is the
data most useful for the eventual **symptom correlation** idea
([../architecture.md:638](../architecture.md#L638)), and it is exactly the data Strava cannot give
(Strava is workout-only). Garmin has no free self-serve API, so the unofficial library is the only
practical path, and this spec captures its whole lifecycle so the fragile parts are decided once.

This spec makes the Garmin data **exist** in Firestore on a daily schedule, with a secure token
model, a local re-auth tool, and a quiet-until-broken failure alert. It does **not** analyze or
correlate that data - correlation waits on symptoms (phase 3), see Out of scope.

Two facts we established by testing the live token, which the whole design leans on:

- **The access token lasts ~22 h; the refresh token rotates on every use but the old one keeps
  working** (non-strict rotation, verified). Therefore a stored token survives the ingester's daily
  refreshes with **no write-back** - GCP can be strictly read-only on the token.
- **Fresh login is IP-rate-limited** (we hit a `429` on the SSO login endpoint). Token *refresh* is
  not. So login happens rarely and locally; the cloud only ever refreshes.

## Delivery track (why manual, and how it is built)

Built by hand, in this order (each step independently checkable):

1. **Token lifecycle + local re-auth tool** - seed `GARMIN_TOKEN` in Secret Manager.
2. **Ingester core** - read token (read-only), pull one day, write Firestore idempotently.
3. **Alerting** - the notify-once-on-failure logic and its dedup state.
4. **Schedule + deploy** - Cloud Run job + Cloud Scheduler, kept off the bot's deploy.

Verification is the manual acceptance criteria below, run locally against your real Garmin account
and the `notes` Firestore. No `testing` branch, no test Cloud Function, no reply reflection.

## Scope

A **new, self-contained Python service** in a new top-level directory, plus one repo-root change to
keep it out of the bot's deploy. The implementer may touch only these:

- `garmin-ingester/` (new) - Python 3.13. Files:
  - `ingester.py` - the job entrypoint: resolve dates, pull, write, alert, exit.
  - `garmin_client.py` - thin wrapper over `garminconnect`: `login_from_token(token_json)` and typed
    getters returning normalized dicts. Named for the outcome, so swapping the underlying library
    touches one file (same discipline as `TranscriptionService`,
    [../../CLAUDE.md](../../CLAUDE.md)).
  - `store.py` - Firestore writes for `health_daily`, `activities`, and the `garminSync` state doc.
  - `notify.py` - Telegram send + the notify-once dedup logic.
  - `tools/reauth.py` - the **local** re-auth tool (interactive login -> push new secret version).
  - `requirements.txt` - pinned deps (`garminconnect`, `google-cloud-firestore`,
    `google-cloud-secret-manager` optional, `requests`).
  - `Dockerfile` (or buildpack config) for the Cloud Run job.
  - `cloudbuild.yaml` - its **own** deploy config for a **separate** Cloud Build trigger.
  - `README.md` - run / deploy / re-auth instructions as Console click-paths, per
    [../../CLAUDE.local.md](../../CLAUDE.local.md).
- `.gcloudignore` (repo root, new or edited) - exclude `garmin-ingester/` so the bot's `--source=.`
  upload in [../../cloudbuild.yaml](../../cloudbuild.yaml) never ships the Python service.

Out of bounds without returning to `DRAFT`: anything under `src/`, the bot's
[../../cloudbuild.yaml](../../cloudbuild.yaml), the classifier, and any symptom/correlation logic.
The ingester writes Firestore that the bot may later read, but this spec adds **no** bot code.

## Contracts

### Deployable shape

A **Cloud Run job** (a batch task that runs and exits), triggered by **Cloud Scheduler** via the
job's Run API using an OIDC identity with Run Invoker. Chosen over an HTTP Cloud Function because it
is not a public endpoint - Scheduler invokes it through IAM, so there is no shared HTTP secret to
guard, and nothing is reachable from outside. (An HTTP-triggered gen2 function guarded by a shared
secret, like the planned reminder sweeper in [../architecture.md:715](../architecture.md#L715), is a
workable alternative if a job proves awkward; the job is the recommendation.)

### Call frequency to Garmin

**Once a day.** One scheduled run (default `0 6 * * *`, `Europe/Kyiv`) makes roughly **6-7 requests
to Garmin**: one token refresh, then per day of data one call each for sleep, HRV, stress, user
summary (resting HR + steps), and body battery, plus one activities call. With `BACKFILL_DAYS=1`
(the normal case) that is ~7 requests total per day; a one-off backfill of N days is ~6N+1 and is run
rarely. This is deliberately low: Garmin rate-limits and bot-challenges aggressive callers (we hit a
`429` on login in the POC), and yesterday's wellness data is already complete by morning, so polling
more often gains nothing. Daily is the ceiling, not a target - every few days would also be fine.

### Configuration (env vars)

Secrets injected via `--set-secrets` (like the bot); plain settings via `--set-env-vars`.

| Var | Source | Meaning |
|---|---|---|
| `GARMIN_TOKEN` | Secret Manager, `:latest` | The token JSON string. **Read-only** - the job never writes it back. |
| `TELEGRAM_BOT_TOKEN` | Secret Manager (reused) | To send the failure/recovery alert. |
| `GARMIN_OWNER_USER_ID` | env var | The Telegram user id the data is filed under (`users/{id}/...`), and the chat id alerts are sent to. Single owner. |
| `GCP_PROJECT` | env var | Project for Firestore. |
| `FIRESTORE_DATABASE` | env var | The `notes` database id (matches the bot's). |
| `BACKFILL_DAYS` | env var, default `1` | Days back to pull each run. `1` = yesterday only; raise for a one-off backfill run (idempotent, safe to repeat). |
| `RENUDGE_DAYS` | env var, default `7` | While broken, how long to stay silent before one gentle re-nudge. |

`GARMIN_TOKEN` is passed to `login_from_token()` as an inline JSON string (the library accepts inline
JSON, not only a path). The library refreshes the access token in memory each run and the new
refresh token is **discarded** - non-strict rotation means the stored one stays valid.

### `garmin_client.py`

- `login_from_token(token_json: str) -> Client` - loads the token inline, proactively refreshes if
  the access token is expiring. Raises a typed `GarminAuthError` (wrapping the library's auth error)
  when the refresh token itself is rejected - this is the **terminal** signal that drives an alert.
- `daily_wellness(client, date) -> dict` - normalized: `{sleepSeconds, sleepScore, hrvAvgMs,
  hrvStatus, stressAvg, restingHr, steps, bodyBatteryCharged, bodyBatteryDrained}`. Absent fields are
  `None`, never invented (mirrors the classifier's "absent fields stay absent" rule,
  [../architecture.md:257](../architecture.md#L257)). **`restingHr` comes from
  `get_user_summary(date)["restingHeartRate"]`**, not `get_rhr_day` (which returned empty in the POC).
- `recent_activities(client, limit) -> list[dict]` - normalized: `{activityId, type, startTimeLocal,
  startTimeUtc, durationSec, distanceKm, avgHr, maxHr}`. `distanceKm` is `None` for non-distance
  activities (strength, breathwork) rather than `0.0`, so it never masquerades as a real value.
  `calories` is deliberately not pulled (derived and noisy - see the data-minimization note below).

### Firestore documents

All under the single owner, keyed for idempotency so a re-run overwrites and never duplicates - the
same principle as the bot keying entries on `update_id` ([../architecture.md:559](../architecture.md#L559)).

**We store a lean, curated view - not everything Garmin has.** This is a deliberate departure from
"capture is sacred" ([../architecture.md:29](../architecture.md#L29)), and the reason matters: a
user's own messages are irreplaceable, so the bot must store the raw text forever. Garmin data is
different - **Garmin itself is the durable system of record**, and any field can be re-fetched later
by re-running a backfill. So there is no reason to hoard. We store one number per metric per day -
only the fields that plausibly relate to how you feel, for the future symptom-correlation work - and
**no** raw JSON blobs, **no** per-second streams, **no** GPS. If a later question needs a field we
did not keep, we add it to the getter and re-backfill; nothing is lost by leaving it out now. Every
stored field must earn its place; when in doubt, leave it out.

- `users/{GARMIN_OWNER_USER_ID}/health_daily/{YYYY-MM-DD}` - one per day. Doc id is the local date, so
  re-pulling a day is an overwrite. Fields: `date`, `source: "garmin"`, the normalized wellness
  fields above, `fetchedAt: Timestamp`.
- `users/{GARMIN_OWNER_USER_ID}/activities/{garminActivityId}` - one per activity. Doc id is Garmin's
  own activity id, so re-runs never duplicate. Fields: the normalized activity fields above,
  `source: "garmin"`, `fetchedAt: Timestamp`.
- `users/{GARMIN_OWNER_USER_ID}/system/garminSync` - one operational-state doc (non-secret):
  `{lastRunAt, lastSuccessAt, lastFetchedDate, lastError, alertState: "ok"|"alerted", alertedAt}`.
  This is state, not a secret, so Firestore is the right home (the token is **not** here - see
  Invariants).

### Alert messages (plain text, no `parse_mode`)

Sent by `notify.py` straight to the Telegram API. Wording is not asserted (it embeds nothing
sensitive); only *when* and *how often* they are sent is asserted.

- Terminal down (first time): "Garmin sync is down: the saved token is no longer valid. Run the local
  re-auth tool to refresh it."
- Re-nudge (still down after `RENUDGE_DAYS`): "Garmin sync is still down. Run the re-auth tool when
  you can."
- Recovery (first success after an alert): "Garmin sync is back - data is flowing again."

### `tools/reauth.py` (local only)

- Interactive: prompts for email, hidden password, MFA code (the POC's login half). Never runs on
  GCP.
- Produces the token JSON and pushes it as a **new version** of the `GARMIN_TOKEN` secret by piping
  it to `gcloud secrets versions add GARMIN_TOKEN --data-file=-` (via **stdin**, so the token is
  never written to a plaintext file on disk). Respects the pinned project/account from
  [../../CLAUDE.local.md](../../CLAUDE.local.md); you running the tool is the approval for that one
  secret write. Optionally disables the previous version to keep one active version.
- The job picks up `:latest` on its next run automatically - no redeploy.

## Invariants (must not break)

- **GCP is read-only on `GARMIN_TOKEN`.** The job's service account is **not** granted Secret Version
  Adder. Enforced by IAM, not just by code.
- **Login never runs on GCP.** The password+MFA flow exists only in `tools/reauth.py`, run locally.
  This is what avoids the `429` IP throttle and keeps the password off cloud infrastructure.
- **The token lives only in Secret Manager.** Never in Firestore, never in a file on disk in
  plaintext, never in logs. Firestore holds only non-secret operational state (`garminSync`).
- **Idempotency:** `health_daily` keyed by date, `activities` keyed by Garmin activity id. A re-run
  overwrites; it never creates a duplicate.
- **Degrade, do not crash-loop.** A transient error (429, network, 5xx) exits cleanly without an
  alert. Only a terminal auth failure alerts, and only per the dedup rules.
- **Notify only on state change.** Silent on success; one message on `ok -> alerted`; silent while
  `alerted` except one re-nudge per `RENUDGE_DAYS`; one recovery message on `alerted -> ok`.
- **Health-data discipline** (extends [../../CLAUDE.md](../../CLAUDE.md)'s "log ids and counts, not
  content"): never log the token or any health/activity value. Log user id, dates, counts, and
  outcome only.
- **Data minimization.** Store only the curated fields listed in Contracts - no raw JSON blobs, no
  per-second streams, no GPS. Garmin is the system of record; expand the stored set later by
  re-backfilling with more getters, never by hoarding everything now.
- **Does not touch the bot's deploy.** `.gcloudignore` excludes `garmin-ingester/` from the
  `--source=.` upload, so a bad Python file can never fail the bot's Cloud Build.

## Acceptance criteria (manual - the pipeline cannot run these)

Run locally with your Garmin credentials against the `notes` Firestore. Not mirrored into a machine
verifier; `acceptance` in the frontmatter stays empty because there is no automated verifier for this
track.

- **reauth-seeds-secret:** running `tools/reauth.py` completes an MFA login and adds a new enabled
  `GARMIN_TOKEN` version (`gcloud secrets versions list GARMIN_TOKEN` shows it); no plaintext token
  file is left on disk afterward.
- **read-only-refresh:** the job's service account has **no** secret-write role; a normal run still
  succeeds (proves read-only + in-memory refresh is enough).
- **health-fields-populated:** after a run, `users/{owner}/health_daily/{yesterday}` has non-null
  `sleepSeconds`, `hrvAvgMs`, `stressAvg`, `steps`, `bodyBatteryCharged`, `bodyBatteryDrained`, **and
  `restingHr`** (the field-path fix vs the POC).
- **activities-stored:** after a run, the recent activities appear under `users/{owner}/activities/{id}`
  with `type`, `startTimeLocal`, and `avgHr`.
- **daily-idempotent:** running the job twice for the same date leaves exactly one `health_daily/{date}`
  doc and no duplicate `activities/{id}` docs.
- **absent-not-invented:** a metric your device did not record for a day is stored as `null`, not a
  guessed value (spot-check a day with no recorded sleep, if available).
- **alert-once-on-terminal:** with a deliberately corrupted `GARMIN_TOKEN` version, one run sends
  exactly **one** Telegram message to the owner and sets `garminSync.alertState = "alerted"`; a second
  run (still corrupted, within `RENUDGE_DAYS`) sends **no** further message.
- **no-alert-on-transient:** a simulated 429/network failure sends **no** Telegram message and leaves
  `alertState` unchanged.
- **recovery-note:** after an alert, restoring a valid token and running once sends **one** recovery
  message and resets `alertState = "ok"`.
- **no-secret-in-logs:** the run's logs contain no token and no health/activity values - only ids,
  dates, counts, and the outcome.

## Console setup (click-paths, per CLAUDE.local.md)

No new local `gcloud` writes except the re-auth tool's single secret-version add, which you run.

1. **Secret Manager -> Create secret** `GARMIN_TOKEN`. Seed the first version by running
   `tools/reauth.py` locally (it adds the version).
2. **IAM & Admin -> IAM** -> the job's service account gets: **Secret Manager Secret Accessor** on
   `GARMIN_TOKEN` and on `TELEGRAM_BOT_TOKEN`; **Cloud Datastore User** for Firestore. It must **not**
   get any secret-write role (see Invariants).
3. **Cloud Run -> Jobs -> Deploy** the ingester image (or wire a **separate** Cloud Build trigger on
   `garmin-ingester/cloudbuild.yaml`, kept distinct from the bot's trigger).
4. **Cloud Scheduler -> Create job** -> daily (e.g. `0 6 * * *`, `Europe/Kyiv`), target the Cloud Run
   job's execution API, OIDC identity with **Cloud Run Invoker**.
5. Confirm the bot's own deploy is unaffected: a push that changes only `garmin-ingester/` should not
   produce a new bot revision (that is what `.gcloudignore` guarantees).

## Out of scope

- **Symptom correlation and any insight/analysis.** The actual point later, but it depends on symptoms
  (phase 3), which do not exist yet. This spec only makes the Garmin data exist to correlate against.
  Correlation is a separate future spec, and the honest caveat in
  [../architecture.md:638](../architecture.md#L638) applies to it: "worth noticing," never a finding.
- **Any change to the NestJS bot** - classifier, webhook, `/export`, replies. The bot may later read
  `health_daily`, but that is a different spec.
- **Real-time / push from Garmin.** There is no webhook on this unofficial route; this is a daily
  poll.
- **Per-second streams, GPS tracks, laps/splits, and raw JSON blobs.** Only the curated daily
  summary and activity summary fields in Contracts are stored. Metrics deliberately left out for now,
  re-fetchable if ever wanted: SpO2, respiration, floors, intensity minutes, calories, and any
  per-second or per-lap series. Adding one later is a getter change plus a re-backfill, not a
  migration.
- **Automated token write-back / self-healing on GCP.** Deliberately not built - non-strict rotation
  makes it unnecessary, and manual local regen is the chosen model. GCP stays read-only.
- **Multiple users.** Single owner via `GARMIN_OWNER_USER_ID`.
- **Strava.** A separate, cleaner integration considered earlier; not this spec.
- **A backfill/migration framework.** `BACKFILL_DAYS` covers a one-off catch-up because writes are
  idempotent; nothing more elaborate is built.
