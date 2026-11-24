import { Firestore } from '@google-cloud/firestore';
import { decide, Outcome } from './alert-state';
import { requestDigest } from './bot-client';
import { GarminAuthError, GarminClient } from './garmin-client';
import { render, sendTelegram } from './notify';
import { finalOutcome, shouldRetry } from './retry-plan';
import { Store } from './store';
import { withTraining } from './training';

/**
 * The morning run (spec 0022): sync Garmin with up to MORNING_MAX_ATTEMPTS tries, alert once on the
 * final outcome, then always ask the bot for the digest - also after a rejected key or a crash in the
 * Garmin phase. A broken Garmin never cancels the digest.
 */

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** An integer env var of at least `min`, else the default. Unlike `Number(x) || d`, keeps a real 0. */
function intEnv(name: string, def: number, min: number): number {
  const raw = process.env[name]?.trim();
  const v = raw ? Number(raw) : NaN;
  return Number.isInteger(v) && v >= min ? v : def;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'unknown error'); // messages carry status codes only

/** Local calendar date (YYYY-MM-DD) in the owner's timezone, shifted by `offsetDays`. */
function localDate(tz: string, offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export interface AttemptResult {
  outcome: Outcome;
  /** Garmin answered and `health_daily/{today}` got a non-null `sleep.seconds`. */
  hasSleepToday: boolean;
  days: number;
  activities: number;
  error: string | null;
}

/**
 * Runs `syncOnce` until `shouldRetry` says stop, pausing between tries; returns every attempt in
 * order. The attempt counting lives here so `main` never does it. `syncOnce` must not throw.
 */
export async function syncWithRetries(
  syncOnce: (attempt: number) => Promise<AttemptResult>,
  maxAttempts: number,
  pause: () => Promise<void>,
): Promise<AttemptResult[]> {
  const results: AttemptResult[] = [];
  for (let attempt = 1; ; attempt++) {
    const r = await syncOnce(attempt);
    results.push(r);
    if (!shouldRetry(r.outcome, r.hasSleepToday, attempt, maxAttempts)) return results;
    await pause();
  }
}

async function garminPhase(owner: string): Promise<void> {
  const apiKey = need('GARMIN_API_KEY');
  const tz = process.env.GARMIN_TIMEZONE?.trim() || 'Europe/Kyiv';
  const backfill = Math.max(0, Number(process.env.BACKFILL_DAYS ?? '1') || 1);
  const renudgeDays = Number(process.env.RENUDGE_DAYS ?? '7') || 7;
  const expiryWarnDays = Number(process.env.EXPIRY_WARN_DAYS ?? '14') || 14;
  const keyExpiresOn = process.env.GARMIN_KEY_EXPIRES_ON?.trim() || null;
  const maxAttempts = intEnv('MORNING_MAX_ATTEMPTS', 5, 1);
  const pauseSeconds = intEnv('MORNING_RETRY_PAUSE_SECONDS', 180, 0);

  const db = new Firestore({
    projectId: need('GCP_PROJECT'),
    databaseId: process.env.FIRESTORE_DATABASE?.trim() || '(default)',
  });
  const store = new Store(db, owner);
  const client = new GarminClient();
  const today = localDate(tz);
  const from = localDate(tz, -backfill);

  /** One try, as before 0022: key -> data -> Firestore. Every write is an overwrite, so a repeat is idempotent. */
  const syncOnce = async (attempt: number): Promise<AttemptResult> => {
    const before = client.requests;
    let r: AttemptResult = { outcome: 'success', hasSleepToday: false, days: 0, activities: 0, error: null };
    try {
      const token = await client.getAccessToken(apiKey);
      const wellness = await client.dailyWellness(token, from, today);
      const activities = await client.recentActivities(token, from, today);
      await store.writeWellness(withTraining(wellness, activities));
      await store.writeActivities(activities);
      r = {
        ...r,
        hasSleepToday: wellness.get(today)?.sleep.seconds != null,
        days: wellness.size,
        activities: activities.length,
      };
      // Zone boundaries are a nice-to-have: a failure here must not turn a good sync into a bad one.
      try {
        await store.writeHrZones(await client.hrZones(token));
      } catch (e) {
        console.warn(`hr zones skipped: ${errorText(e)}`);
      }
    } catch (e) {
      r = { ...r, outcome: e instanceof GarminAuthError ? 'auth_rejected' : 'transient', error: errorText(e) };
    }
    console.log(JSON.stringify({
      user: owner, attempt, maxAttempts, outcome: r.outcome, sleepToday: r.hasSleepToday,
      requests: client.requests - before, days: r.days, activities: r.activities, error: r.error,
    }));
    return r;
  };

  const results = await syncWithRetries(syncOnce, maxAttempts, () => new Promise((ok) => setTimeout(ok, pauseSeconds * 1000)));
  const last = results[results.length - 1];
  const outcome = finalOutcome(results.map((r) => r.outcome));

  // Exactly once per run, on the final outcome - never once per attempt.
  const { next, messages } = decide(await store.readState(), outcome, today, { renudgeDays, expiryWarnDays, keyExpiresOn });
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  for (const m of messages) {
    if (botToken) await sendTelegram(botToken, owner, render(m, keyExpiresOn));
    else console.warn('TELEGRAM_BOT_TOKEN not set - alert not sent');
  }
  const now = new Date().toISOString();
  await store.writeState(next, {
    lastRunAt: now,
    lastError: last.error,
    ...(outcome === 'success' ? { lastSuccessAt: now, lastFetchedDate: today } : {}),
  });

  console.log(JSON.stringify({
    user: owner, from, to: today, outcome, attempts: results.length, sleepToday: last.hasSleepToday,
    requests: client.requests, days: last.days, activities: last.activities, alerts: messages.length, error: last.error,
  }));
}

/** Never throws. A missing setting or a failed call is logged and the run still exits 0. */
async function digestPhase(owner: string): Promise<void> {
  const baseUrl = process.env.BOT_BASE_URL?.trim();
  const secret = process.env.INGEST_SECRET?.trim();
  if (!baseUrl || !secret) {
    console.error(`digest not requested: ${!baseUrl ? 'BOT_BASE_URL' : 'INGEST_SECRET'} is not set`);
    return;
  }
  const d = await requestDigest(baseUrl, secret, owner);
  console.log(JSON.stringify({ user: owner, digest: { status: d.status, tries: d.tries, sent: d.sent ?? null, reason: d.reason ?? null } }));
}

async function main(): Promise<void> {
  const owner = need('GARMIN_OWNER_USER_ID');
  try {
    await garminPhase(owner);
  } catch (e) {
    console.error(`garmin phase failed: ${errorText(e)}`);
  } finally {
    await digestPhase(owner);
  }
  // Exit 0 on purpose, also after a failed Garmin phase: a Cloud Run job retry (--max-retries=0)
  // would only hit Garmin harder and call the bot again.
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`morning run crashed: ${errorText(e)}`);
    process.exit(1);
  });
}
