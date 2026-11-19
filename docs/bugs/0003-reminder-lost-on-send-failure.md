---
id: 0003-reminder-lost-on-send-failure
state: DONE
severity: high
attempt: 0
max_attempts: 3
branch: fix/0003-reminder-lost-on-send-failure
acceptance:
  - id: health
    assert: "GET / returns HTTP 200 with body {\"status\":\"ok\"}"
  - id: repro-fixed
    assert: "npm test passes and includes a regression test, failing on the pre-fix code, in which sendReminder throws once for a due notification and a later sweep() sends it"
  - id: gives-up
    assert: "npm test includes a passing test: after 3 failed send attempts across 3 sweeps the notification has status 'failed', is no longer returned by findDue, and a 4th sweep does not try to send it"
  - id: recurrence-once
    assert: "npm test includes a passing test: a recurring notification whose first send fails and second succeeds ends with exactly one next-occurrence notification in status 'scheduled'"
  - id: delivery-unchanged
    assert: "With X-Test-Now=2026-12-01T09:00:00+02:00, from user 900000006 POST 'Remind me today at 14:00 to water the plants'; POST /sweep (valid X-Sweep-Secret) with X-Test-Now=2026-12-01T13:45:00+02:00 and the reflected replies contain exactly one string starting with 'Нагадування:' that contains 'water the plants' (case-insensitive, since the classifier may capitalise the title); a second POST /sweep at the same X-Test-Now reflects no such string; '/export' from 900000006 shows that notification with status 'sent'"
failures:
  - attempt: 0
    stage: deploy
    detail: >-
      Deploy not observable - build environment, not an implementation defect; needs the owner. The
      testing trigger's Cloud Build for 9578dae (fix/0003 + lane commit, 2026-11-19 14:06:55-14:08:06 UTC)
      FAILED in step 'deploy' with "(gcloud.functions.deploy) Invalid value for [--runtime]: nodejs20 is
      not a supported runtime on GCF 2nd gen" (read from the GitHub check run). cloudbuild.yaml line 12
      '--runtime=nodejs20' is identical on main and origin/main, so the production trigger will fail the
      same way on the next push to main (last green builds: test fe3e0a3, prod 2840c1d, both 2026-11-02).
      The test function kept serving fe3e0a3: 900000006's /export never gained the 'allDay' key that every
      fix/0003 export carries (50 probes 14:07-14:32 UTC, re-probed 16:59 UTC; /version is 'notes-bot
      1.0.0' on both and cannot tell them apart). So health and delivery-unchanged are NOT VERIFIED (GET /
      did answer 200 {"status":"ok"}, but from the old revision); delivery-unchanged was not run. Unit
      criteria checked locally on 67c5958: npm test 292/292, build and tsc clean; repro-fixed, gives-up and
      recurrence-once PASS, and the 11 new tests fail on b7719a0 (sweeper repro: expected 'sent' to be
      'scheduled'). Changing cloudbuild.yaml is outside this bug's Fix scope. Owner action: move --runtime
      to a supported Node runtime (and check package.json engines), get a green testing build, then re-run
      verification from IMPLEMENTED. Security pass ATTENTION, not FAIL (E/F: the unchanged 'Failed to
      deliver notification' log passes the whole AxiosError to Nest's logger, which prints the bot token
      from baseURL and the reminder text from the request body; pre-existing, but the retry makes it up to
      3 times per notification - worth its own bug).
  - attempt: 0
    stage: verification
    detail: >-
      Criterion conflict, not an implementation defect - needs the owner. Deploy of 3507f3d (fix/0003 rebased
      on 08b58fd + lane commit) succeeded on telegram-echo-bot-test (build 17:13:24-17:17:03 UTC, runtime
      nodejs24, state ACTIVE) and was proven live when 900000006's /export flipped from no 'allDay' key
      (17:13:11 UTC) to carrying it (18:12:32 and 18:12:54 UTC). 4 of 5 criteria PASS: health (GET / 200
      {"status":"ok"} at 18:13:09 UTC on the new revision), repro-fixed, gives-up, recurrence-once (npm test
      292/292 on 9082229; the 11 new tests fail on the tests-only commit f1803a0). delivery-unchanged FAILS
      as written only on letter case: the capture (X-Test-Now 2026-12-01T09:00+02:00) was stored as
      reminder khEm3YXIUIAUNuL7vHjq with title 'Water the plants' (the classifier capitalised it); the
      13:45 sweep reflected exactly one matching reply, 'Нагадування: Water the plants' + 'Сьогодні о 14:00',
      the second sweep at the same time reflected none, and /export shows notification KIehP9UupZCAebM1p87E
      (2026-12-01T14:00+02:00) with status 'sent'. A case-sensitive "contains 'water the plants'" therefore
      counts 0, not 1; case-insensitively it is exactly 1 then 0. The title's case comes from the classifier,
      which is outside this bug's Fix scope, so rework cannot change it. Owner decision: amend the criterion
      to match case-insensitively (or to 'Water the plants'), then re-run verification - the substance
      (delivered once, not again, stored 'sent') already holds. Security pass ATTENTION, not FAIL (E/F: the
      pre-existing AxiosError dump in the delivery-failure log, to be filed separately).
