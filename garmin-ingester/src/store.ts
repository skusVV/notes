import { Firestore, Timestamp } from '@google-cloud/firestore';
import { Activity, HrZones, Wellness } from './garmin-client';
import { SyncState } from './alert-state';

/** Firestore writes. Doc ids make every write an overwrite, so re-runs never duplicate. */
export class Store {
  constructor(private readonly db: Firestore, private readonly owner: string) {}

  private col(name: string) {
    return this.db.collection('users').doc(this.owner).collection(name);
  }

  async writeWellness(days: Map<string, Wellness>): Promise<void> {
    await this.writeAll([...days].map(([date, w]) => [
      this.col('health_daily').doc(date),
      { date, source: 'garmin', ...w, fetchedAt: Timestamp.now() },
    ]));
  }

  async writeActivities(list: Activity[]): Promise<void> {
    await this.writeAll(list.map((a) => [
      this.col('activities').doc(String(a.activityId)),
      { ...a, source: 'garmin', fetchedAt: Timestamp.now() },
    ]));
  }

  /** One small doc, overwritten each run: zone boundaries rarely change but are needed to read hrZoneSeconds. */
  async writeHrZones(zones: HrZones[]): Promise<void> {
    await this.col('system').doc('hrZones').set({ zones, fetchedAt: Timestamp.now() });
  }

  async readState(): Promise<SyncState> {
    const d = (await this.col('system').doc('garminSync').get()).data() ?? {};
    return {
      alertState: d.alertState === 'alerted' ? 'alerted' : 'ok',
      alertedAt: d.alertedAt ?? null,
      expiryWarnedFor: d.expiryWarnedFor ?? null,
    };
  }

  async writeState(state: SyncState, extra: Record<string, unknown>): Promise<void> {
    await this.col('system').doc('garminSync').set({ ...state, ...extra }, { merge: true });
  }

  private async writeAll(items: Array<[FirebaseFirestore.DocumentReference, Record<string, unknown>]>) {
    for (let i = 0; i < items.length; i += 400) {
      const batch = this.db.batch();
      for (const [ref, data] of items.slice(i, i + 400)) batch.set(ref, data);
      await batch.commit();
    }
  }
}
