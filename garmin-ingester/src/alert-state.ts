/** Pure decision logic for "notify only on state change". No I/O, so it is unit-tested. */
export interface SyncState {
  alertState: 'ok' | 'alerted';
  alertedAt: string | null; // YYYY-MM-DD of the last "down"/re-nudge message
  expiryWarnedFor: string | null;
}
export type Outcome = 'success' | 'auth_rejected' | 'transient';
export type Message = 'down' | 'renudge' | 'recovery' | 'expiry';

const DAY = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export function decide(
  s: SyncState,
  outcome: Outcome,
  today: string,
  o: { renudgeDays: number; expiryWarnDays: number; keyExpiresOn: string | null },
): { next: SyncState; messages: Message[] } {
  const next = { ...s };
  const messages: Message[] = [];

  if (outcome === 'auth_rejected') {
    if (s.alertState === 'ok') {
      messages.push('down');
      next.alertState = 'alerted';
      next.alertedAt = today;
    } else if (s.alertedAt && days(s.alertedAt, today) >= o.renudgeDays) {
      messages.push('renudge');
      next.alertedAt = today;
    }
  } else if (outcome === 'success' && s.alertState === 'alerted') {
    messages.push('recovery');
    next.alertState = 'ok';
    next.alertedAt = null;
  }

  // Heads-up is independent of alertState; a transient run still has a valid key, so it may warn.
  if (o.keyExpiresOn && s.expiryWarnedFor !== o.keyExpiresOn && days(today, o.keyExpiresOn) <= o.expiryWarnDays) {
    messages.push('expiry');
    next.expiryWarnedFor = o.keyExpiresOn;
  }
  return { next, messages };
}