---

# BUG-0003 - A reminder whose Telegram send fails is never delivered

> **VERIFIED 2026-11-19** (spec-verifier) on telegram-echo-bot-test, live revision 3507f3d (nodejs24).
> All 5 criteria pass; security pass ATTENTION (pre-existing AxiosError log dump, filed separately).
> `delivery-unchanged` was re-judged against the amended case-insensitive criterion (df6f0c5) from the
> evidence recorded on 2026-11-19 at 18:13 UTC on that revision, with no redeploy: one
> 'Нагадування: Water the plants' delivery on the first sweep, none on the second, notification
> KIehP9UupZCAebM1p87E `sent`. The two `failures` entries are history (runtime block, criterion wording).

> **READY 2026-11-16** (owner). Found the same day in a housekeeping review, by reading the code.
> Decision: at most **3 send attempts** (3 sweeps, about 90 minutes), then status `failed`. A failed
> send cannot be produced on the test function (reflect mode swallows send errors), so the failure
> criteria are unit tests and the HTTP criterion checks that normal delivery is unchanged.

## Symptom

If Telegram is briefly unavailable when a reminder is due (a 5xx, a 429 rate limit, a network
timeout), that reminder never arrives. Nothing tells the user. The log shows
`Failed to deliver notification <id>` once, and later sweeps never try again.

## Reproduction

Unit level: in `SweeperService.sweep`, make `TelegramService.sendReminder` throw once for a due
notification. Expected today: `claimForSend` has already flipped it to `sent`, the next `sweep` call
does not find it in `findDue`, and it is never sent.

## Root cause

[sweeper.service.ts](../../src/telegram/sweeper.service.ts) claims, then sends. `claimForSend`
([reminders.service.ts](../../src/reminders/reminders.service.ts), around line 485) moves the
notification from `scheduled` to `sent` *before* the send, which correctly prevents double sends.
But when `sendReminder` throws, the catch only logs it. The notification stays `sent`, and
`findDue` only queries `status == 'scheduled'`, so it is gone. A notification with no `chatId`
(read as `0`) fails the same way, every time.

## Fix scope

- `src/telegram/sweeper.service.ts`: on a send failure, put the claimed notification back to
  `scheduled` (or into a retryable state) with an attempt counter.
- `src/reminders/reminders.service.ts`: the release/attempt write.
- `test/`: a regression test for the failed-send case.

Decided: a failed send puts the notification back to `scheduled` and increments a `sendAttempts`
counter on it. After the 3rd failed attempt it becomes `failed`, logged with the id only.

## Invariants (must not break)

- No double send. The claim transaction stays the only path to sending.
- A recurring reminder's next occurrence is armed exactly once, not once per retry.
- Logs carry ids only, never the reminder title.

## Acceptance criteria (locked at READY)

- **repro-fixed:** a notification whose first send fails is sent by a later sweep.
- **gives-up:** after the maximum number of attempts it is no longer `scheduled` and is not retried.
- **no-double-send:** two overlapping sweeps over a retried notification send it once.
- **recurrence-once:** a failing recurring notification arms its next occurrence exactly once.

## Out of scope

Telling the user that a reminder failed; alerting.
