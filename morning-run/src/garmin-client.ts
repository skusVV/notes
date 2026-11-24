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

/** Grouped so a document reads like a sentence for a person or a model: `sleep.score`, `hrv.status`. */
export interface Wellness {
  sleep: {
    seconds: number | null; napSeconds: number | null; deepSeconds: number | null;
    lightSeconds: number | null; remSeconds: number | null; awakeSeconds: number | null;
    startLocal: string | null; endLocal: string | null; awakeCount: number | null;
    avgHr: number | null; avgStress: number | null;
    avgSpo2: number | null; lowestSpo2: number | null;
    avgRespiration: number | null; lowestRespiration: number | null; highestRespiration: number | null;
    score: number | null; scoreQualifier: string | null;
    deepPct: number | null; remPct: number | null; lightPct: number | null;
    needMinutes: number | null; needBaselineMinutes: number | null;
    needFeedback: string | null; trainingFeedback: string | null;
  };
  hrv: {
    lastNightAvg: number | null; weeklyAvg: number | null; last5MinHigh: number | null; status: string | null;
    baselineLowUpper: number | null; baselineBalancedLow: number | null; baselineBalancedUpper: number | null;
  };
  heart: { resting: number | null; min: number | null; max: number | null };
  stress: {
    avg: number | null; max: number | null; qualifier: string | null;
    restShare: number | null; lowShare: number | null; mediumShare: number | null; highShare: number | null;
  };
  bodyBattery: {
    charged: number | null; drained: number | null; min: number | null; max: number | null; latest: number | null;
  };
  respiration: { avg: number | null; min: number | null; max: number | null };
  spo2: { avg: number | null; min: number | null; latest: number | null };
  movement: {
    steps: number | null; stepsGoal: number | null; distanceM: number | null;
    floorsUp: number | null; floorsDown: number | null;
  };
  calories: { resting: number | null; active: number | null; total: number | null };
  intensity: { moderate: number | null; vigorous: number | null; goal: number | null };
  /** Filled by `withTraining` from the same run's activities; absent from raw Garmin responses. */
  training?: DayTraining;
}

export interface DayTraining {
  count: number; durationSec: number; trainingLoad: number;
  strengthSessions: number; strengthSets: number; strengthReps: number;
  aerobicEffectMax: number | null; anaerobicEffectMax: number | null;
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
  calories: number | null;
  trainingEffectAerobic: number | null;
  trainingEffectAnaerobic: number | null;
  trainingEffectLabel: string | null;
  trainingLoad: number | null;
  /** Seconds spent in heart-rate zones 1..5, or null when the activity has none. */
  hrZoneSeconds: number[] | null;
  steps: number | null;
  avgRespiration: number | null;
  bodyBatteryDelta: number | null;
  intensityModerateMin: number | null;
  intensityVigorousMin: number | null;
  /** Strength sessions only (no per-exercise breakdown); null for every other type. */
  sets: number | null;
  reps: number | null;
}

