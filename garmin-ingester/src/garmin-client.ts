/**
 * Thin wrapper over Garmin's official Connect Personal API. Named for the outcome (wellness and
 * activities in), so a future change of source touches this one file.
 *
 * Never log the key, the token or any returned value - only dates, counts and status codes.
 */
const HOST = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
/** Sleep caps at 31 days and stress/steps at 28; one window size satisfies every endpoint. */
export const MAX_WINDOW_DAYS = 28;
const ACTIVITY_PAGE = 99;

/** The key exchange was refused: the key is expired, deleted or wrong. Drives the "down" alert. */
export class GarminAuthError extends Error {}
/** 429, 5xx, network failure, or an unexpected 400/403 on a data call. Never alerts. */
export class GarminTransientError extends Error {}

export interface Wellness {
  sleepSeconds: number | null;
  sleepScore: number | null;
  deepSleepSeconds: number | null;
  remSleepSeconds: number | null;
  hrvLastNightAvgMs: number | null;
  hrvWeeklyAvgMs: number | null;
  hrvStatus: string | null;
  stressAvg: number | null;
  restingHr: number | null;
  steps: number | null;
  bodyBatteryCharged: number | null;
  bodyBatteryDrained: number | null;
}

export interface Activity {
  activityId: number;
  type: string | null;
  startTimeLocal: string | null;
  startTimeUtc: string | null;
  durationSec: number | null;
  distanceKm: number | null;
  avgHr: number | null;
  maxHr: number | null;
}

type Json = Record<string, unknown>;

/** A real finite number or null - absent fields stay absent, never invented. */
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}
function arr(v: unknown): Json[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Json[]) : [];
}

const emptyWellness = (): Wellness => ({
  sleepSeconds: null, sleepScore: null, deepSleepSeconds: null, remSleepSeconds: null,
  hrvLastNightAvgMs: null, hrvWeeklyAvgMs: null, hrvStatus: null, stressAvg: null,
  restingHr: null, steps: null, bodyBatteryCharged: null, bodyBatteryDrained: null,
});

export function mergeSleep(into: Map<string, Wellness>, rows: unknown): void {
  for (const r of arr(rows)) {
    const date = str(r.calendarDate);
    if (!date) continue;
    const w = into.get(date) ?? emptyWellness();
    w.sleepSeconds = num(r.sleepTimeSeconds);
    w.deepSleepSeconds = num(r.deepSleepSeconds);
    w.remSleepSeconds = num(r.remSleepSeconds);
    w.sleepScore = num(obj(obj(r.sleepScores).overall).value);
    into.set(date, w);
  }
}

export function mergeHrv(into: Map<string, Wellness>, body: unknown): void {
  for (const r of arr(obj(body).hrvSummaries)) {
    const date = str(r.calendarDate);
    if (!date) continue;
    const w = into.get(date) ?? emptyWellness();
    w.hrvLastNightAvgMs = num(r.lastNightAvg);
    w.hrvWeeklyAvgMs = num(r.weeklyAvg);
    w.hrvStatus = str(r.status);
    into.set(date, w);
  }
}

export function mergeSummaries(into: Map<string, Wellness>, body: unknown): void {
  for (const r of arr(obj(body).data)) {
    const date = str(r.calendarDate);
    if (!date) continue;
    const w = into.get(date) ?? emptyWellness();
    w.stressAvg = num(obj(r.stress).avgLevel);
    w.restingHr = num(obj(r.heartRate).restingValue);
    w.steps = num(obj(obj(r.movement).steps).value);
    w.bodyBatteryCharged = num(obj(r.bodyBattery).chargedValue);
    w.bodyBatteryDrained = num(obj(r.bodyBattery).drainedValue);
    into.set(date, w);
  }
}

