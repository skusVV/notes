import { restingHrNorm30 } from './detectors';
import { HealthHistory, Readiness } from './insights.types';
import { atMost, normOver, valueOn, windowBefore } from './norms';
import { BadSignal, readinessSignals, readinessText } from './templates';
import * as T from './thresholds';

/**
 * The readiness line (spec 0026): four signals from this morning, each counted only when its data
 * is there. Fewer than {@link T.READINESS_MIN_SIGNALS} available signals is no line at all.
 * 🔴 for two or more bad signals or an active `rhr-warning`, 🟡 for one, 🟢 for none.
 */
export function computeReadiness(history: HealthHistory, rhrWarning: boolean): Readiness | null {
  const today = history.today;
  let available = 0;
  const bad: BadSignal[] = [];

  const hrv = valueOn(history, today, 'hrvLastNightAvg');
  const low = valueOn(history, today, 'hrvBaselineBalancedLow');
  if (hrv !== null && low !== null) {
    available += 1;
    if (hrv < low) {
      bad.push(readinessSignals.hrv(hrv));
    }
  }

  const rhr = valueOn(history, today, 'restingHr');
  const rhrNorm = restingHrNorm30(history);
  if (rhr !== null && rhrNorm !== null) {
    available += 1;
    if (rhr >= rhrNorm + T.READINESS_RHR_DELTA) {
      bad.push(readinessSignals.rhr(rhr));
    }
  }

  const sleep = valueOn(history, today, 'sleepSeconds');
  const need = valueOn(history, today, 'sleepNeedMinutes');
  if (sleep !== null && need !== null && need > 0) {
    available += 1;
    if (sleep < T.READINESS_SLEEP_NEED_SHARE * need * 60) {
      bad.push(readinessSignals.sleep(sleep));
    }
  }

  const battery = valueOn(history, today, 'bodyBatteryMax');
  const batteryNorm = normOver(history, windowBefore(today, T.NORM_WINDOW_LONG), 'bodyBatteryMax', T.MIN_VALUES_30);
  if (battery !== null && batteryNorm !== null && batteryNorm > 0) {
    available += 1;
    if (atMost(battery, T.READINESS_BATTERY_SHARE * batteryNorm)) {
      bad.push(readinessSignals.battery(battery));
    }
  }

  if (available < T.READINESS_MIN_SIGNALS) {
    return null;
  }

  const level = bad.length >= 2 || rhrWarning ? 'red' : bad.length === 1 ? 'yellow' : 'green';
  return { level, ...readinessText(level, bad, rhrWarning) };
}
