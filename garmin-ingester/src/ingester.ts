import { Firestore } from '@google-cloud/firestore';
import { decide, Outcome } from './alert-state';
import { GarminAuthError, GarminClient } from './garmin-client';
import { render, sendTelegram } from './notify';
import { Store } from './store';

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Local calendar date (YYYY-MM-DD) in the owner's timezone, shifted by `offsetDays`. */
function localDate(tz: string, offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

async function main(): Promise<void> {
  const owner = need('GARMIN_OWNER_USER_ID');
  const apiKey = need('GARMIN_API_KEY');
  const tz = process.env.GARMIN_TIMEZONE?.trim() || 'Europe/Kyiv';
  const backfill = Math.max(0, Number(process.env.BACKFILL_DAYS ?? '1') || 1);
  const renudgeDays = Number(process.env.RENUDGE_DAYS ?? '7') || 7;
  const expiryWarnDays = Number(process.env.EXPIRY_WARN_DAYS ?? '14') || 14;
  const keyExpiresOn = process.env.GARMIN_KEY_EXPIRES_ON?.trim() || null;

  const db = new Firestore({
    projectId: need('GCP_PROJECT'),
    databaseId: process.env.FIRESTORE_DATABASE?.trim() || '(default)',
  });
  const store = new Store(db, owner);
  const client = new GarminClient();
  const today = localDate(tz);
  const from = localDate(tz, -backfill);

  let outcome: Outcome = 'success';
  let counts = { days: 0, activities: 0 };
  let lastError: string | null = null;
  try {
    const token = await client.getAccessToken(apiKey);
    const wellness = await client.dailyWellness(token, from, today);
    const activities = await client.recentActivities(token, from, today);
    await store.writeWellness(wellness);
    await store.writeActivities(activities);
    counts = { days: wellness.size, activities: activities.length };
  } catch (e) {
    outcome = e instanceof GarminAuthError ? 'auth_rejected' : 'transient';
    lastError = e instanceof Error ? e.message : 'unknown error'; // messages carry status codes only
  }

  const { next, messages } = decide(await store.readState(), outcome, today, { renudgeDays, expiryWarnDays, keyExpiresOn });
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  for (const m of messages) {
    if (botToken) await sendTelegram(botToken, owner, render(m, keyExpiresOn));
    else console.warn('TELEGRAM_BOT_TOKEN not set - alert not sent');
  }
  const now = new Date().toISOString();
  await store.writeState(next, {
    lastRunAt: now,
    lastError,
    ...(outcome === 'success' ? { lastSuccessAt: now, lastFetchedDate: today } : {}),
  });

  console.log(JSON.stringify({ user: owner, from, to: today, outcome, requests: client.requests, ...counts, alerts: messages.length, error: lastError }));
  // Transient failures exit 0 on purpose: a Cloud Run job retry would only hit Garmin harder.
}

main().catch((e) => {
  console.error(`ingester crashed: ${e instanceof Error ? e.message : 'unknown error'}`);
  process.exit(1);
});
