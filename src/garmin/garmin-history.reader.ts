import { Injectable } from '@nestjs/common';
import { DigestContext } from '../digest/digest.types';
import { FirestoreService } from '../firestore/firestore.service';
import { ActivityRecord, DayHealth, HealthHistory, InsightJournal } from '../insights/insights.types';
import { dateWindow, shiftDate } from '../insights/norms';
import { garminDates } from './garmin-digest.reader';

/** Days of `health_daily` read for the insights: today plus the 30 before it. */
export const HISTORY_DAYS = 31;

/**
 * Reads the history the insight detectors need (spec 0026) and the no-repeat journal.
 *
 * Read-only towards the morning job's collections: `health_daily` by document id (`getAll`, one
 * round trip) and `activities` by one single-field range on `startTimeLocal` - no composite index.
 * The only write is `system/digestInsights`, the bot's own journal. Never logs a value.
 */
@Injectable()
export class GarminHistoryReader {
  constructor(private readonly firestore: FirestoreService) {}

  /** The 31 days up to today. With no store, an empty history. */
  async read(userId: number, ctx: Pick<DigestContext, 'dayStart' | 'timezone'>): Promise<HealthHistory> {
    const { today } = garminDates(ctx);
    const history: HealthHistory = { today, days: {}, activities: [] };
    const db = this.firestore.db;
    if (!db) {
      return history;
    }

    const user = db.collection('users').doc(String(userId));
    const dates = dateWindow(today, HISTORY_DAYS);
    const refs = dates.map((date) => user.collection('health_daily').doc(date));
    const [snapshots, activitySnapshot] = await Promise.all([
      db.getAll(...refs),
      user
        .collection('activities')
        .where('startTimeLocal', '>=', dates[0])
        .where('startTimeLocal', '<', shiftDate(today, 1))
        .get(),
    ]);

    snapshots.forEach((snapshot, index) => {
      const data = snapshot.exists ? snapshot.data() : undefined;
      if (data) {
        history.days[dates[index]] = readDay(dates[index], data);
      }
    });
    history.activities = activitySnapshot.docs
      .map((doc) => readActivity(doc.data()))
      .filter((activity): activity is ActivityRecord => activity !== null);
    return history;
  }

  /** `system/digestInsights`. Missing, malformed or unreadable is an empty journal. */
  async readJournal(userId: number): Promise<InsightJournal> {
    const db = this.firestore.db;
    if (!db) {
      return { shown: {} };
    }
    try {
      const snapshot = await this.journalRef(userId)!.get();
      const shown = record(snapshot.exists ? snapshot.data()?.shown : undefined);
      const out: Record<string, string> = {};
      for (const [key, date] of Object.entries(shown)) {
        if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
          out[key] = date;
        }
      }
      return { shown: out };
    } catch {
      return { shown: {} };
    }
  }

  /** Overwrites the journal (the caller has already pruned it). Throws on failure; the caller logs. */
  async writeJournal(userId: number, journal: InsightJournal): Promise<void> {
    const ref = this.journalRef(userId);
    if (!ref) {
      return;
    }
    await ref.set({ shown: journal.shown });
  }

  private journalRef(userId: number) {
    return this.firestore.db
      ?.collection('users')
      .doc(String(userId))
      .collection('system')
      .doc('digestInsights');
  }
}

/** A `health_daily` doc read defensively: every missing or non-numeric field is null, never 0. */
export function readDay(date: string, data: unknown): DayHealth {
  const doc = record(data);
  const sleep = record(doc.sleep);
  const hrv = record(doc.hrv);
  const heart = record(doc.heart);
  const stress = record(doc.stress);
  const battery = record(doc.bodyBattery);
  const movement = record(doc.movement);
  const calories = record(doc.calories);
  const intensity = record(doc.intensity);
  return {
    date,
    sleepSeconds: num(sleep.seconds),
    sleepDeepSeconds: num(sleep.deepSeconds),
    sleepRemSeconds: num(sleep.remSeconds),
    sleepAwakeCount: num(sleep.awakeCount),
    sleepStartLocal: typeof sleep.startLocal === 'string' ? sleep.startLocal : null,
    sleepNeedMinutes: num(sleep.needMinutes),
    sleepAvgRespiration: num(sleep.avgRespiration),
    hrvLastNightAvg: num(hrv.lastNightAvg),
    hrvBaselineBalancedLow: num(hrv.baselineBalancedLow),
    hrvBaselineBalancedUpper: num(hrv.baselineBalancedUpper),
    restingHr: num(heart.resting),
    stressHighShare: num(stress.highShare),
    bodyBatteryMax: num(battery.max),
    steps: num(movement.steps),
    stepsGoal: num(movement.stepsGoal),
    floorsUp: num(movement.floorsUp),
    caloriesTotal: num(calories.total),
    caloriesActive: num(calories.active),
    intensityModerate: num(intensity.moderate),
    intensityVigorous: num(intensity.vigorous),
    intensityGoal: num(intensity.goal),
  };
}

function readActivity(data: unknown): ActivityRecord | null {
  const doc = record(data);
  if (typeof doc.startTimeLocal !== 'string') {
    return null;
  }
  return {
    startTimeLocal: doc.startTimeLocal,
    durationSec: num(doc.durationSec),
    trainingLoad: num(doc.trainingLoad),
  };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