export function normalizeActivity(r: Json): Activity | null {
  const id = num(r.activityId);
  if (id === null) return null;
  const meters = num(r.distance);
  return {
    activityId: id,
    type: str(obj(r.activityType).typeKey),
    startTimeLocal: str(r.startTimeLocal),
    startTimeUtc: str(r.startTimeGMT),
    durationSec: num(r.duration),
    // null, not 0, for non-distance activities (strength, breathwork)
    distanceKm: meters && meters > 0 ? meters / 1000 : null,
    avgHr: num(r.averageHR),
    maxHr: num(r.maxHR),
  };
}

/** Splits [from, to] (YYYY-MM-DD) into windows of at most MAX_WINDOW_DAYS days. */
export function windows(from: string, to: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  let cur = Date.parse(`${from}T00:00:00Z`);
  while (cur <= end) {
    const last = Math.min(cur + (MAX_WINDOW_DAYS - 1) * 86_400_000, end);
    out.push([iso(cur), iso(last)]);
    cur = last + 86_400_000;
  }
  return out;
}
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class GarminClient {
  /** Requests made to Garmin this run; logged so the "5 requests a day" claim is checkable. */
  requests = 0;

  /** Exchange the long-lived key for a 24 h bearer token. The body is a bare JWT, not JSON. */
  async getAccessToken(apiKey: string): Promise<string> {
    const res = await this.fetchSafe(`${HOST}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { Authorization: `ApiKey ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new GarminAuthError(`key exchange rejected (HTTP ${res.status})`);
    }
    if (!res.ok) throw new GarminTransientError(`key exchange failed (HTTP ${res.status})`);
    const token = (await res.text()).trim();
    if (!token) throw new GarminTransientError('key exchange returned an empty body');
    return token;
  }

  async dailyWellness(token: string, from: string, to: string): Promise<Map<string, Wellness>> {
    const out = new Map<string, Wellness>();
    for (const [a, b] of windows(from, to)) {
      mergeSleep(out, await this.get(token, '/sleep-service/sleep/dailySleepSummariesByDate', { startDate: a, endDate: b }));
      mergeHrv(out, await this.get(token, `/hrv-service/hrv/daily/${a}/${b}`));
      mergeSummaries(out, await this.get(token, '/usersummary-service/v2/dailysummaries', { startDate: a, endDate: b }));
    }
    return out;
  }

  async recentActivities(token: string, from: string, to: string): Promise<Activity[]> {
    const out: Activity[] = [];
    for (let start = 0; ; start += ACTIVITY_PAGE) {
      const page = arr(
        await this.get(token, '/activitylist-service/activities/search/activities', {
          start: String(start), limit: String(ACTIVITY_PAGE), startDate: from, endDate: to,
        }),
      );
      for (const r of page) {
        const a = normalizeActivity(r);
        if (a) out.push(a);
      }
      if (page.length < ACTIVITY_PAGE) return out; // short page = last page, saves a request
    }
  }

  private async get(token: string, path: string, query: Record<string, string> = {}): Promise<unknown> {
    const qs = new URLSearchParams(query).toString();
    const res = await this.fetchSafe(`${HOST}${path}${qs ? `?${qs}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // 400/403 right after a good exchange is unexpected: transient + logged, not an auth alert.
    if (!res.ok) throw new GarminTransientError(`GET ${path.split('/')[1]} failed (HTTP ${res.status})`);
    try {
      return await res.json();
    } catch {
      throw new GarminTransientError(`GET ${path.split('/')[1]} returned non-JSON`);
    }
  }

  /** Retries 429, 5xx and network errors with jittered exponential backoff (0.5 s, 1 s, 2 s). */
  private async fetchSafe(url: string, init: RequestInit): Promise<Response> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < RETRY_TRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      this.requests++;
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
        if (res.status !== 429 && res.status < 500) return res;
        lastStatus = res.status;
      } catch {
        lastStatus = 0;
      }
    }
    throw new GarminTransientError(
      lastStatus ? `Garmin kept answering HTTP ${lastStatus}` : 'network error talking to Garmin',
    );
  }
}

const RETRY_TRIES = 4; // 1 try + 3 retries
const RETRY_BASE_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
