import { Outcome } from './alert-state';

/**
 * Whether the morning run should try Garmin again (spec 0022). Pure: no clock, no network.
 *
 * Only what can pass is retried: a transient failure, and a good answer with no sleep for today yet
 * (the watch has not synced with the phone). A rejected key never is - every later try would be
 * refused the same way. `attempt` is 1-based; nothing past `maxAttempts`, whatever the outcome.
 */
export function shouldRetry(outcome: Outcome, hasSleepToday: boolean, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) return false;
  if (outcome === 'auth_rejected') return false;
  if (outcome === 'transient') return true;
  return !hasSleepToday;
}

/**
 * The one outcome a run reports and alerts on, from its attempts in order. `auth_rejected` if the key
 * was refused; otherwise the last attempt decides: `transient` if Garmin did not answer it, else
 * `success` - also when there is still no sleep, because Garmin did answer. No attempt is `transient`.
 */
export function finalOutcome(outcomes: readonly Outcome[]): Outcome {
  if (outcomes.includes('auth_rejected')) return 'auth_rejected';
  return outcomes.length ? outcomes[outcomes.length - 1] : 'transient';
}
