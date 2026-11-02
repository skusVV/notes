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

# 0010 - Garmin health sync (official Personal API ingester)

> **0015 (Apple Health) видалено 2026-11-02:** власник визнав його неактуальним. Garmin - єдине
> джерело здоров'я, конфлікту немає.

> **Delivery track: manual, NOT `/implement-spec`.** Every other spec here is verified over HTTP
> against the isolated test Cloud Function ([README.md](README.md)). This one is a **separate
> service** with an **external credential** and a **live external dependency** (Garmin's servers).
> The `spec-verifier` has no Garmin key and drives only the test function, so it cannot run these
> acceptance criteria, and this spec must never be marked `READY` for the unattended pipeline. It is
> built and verified by hand. `state` stays `DRAFT`; `delivery: manual` marks it. The acceptance
> criteria are real but are **manual/local checks**, run by you (or Claude locally, with your key).
>
> **Manual gate:** the owner gave the explicit go-ahead on 2026-11-02 ("продовжуй з garmin").

> **Rewrite note (2026-11-01).** This spec was first written around the unofficial `garminconnect`
> library (password + MFA login, rotating OAuth tokens, a local re-auth tool). Garmin has since
> opened the **official Connect Personal API** to individuals. It replaces all of that: no password,
> no MFA, no login rate limit, no token rotation. Everything below is built on the official contract
> in "The Garmin Personal API contract". Facts there marked **(verified live)** were checked on
> 2026-11-01 with the owner's own key against the real API; the rest come from Garmin's FAQ and
> Swagger page.

## Context

Garmin's daily wellness data - sleep, HRV, stress, body battery, resting heart rate, steps - plus
activities is the data most useful for the eventual **symptom correlation** idea
([../architecture.md:638](../architecture.md#L638)), and it is exactly what Strava cannot give
(Strava is workout-only). The official **Garmin Connect Personal API** gives an individual read
access to their own Connect data with a self-serve key: no application, no approval, no fee.

This spec makes the Garmin data **exist** in Firestore on a daily schedule, with a simple credential
model (one long-lived API key in Secret Manager), and a quiet-until-broken failure alert. It does
**not** analyze or correlate that data - correlation waits on symptoms (phase 3), see Out of scope.

What the official route changes, in plain words:

- **The credential is a key you create by hand in Garmin Connect Web, not a login.** The job
  exchanges the key for a 24-hour access token on every run, in memory. Nothing rotates, so there is
  nothing to write back and no login flow to maintain.
- **The key expires** (you choose 30, 90, 180 or 365 days). That is now the one recurring chore: a
  new key every up to a year. The old "re-auth tool" becomes a short click-path (below), not code.
- **It is pull-only and read-only.** Data is requested on demand; Garmin pushes nothing.
- **Personal use only.** Garmin's FAQ: "not intended for commercial applications serving multiple
  end users." A single-owner health sync for the owner's own data is exactly the intended use.

## The Garmin Personal API contract

Source: [Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/),
[FAQ](https://developer.garmin.com/gc-developer-program/personal/personal-faq/), and the
[Swagger docs](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)
(OpenAPI 3.0.1, "Garmin Connect Personal API" 1.0.0, 26 endpoints, **all `GET`**).

### Hosts

- `https://personal.connectapi.garmin.com` (global). A China host `personal.connectapi.garmin.cn`
  exists; this spec uses `.com` only.

### Auth: key in, access token out

1. **Create the key** in Garmin Connect Web (Personal API Key page): accept the terms, pick an
   expiry of **30 / 90 / 180 days or 1 year**, copy it. It is **shown once**; lose it and you must
   delete and recreate. **Only one key can exist at a time** - creating a new one means deleting the
   current one first, which stops it working immediately. Garmin emails a reminder about a week
   before expiry. Deleting a key also kills every access token minted from it.
2. **Exchange it:** `POST /personalapitoken-service/personal-api/personal-api-key/token` with header
   `Authorization: ApiKey <key>`. **(verified live)** The response is **HTTP 200 with the bare JWT as
   the body, plain text, not JSON** - do not `JSON.parse` it.
3. **Call data endpoints** with `Authorization: Bearer <jwt>`.

Facts about the token **(verified live)**: lifetime exactly **24 h** (or until the key expires,
whichever is first); issuer `https://diauth.garmin.com`; scopes `CONNECT_READ`,
`PERSONAL_API_FITNESS_READ`, `PERSONAL_API_NUTRITION_READ`, `PERSONAL_API_USER_READ`,
`PERSONAL_API_WELLNESS_READ`. **No refresh tokens exist** - to renew, exchange the key again.

Failure behavior **(verified live)**: a data call with no `Authorization` header returns `400` (not
`401`); a data call that sends `ApiKey <key>` instead of a Bearer token returns `403`. So `400`/`403`
on a data call means "bad or missing token", not "bad request".

### Endpoints this spec uses

All dates are `YYYY-MM-DD` in the **user's local calendar**. Responses are raw Garmin JSON.

| Need | Endpoint | Params | Max range |
|---|---|---|---|
| Sleep | `GET /sleep-service/sleep/dailySleepSummariesByDate` | `startDate`, `endDate` | **31 days** (verified: 35 days gives `400`) |
| HRV | `GET /hrv-service/hrv/daily/{fromDate}/{toDate}` | path dates | not stated |
| Resting HR, steps, body battery, stress | `GET /usersummary-service/v2/dailysummaries` | `startDate`, `endDate` | up to **1 year** per Garmin |
| Activities | `GET /activitylist-service/activities/search/activities` | `start` (offset, default 0), `limit` (default 99), `startDate`, `endDate`, `sortOrder` | paged |

The Swagger also offers (not used now, listed so a future spec knows they exist): steps / stress /
hydration daily ranges (steps and stress cap at **28 days**, verified for stress: 35 days gives
`400`), body battery reports (`chunks` param, cap 31 days), SpO2, weight, nutrition logs, menstrual
cycle, fitness age, heart-rate zones, activity detail and splits, and the original activity file
download (`/download-service/files/activity/{activityId}`, a FIT file zipped).

An **empty range returns `200` with `[]`** (verified: a 2024 range from before the device returned
`[]`), so an empty body is "no data", never an error. History reaches back at least to mid-2025
(verified); Garmin does not state the limit for the personal tier.

### Response fields we read (verified live, names exact)

- **Sleep** - array of `{calendarDate, sleepTimeSeconds, deepSleepSeconds, lightSleepSeconds,
  remSleepSeconds, awakeSleepSeconds, avgHeartRate, avgSleepStress, sleepScores:{overall:{value,
  qualifierKey}, ...}, ...}`. `calendarDate` is the **wake-up date**: last night's sleep is filed
  under *today*. Sleep score is `sleepScores.overall.value`.
- **HRV** - `{hrvSummaries:[{calendarDate, weeklyAvg, lastNightAvg, lastNight5MinHigh, status,
  baseline:{lowUpper, balancedLow, balancedUpper, markerValue}, ...}]}`. Status is a string such as
  a balanced / unbalanced label; store it verbatim.
- **Daily summaries (v2)** - `{data:[{calendarDate, movement:{steps:{value, goal, distanceInMeters}, floorsAscended, ...},
  heartRate:{minValue, maxValue, restingValue}, stress:{avgLevel, maxLevel, ...},
  bodyBattery:{minValue, maxValue, chargedValue, drainedValue, latestValue, ...}, calories,
  intensityMinutes, hydration, respiration, pulseOx, ...}]}`. **This one call replaces separate
  steps, stress, resting-HR and body-battery calls** and fixes the old POC problem of an empty
  resting-HR endpoint: `restingHr` is `heartRate.restingValue`.
- **Activities** - array of `{activityId, activityName, startTimeLocal, startTimeGMT,
  activityType:{typeKey, ...}, distance (meters), duration (seconds), averageHR, maxHR, calories,
  ...}`.

### Rate limits and terms

- **No numeric rate limit is published.** The terms let Garmin "throttle, delay, reject, suspend, or
  otherwise restrict API requests without notice", so stay low-volume (see Call frequency) and treat
  `429` and `5xx` as transient.
- Garmin strips undocumented fields (VO2 max, recovery time, performance condition) from
  API-delivered activity files; irrelevant here because we never download FIT files.
- No technical support for personal keys.

## Delivery track (why manual, and how it is built)

Built by hand, in this order (each step independently checkable):

1. **Key + secret** - create the key in Garmin Connect Web, store it as secret `GARMIN_API_KEY`.
2. **Ingester core** - exchange key for token, pull a window, write Firestore idempotently.
3. **Alerting** - notify-once-on-failure plus the key-expiry heads-up, and their dedup state.
4. **Schedule + deploy** - Cloud Run job + Cloud Scheduler, kept off the bot's deploy.

Verification is the manual acceptance criteria below, run locally against your real key and the
`notes` Firestore. No `testing` branch, no test Cloud Function, no reply reflection.

## Scope

A **new, self-contained service** in a new top-level directory, plus one repo-root change to keep it
out of the bot's deploy. Written in **TypeScript on Node** to match the repo: the official API is
plain REST with a bearer token, so no Garmin-specific library is needed (the earlier Python
requirement came only from the unofficial login library). The implementer may touch only these:

- `garmin-ingester/` (new). Files:
  - `src/ingester.ts` - the job entrypoint: resolve the date window, exchange the key, pull, write,
    alert, exit.
  - `src/garmin-client.ts` - thin wrapper over `fetch`: `getAccessToken(apiKey)` and typed getters
    returning normalized objects. Named for the outcome, so a future change of source touches one
    file (same discipline as `TranscriptionService`, [../../CLAUDE.md](../../CLAUDE.md)).
  - `src/training.ts` - pure per-day rollup of activities into `health_daily.training`.
  - `src/store.ts` - Firestore writes for `health_daily`, `activities`, `system/hrZones` and `garminSync`.
  - `src/notify.ts` - Telegram send + the notify-once dedup logic.
  - `package.json` / `tsconfig.json` - pinned deps (`@google-cloud/firestore`; Node's built-in
    `fetch` for HTTP).
  - `Dockerfile` (or buildpack config) for the Cloud Run job.
  - `cloudbuild.yaml` - its **own** deploy config for a **separate** Cloud Build trigger.
  - `README.md` - run / deploy / key-renewal instructions as Console click-paths, per
    [../../CLAUDE.local.md](../../CLAUDE.local.md).
- `.gcloudignore` (repo root, new or edited) - exclude `garmin-ingester/` so the bot's `--source=.`
  upload in [../../cloudbuild.yaml](../../cloudbuild.yaml) never ships the ingester.

There is **no re-auth tool**: nothing is logged into, so there is nothing to script. Renewing the key
is the click-path in "Console setup".

Out of bounds without returning to `DRAFT`: anything under `src/` (the bot's), the bot's
[../../cloudbuild.yaml](../../cloudbuild.yaml), the classifier, and any symptom/correlation logic.
The ingester writes Firestore that the bot may later read, but this spec adds **no** bot code.

## Contracts

### Deployable shape

A **Cloud Run job** (a batch task that runs and exits), triggered by **Cloud Scheduler** via the
job's Run API using an OIDC identity with Run Invoker. Chosen over an HTTP Cloud Function because it
is not a public endpoint - Scheduler invokes it through IAM, so there is no shared HTTP secret to
guard. (An HTTP-triggered gen2 function guarded by a shared secret, like the planned reminder
sweeper in [../architecture.md:715](../architecture.md#L715), is a workable alternative.)

### Call frequency to Garmin

**Once a day.** One scheduled run (default `0 7 * * *`, `Europe/Kyiv`) makes **6 requests**: one key
exchange, then one ranged call each for sleep, HRV and daily summaries, one activities page, and the
heart-rate zones.
Because the endpoints take date ranges, the cost does **not** grow with `BACKFILL_DAYS` (up to the
31-day sleep cap; larger backfills are split into windows of at most 28 days, a few requests each).
No numeric limit is published and Garmin may throttle without notice, so daily is the ceiling, not a
target.

### Date window

Each run pulls `[today - BACKFILL_DAYS, today]` (local date, `BACKFILL_DAYS` default `1`) and
**overwrites** every day in it. This is deliberate: sleep is filed under the **wake-up date**, so
last night's sleep arrives under *today*, while *yesterday's* steps and body battery are only final
by morning. Re-pulling both days each run means a day that was partial the first time is corrected
the next time. Today's own steps/stress are partial at 07:00 and are overwritten the following day.

### Configuration (env vars)

Secrets injected via `--set-secrets` (like the bot); plain settings via `--set-env-vars`.

| Var | Source | Meaning |
|---|---|---|
| `GARMIN_API_KEY` | Secret Manager, `:latest` | The **API key** (not the 24 h access token). **Read-only** - the job never writes it. |
| `TELEGRAM_BOT_TOKEN` | Secret Manager (reused) | To send alerts. |
| `GARMIN_OWNER_USER_ID` | env var | The Telegram user id the data is filed under (`users/{id}/...`), and the chat id alerts go to. Single owner. |
| `GARMIN_KEY_EXPIRES_ON` | env var, `YYYY-MM-DD` | The expiry date you chose when creating the key. The API does not expose it, so you record it here (see Alert messages). |
| `GCP_PROJECT` | env var | Project for Firestore. |
| `FIRESTORE_DATABASE` | env var | The `notes` database id (matches the bot's). |
| `BACKFILL_DAYS` | env var, default `1` | Days back to pull each run; raise for a one-off backfill (idempotent, safe to repeat). |
| `RENUDGE_DAYS` | env var, default `7` | While broken, how long to stay silent before one gentle re-nudge. |
| `EXPIRY_WARN_DAYS` | env var, default `14` | How many days before `GARMIN_KEY_EXPIRES_ON` to send the one heads-up. |

### `garmin-client.ts`

- `getAccessToken(apiKey: string): Promise<string>` - the key exchange. Reads the response **as
  text** (it is a bare JWT). Throws a typed `GarminAuthError` on `401`/`403` from the exchange - the
  **terminal** signal that the key is expired, deleted or wrong, and the one that drives the "down"
  alert. A `429`, `5xx` or network failure throws a different `GarminTransientError`.
- Data getters send `Authorization: Bearer <token>`. A `400`/`403` on a data call right after a
  successful exchange is unexpected and is treated as transient plus logged, not as an auth alert.
- `dailyWellness(token, fromDate, toDate): Promise<Map<date, Wellness>>` - issues the three ranged
  calls and merges them by `calendarDate` into **grouped** fields (see "Daily document shape"). Absent
  fields are `null`, never invented (mirrors the classifier's rule,
  [../architecture.md:257](../architecture.md#L257)). Floats are rounded to one decimal so a document
  reads cleanly; units are in the field name where Garmin's are not obvious (`needMinutes`,
  `distanceM`).
- `recentActivities(token, fromDate, toDate): Promise<Activity[]>` - pages the activities search
  until a short page (so a normal run is one request). The list already carries time in each heart-rate
  zone, training effect, training load, calories, respiration and body-battery change, so **no
  per-activity detail request is made**. `distanceKm` is `null` for non-distance activities (strength,
  breathwork), never `0`. Strength sessions store `sets` and `reps` totals only - no per-exercise
  breakdown; every other type has them `null`.
- `hrZones(token): Promise<HrZones[]>` - heart-rate zone boundaries (`zoneFloors` 1..5, max, resting
  and lactate-threshold HR) per sport profile. One request per run; written to one small doc.
- A truncated or non-JSON body is retried like a 5xx (seen once on a 28-day window).

### Daily document shape (grouped, built to be read by a person or a model)

```
health_daily/{YYYY-MM-DD}: date, source, fetchedAt,
  sleep{seconds, napSeconds, deepSeconds, lightSeconds, remSeconds, awakeSeconds, startLocal, endLocal,
        awakeCount, avgHr, avgStress, avgSpo2, lowestSpo2, avgRespiration, lowestRespiration,
        highestRespiration, score, scoreQualifier, deepPct, remPct, lightPct, needMinutes,
        needBaselineMinutes, needFeedback, trainingFeedback},
  hrv{lastNightAvg, weeklyAvg, last5MinHigh, status, baselineLowUpper, baselineBalancedLow, baselineBalancedUpper},
  heart{resting, min, max}, stress{avg, max, qualifier, restShare, lowShare, mediumShare, highShare},
  bodyBattery{charged, drained, min, max, latest}, respiration{avg, min, max}, spo2{avg, min, latest},
  movement{steps, stepsGoal, distanceM, floorsUp, floorsDown}, calories{resting, active, total},
  intensity{moderate, vigorous, goal},
  training{count, durationSec, trainingLoad, strengthSessions, strengthSets, strengthReps,
           aerobicEffectMax, anaerobicEffectMax}
```

`sleep.startLocal`/`endLocal` are wall-clock `YYYY-MM-DDTHH:mm:ss` (Garmin sends them as shifted epoch
ms). `training` is **derived** from the same run's activities (`src/training.ts`, pure); a day with no
activities gets zeros, not a missing field, because "did nothing" is a fact worth correlating.

### Firestore documents

All under the single owner, keyed for idempotency so a re-run overwrites and never duplicates - the
same principle as the bot keying entries on `update_id` ([../architecture.md:559](../architecture.md#L559)).

**We store a lean, curated view - not everything Garmin has.** This departs from "capture is
sacred" ([../architecture.md:29](../architecture.md#L29)) on purpose: a user's own messages are
irreplaceable, but **Garmin is the durable system of record** and any field can be re-fetched by
re-running a backfill. So we store one number per metric per day - only fields that plausibly relate
to how you feel - and **no** raw JSON blobs, **no** per-second streams, **no** GPS, **no** FIT files.
Adding a field later is a getter change plus a re-backfill, never a migration. When in doubt, leave
it out.

- `users/{GARMIN_OWNER_USER_ID}/health_daily/{YYYY-MM-DD}` - one per day. Doc id is the local date,
  so re-pulling a day is an overwrite. Fields: `date`, `source: "garmin"`, the normalized wellness
  fields above, `fetchedAt: Timestamp`.
- `users/{GARMIN_OWNER_USER_ID}/activities/{garminActivityId}` - one per activity. Doc id is Garmin's
  own activity id. Fields: type, local/UTC start, durationSec, distanceKm, avgHr, maxHr, calories,
  trainingEffectAerobic/Anaerobic/Label, trainingLoad, `hrZoneSeconds` (array of 5), steps,
  avgRespiration, bodyBatteryDelta, intensityModerateMin/VigorousMin, sets, reps, `source: "garmin"`,
  `fetchedAt`.
- `users/{GARMIN_OWNER_USER_ID}/system/hrZones` - `{zones: HrZones[], fetchedAt}`, overwritten each run;
  needed to read `hrZoneSeconds`.
- `users/{GARMIN_OWNER_USER_ID}/system/garminSync` - one operational-state doc (non-secret):
  `{lastRunAt, lastSuccessAt, lastFetchedDate, lastError, alertState: "ok"|"alerted", alertedAt,
  expiryWarnedFor}`. `expiryWarnedFor` holds the `GARMIN_KEY_EXPIRES_ON` value already warned about,
  so changing the env var to a new key's date re-arms the warning. State, not a secret.

### Alert messages (plain text, no `parse_mode`)

Sent by `notify.ts` straight to the Telegram API. Wording is not asserted (nothing sensitive is
embedded); only *when* and *how often* they are sent is asserted.

- Key rejected (first time): "Garmin sync is down: Garmin rejected the API key (expired or deleted).
  Create a new key in Garmin Connect and update the secret."
- Re-nudge (still down after `RENUDGE_DAYS`): "Garmin sync is still down. Renew the API key when you
  can."
- Recovery (first success after an alert): "Garmin sync is back - data is flowing again."
- **Expiry heads-up (once per key):** when today is within `EXPIRY_WARN_DAYS` of
  `GARMIN_KEY_EXPIRES_ON` and `expiryWarnedFor` differs from it: "Your Garmin API key expires on
  (the humanized date). Create a new one before then." Sent once, independent of `alertState`. Humanize the date
  through the bot's rule that no raw ISO reaches the chat ([../../CLAUDE.md](../../CLAUDE.md),
  `humanizeInstant`); the ingester has its own tiny equivalent since it cannot import the bot.

## Invariants (must not break)

- **GCP is read-only on `GARMIN_API_KEY`.** The job's service account is **not** granted Secret
  Version Adder. Enforced by IAM, not just by code. (Nothing needs writing: the key is static and the
  24 h token lives only in memory.)
- **The key and the access token live only in Secret Manager / memory.** Never in Firestore, never in
  a file on disk, never in logs, never in a Telegram message. The access token is minted per run and
  discarded.
- **Never send the key anywhere but the token endpoint.** Data calls carry only the short-lived
  Bearer token (a data call with the key directly returns `403` anyway).
- **Idempotency:** `health_daily` keyed by date, `activities` keyed by Garmin activity id. A re-run
  overwrites; it never creates a duplicate.
- **Degrade, do not crash-loop.** A transient error (429, network, 5xx, empty range) exits cleanly
  without an alert. Only a rejected key exchange alerts, and only per the dedup rules.
- **Notify only on state change.** Silent on success; one message on `ok -> alerted`; silent while
  `alerted` except one re-nudge per `RENUDGE_DAYS`; one recovery message on `alerted -> ok`; one
  expiry heads-up per key.
- **Health-data discipline** (extends [../../CLAUDE.md](../../CLAUDE.md)'s "log ids and counts, not
  content"): never log the key, the token, or any health/activity value. Log user id, dates, counts,
  HTTP status codes and outcome only.
- **Data minimization.** Store only the curated fields in Contracts.
- **Personal use only.** Single owner, own data; do not widen this to other people's accounts - it
  would breach the Personal API terms and the single-owner design.
- **Does not touch the bot's deploy.** `.gcloudignore` excludes `garmin-ingester/`, so a bad file
  here can never fail the bot's Cloud Build.

## Acceptance criteria (manual - the pipeline cannot run these)

Run locally with your Garmin key against the `notes` Firestore. `acceptance` in the frontmatter stays
empty because there is no automated verifier for this track.

- **key-exchange:** the client exchanges the key and receives a JWT as plain text (not JSON); the
  token is not logged and no file containing it exists afterward.
- **read-only-key:** the job's service account has **no** secret-write role; a normal run succeeds.
- **health-fields-populated:** after a run, `health_daily/{yesterday}` has non-null `sleep.seconds`,
  `sleep.score`, `hrv.lastNightAvg`, `heart.resting`, `stress.avg`, `movement.steps`,
  `bodyBattery.charged`, `calories.total`, `spo2.avg` and `respiration.avg`; and `health_daily/{today}`
  carries last night's sleep. `training` exists on every day.
- **activities-stored:** recent activities appear under `users/{owner}/activities/{id}` with `type`,
  `startTimeLocal`, `avgHr`, `trainingLoad` and a 5-element `hrZoneSeconds`; a strength activity has
  `distanceKm: null` and numeric `sets`/`reps`. `system/hrZones` holds five zone floors.
- **rollup-correct:** a day with a run and a strength session has `training.count = 2` and
  `training.strengthSessions = 1`; a rest day has `count = 0`.
- **six-requests:** a normal run with `BACKFILL_DAYS=1` makes exactly 6 requests to Garmin (check
  the request-count log line).
- **backfill-windowed:** `BACKFILL_DAYS=60` completes without a `400` (windows of at most 28 days)
  and fills 60 distinct `health_daily` docs.
- **daily-idempotent:** running twice for the same window leaves one doc per date and no duplicate
  `activities/{id}`.
- **absent-not-invented:** a metric the device did not record for a day is stored as `null`
  (spot-check a day with no recorded sleep, if available); an empty `[]` response writes nothing and
  raises no alert.
- **alert-once-on-rejected-key:** with a deliberately wrong `GARMIN_API_KEY` version, one run sends
  exactly **one** Telegram message and sets `alertState = "alerted"`; a second run within
  `RENUDGE_DAYS` sends **none**.
- **no-alert-on-transient:** a simulated 429 / network failure sends **no** message and leaves
  `alertState` unchanged.
- **recovery-note:** after an alert, restoring a valid key and running once sends **one** recovery
  message and resets `alertState = "ok"`.
- **expiry-heads-up-once:** with `GARMIN_KEY_EXPIRES_ON` set within `EXPIRY_WARN_DAYS`, the first run
  sends one heads-up and the second sends none; setting a new date re-arms it.
- **no-secret-in-logs:** logs contain no key, no token and no health/activity values - only ids,
  dates, counts, status codes and the outcome.

## Console setup (click-paths, per CLAUDE.local.md)

No local `gcloud` writes are needed.

1. **Garmin Connect Web -> account settings -> Personal API Key -> Create Key.** Accept the terms,
   pick an expiry (recommended: 1 year; shorter limits blast radius if the key leaks), copy the key
   (shown once). Note the expiry date.
2. **Secret Manager -> Create secret** named `GARMIN_API_KEY`, paste the key as the value. Do not
   paste it into chat or commit it; the local `.env` (git-ignored) may hold it for local runs only.
3. **IAM & Admin -> IAM** -> the job's service account gets **Secret Manager Secret Accessor** on
   `GARMIN_API_KEY` and `TELEGRAM_BOT_TOKEN`, and **Cloud Datastore User** for Firestore. It must
   **not** get any secret-write role.
4. **Cloud Run -> Jobs -> Deploy** the ingester image (or wire a **separate** Cloud Build trigger on
   `garmin-ingester/cloudbuild.yaml`, distinct from the bot's trigger). Set env var
   `GARMIN_KEY_EXPIRES_ON` to the date from step 1.
5. **Cloud Scheduler -> Create job** -> `0 7 * * *`, `Europe/Kyiv`, target the Cloud Run job's
   execution API, OIDC identity with **Cloud Run Invoker**.
6. Confirm the bot's own deploy is unaffected: a push that changes only `garmin-ingester/` must not
   produce a new bot revision.

**Renewing the key (replaces the old re-auth tool).** Only one key can exist at a time, so renewal
has a short gap: in Garmin Connect Web **delete the current key, create a new one**, then in
**Secret Manager -> `GARMIN_API_KEY` -> New version** paste it, then update
`GARMIN_KEY_EXPIRES_ON` on the Cloud Run job. The job reads `:latest`, so no redeploy; the worst
case is one skipped morning, and the next run backfills it.

## Out of scope

- **Symptom correlation and any insight/analysis.** The actual point later, but it depends on
  symptoms (phase 3), which do not exist yet. Correlation is a separate future spec, and the honest
  caveat in [../architecture.md:638](../architecture.md#L638) applies: "worth noticing," never a
  finding.
- **Any change to the NestJS bot** - classifier, webhook, `/export`, replies.
- **Real-time / push from Garmin.** The personal tier is pull-only; this is a daily poll.
- **FIT files, per-second streams, GPS, laps/splits, raw JSON blobs.** Only the curated daily and
  activity summary fields are stored. Available from the API but deliberately left out for now:
  hydration, weight, nutrition, menstrual cycle, fitness age, per-exercise strength breakdown, activity
  splits and the per-activity detail endpoint (it adds almost nothing over the list). Adding one is a
  getter change plus a re-backfill. Garmin has **no planned-workout endpoint** in the Personal API, so
  "today's training plan" must come from the calendar spec (0014), not from here.
- **The unofficial `garminconnect` route** and everything tied to it (password/MFA login, token
  rotation, `reauth.py`). Superseded by this rewrite; do not reintroduce it as a fallback.
- **Automatic key renewal.** Garmin offers no API to mint a key; renewal is a manual console step by
  design, backed by the expiry heads-up.
- **Multiple users, and any commercial or multi-user use** (forbidden by the Personal API terms).
- **Strava.** A separate integration considered earlier; not this spec.
- **A backfill/migration framework.** `BACKFILL_DAYS` covers a one-off catch-up because writes are
  idempotent.