export interface HrZones {
  sport: string | null; method: string | null;
  restingHr: number | null; lactateThresholdHr: number | null; maxHr: number | null;
  /** Lower bound (bpm) of zones 1..5. */
  zoneFloors: Array<number | null>;
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

const n = (v: unknown) => num(v);
/** One decimal, so 18.041366577148438 is stored as 18. Keeps documents readable. */
const r1 = (v: unknown): number | null => {
  const x = num(v);
  return x === null ? null : Math.round(x * 10) / 10;
};
const ri = (v: unknown): number | null => {
  const x = num(v);
  return x === null ? null : Math.round(x);
};
/** Garmin's "local" timestamps are epoch ms of the wall-clock time; render as YYYY-MM-DDTHH:mm:ss. */
const wallClock = (v: unknown): string | null => {
  const x = num(v);
  return x === null ? null : new Date(x).toISOString().slice(0, 19);
};

export const emptyWellness = (): Wellness => ({
  sleep: {
    seconds: null, napSeconds: null, deepSeconds: null, lightSeconds: null, remSeconds: null, awakeSeconds: null,
    startLocal: null, endLocal: null, awakeCount: null, avgHr: null, avgStress: null,
    avgSpo2: null, lowestSpo2: null, avgRespiration: null, lowestRespiration: null, highestRespiration: null,
    score: null, scoreQualifier: null, deepPct: null, remPct: null, lightPct: null,
    needMinutes: null, needBaselineMinutes: null, needFeedback: null, trainingFeedback: null,
  },
  hrv: {
    lastNightAvg: null, weeklyAvg: null, last5MinHigh: null, status: null,
    baselineLowUpper: null, baselineBalancedLow: null, baselineBalancedUpper: null,
  },
  heart: { resting: null, min: null, max: null },
  stress: { avg: null, max: null, qualifier: null, restShare: null, lowShare: null, mediumShare: null, highShare: null },
  bodyBattery: { charged: null, drained: null, min: null, max: null, latest: null },
  respiration: { avg: null, min: null, max: null },
  spo2: { avg: null, min: null, latest: null },
  movement: { steps: null, stepsGoal: null, distanceM: null, floorsUp: null, floorsDown: null },
  calories: { resting: null, active: null, total: null },
  intensity: { moderate: null, vigorous: null, goal: null },
});

export function mergeSleep(into: Map<string, Wellness>, rows: unknown): void {
  for (const r of arr(rows)) {
    const date = str(r.calendarDate);
    if (!date) continue;
    const w = into.get(date) ?? emptyWellness();
    const sc = obj(r.sleepScores);
    const need = obj(r.sleepNeed);
    w.sleep = {
      seconds: n(r.sleepTimeSeconds), napSeconds: n(r.napTimeSeconds),
      deepSeconds: n(r.deepSleepSeconds), lightSeconds: n(r.lightSleepSeconds),
      remSeconds: n(r.remSleepSeconds), awakeSeconds: n(r.awakeSleepSeconds),
      startLocal: wallClock(r.sleepStartTimestampLocal), endLocal: wallClock(r.sleepEndTimestampLocal),
      awakeCount: n(r.awakeCount), avgHr: r1(r.avgHeartRate), avgStress: r1(r.avgSleepStress),
      avgSpo2: r1(r.averageSpO2Value), lowestSpo2: n(r.lowestSpO2Value),
      avgRespiration: r1(r.averageRespirationValue), lowestRespiration: r1(r.lowestRespirationValue),
      highestRespiration: r1(r.highestRespirationValue),
      score: n(obj(sc.overall).value), scoreQualifier: str(obj(sc.overall).qualifierKey),
      deepPct: n(obj(sc.deepPercentage).value), remPct: n(obj(sc.remPercentage).value),
      lightPct: n(obj(sc.lightPercentage).value),
      // Garmin gives these in minutes (480 = 8 h); the name carries the unit.
      needMinutes: n(need.actual), needBaselineMinutes: n(need.baseline),
      needFeedback: str(need.feedback), trainingFeedback: str(need.trainingFeedback),
    };
    into.set(date, w);
  }
}

export function mergeHrv(into: Map<string, Wellness>, body: unknown): void {
  for (const r of arr(obj(body).hrvSummaries)) {
    const date = str(r.calendarDate);
    if (!date) continue;
    const w = into.get(date) ?? emptyWellness();
    const b = obj(r.baseline);
    w.hrv = {
      lastNightAvg: n(r.lastNightAvg), weeklyAvg: n(r.weeklyAvg), last5MinHigh: n(r.lastNight5MinHigh),
      status: str(r.status),
      baselineLowUpper: n(b.lowUpper), baselineBalancedLow: n(b.balancedLow), baselineBalancedUpper: n(b.balancedUpper),
    };
    into.set(date, w);
  }
}

const share = (v: unknown): number | null => {
  const x = num(v);
  return x === null ? null : Math.round(x * 100) / 100;
};

export function mergeSummaries(into: Map<string, Wellness>, body: unknown): void {
  for (const r of arr(obj(body).data)) {
    const date = str(r.calendarDate);
    if (!date) continue;
    const w = into.get(date) ?? emptyWellness();
    const mv = obj(r.movement);
    const hr = obj(r.heartRate);
    const st = obj(r.stress);
    const bb = obj(r.bodyBattery);
    const rs = obj(r.respiration);
    const px = obj(r.pulseOx);
    const cal = obj(r.calories);
    const im = obj(r.intensityMinutes);
    w.heart = { resting: n(hr.restingValue), min: n(hr.minValue), max: n(hr.maxValue) };
    w.stress = {
      avg: n(st.avgLevel), max: n(st.maxLevel), qualifier: str(st.qualifier),
      restShare: share(st.restProportion), lowShare: share(st.lowStressProportion),
      mediumShare: share(st.mediumStressProportion), highShare: share(st.highStressProportion),
    };
    w.bodyBattery = {
      charged: n(bb.chargedValue), drained: n(bb.drainedValue), min: n(bb.minValue),
      max: n(bb.maxValue), latest: n(bb.latestValue),
    };
    w.respiration = { avg: r1(rs.avgValue), min: r1(rs.minValue), max: r1(rs.maxValue) };
    w.spo2 = { avg: r1(px.avgValue), min: n(px.minValue), latest: n(px.latestValue) };
    w.movement = {
      steps: n(obj(mv.steps).value), stepsGoal: n(obj(mv.steps).goal), distanceM: ri(obj(mv.steps).distanceInMeters),
      floorsUp: ri(obj(mv.floorsAscended).value), floorsDown: ri(obj(mv.floorsDescended).value),
    };
    w.calories = { resting: n(cal.burnedResting), active: n(cal.burnedActive), total: n(cal.burnedTotal) };
    w.intensity = { moderate: n(im.moderate), vigorous: n(im.vigorous), goal: n(im.goal) };
    into.set(date, w);
  }
}

export function normalizeActivity(r: Json): Activity | null {
  const id = num(r.activityId);
  if (id === null) return null;
  const meters = num(r.distance);
  const type = str(obj(r.activityType).typeKey);
  const zones = [1, 2, 3, 4, 5].map((i) => ri(r[`hrTimeInZone_${i}`]));
  const strength = type === 'strength_training';
  return {
    activityId: id,
    type,
    startTimeLocal: str(r.startTimeLocal),
    startTimeUtc: str(r.startTimeGMT),
    durationSec: ri(r.duration),
    // null, not 0, for non-distance activities (strength, breathwork)
    distanceKm: meters && meters > 0 ? Math.round(meters) / 1000 : null,
    avgHr: n(r.averageHR),
    maxHr: n(r.maxHR),
    calories: ri(r.calories),
    trainingEffectAerobic: r1(r.aerobicTrainingEffect),
    trainingEffectAnaerobic: r1(r.anaerobicTrainingEffect),
    trainingEffectLabel: str(r.trainingEffectLabel),
    trainingLoad: r1(r.activityTrainingLoad),
    hrZoneSeconds: zones.every((z) => z === null) ? null : zones.map((z) => z ?? 0),
    steps: n(r.steps),
    avgRespiration: r1(r.avgRespirationRate),
    bodyBatteryDelta: n(r.differenceBodyBattery),
    intensityModerateMin: n(r.moderateIntensityMinutes),
    intensityVigorousMin: n(r.vigorousIntensityMinutes),
    sets: strength ? n(r.totalSets) : null,
    reps: strength ? n(r.totalReps) : null,
  };
}

/** Heart-rate zone boundaries (rarely change). One entry per sport profile. */
export function normalizeHrZones(body: unknown): HrZones[] {
  return arr(body).map((r) => ({
    sport: str(r.sport), method: str(r.trainingMethod),
    restingHr: n(r.restingHeartRateUsed), lactateThresholdHr: n(r.lactateThresholdHeartRateUsed),
    maxHr: n(r.maxHeartRateUsed),
    zoneFloors: [1, 2, 3, 4, 5].map((i) => n(r[`zone${i}Floor`])),
  }));
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

  async hrZones(token: string): Promise<HrZones[]> {
    return normalizeHrZones(await this.get(token, '/biometric-service/heartRateZones/v2'));
  }

  private async get(token: string, path: string, query: Record<string, string> = {}, attempt = 0): Promise<unknown> {
    const qs = new URLSearchParams(query).toString();
    const res = await this.fetchSafe(`${HOST}${path}${qs ? `?${qs}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // 400/403 right after a good exchange is unexpected: transient + logged, not an auth alert.
    if (!res.ok) throw new GarminTransientError(`GET ${path.split('/')[1]} failed (HTTP ${res.status})`);
    try {
      return await res.json();
    } catch {
      // A truncated body does happen (seen once on a 28-day window); the same request succeeds on retry.
      if (attempt < RETRY_TRIES - 1) {
        await sleep(RETRY_BASE_MS * 2 ** attempt * (0.75 + Math.random() * 0.5));
        return this.get(token, path, query, attempt + 1);
      }
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
