import { DocumentData } from '@google-cloud/firestore';
import { Injectable, Logger } from '@nestjs/common';
import { FirestoreService } from '../firestore/firestore.service';

/** A user's digest settings, stored as the `digest` map on `users/{userId}`. */
export interface DigestSettings {
  enabled: boolean;
  /** Where to send. In a private chat it equals the userId; taken from the chat the command came from. */
  chatId: number;
  /** 'YYYY-MM-DD' (local day) of the last digest claimed, or null when there has been none. */
  lastSentOn: string | null;
}

/** The `/export` shape: `null` when the user has no settings at all. */
export type DigestExport = { enabled: boolean; lastSentOn: string | null } | null;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads and writes `users/{userId}.digest`, and owns the once-a-day claim. Degrades with the
 * Firestore provider: with no store, `get` finds nothing (so the digest is "disabled") and writes
 * report failure, the same pattern as the other stores.
 */
@Injectable()
export class DigestSettingsService {
  private readonly logger = new Logger(DigestSettingsService.name);

  constructor(private readonly firestore: FirestoreService) {}

  get available(): boolean {
    return this.firestore.available;
  }

  /** The stored settings, or `undefined` when there are none (or no store). */
  async get(userId: number): Promise<DigestSettings | undefined> {
    const db = this.firestore.db;
    if (!db) {
      return undefined;
    }

    const snapshot = await db.collection('users').doc(String(userId)).get();
    return readSettings(snapshot.data(), userId);
  }

  /**
   * `/digest on` / `/digest off`. Writes `enabled` and the chat to send to, and leaves `lastSentOn`
   * alone - turning the digest off and on again the same morning must not unlock a second send.
   * Returns false when there is no store to write to.
   */
  async setEnabled(userId: number, chatId: number, enabled: boolean): Promise<boolean> {
    const db = this.firestore.db;
    if (!db) {
      return false;
    }

    // A merge write: the user document also carries other features' fields (declined mentions,
    // the open actor question), and only these two keys of the digest map are touched.
    await db
      .collection('users')
      .doc(String(userId))
      .set({ digest: { enabled, chatId } }, { merge: true });
    this.logger.log(`Digest ${enabled ? 'enabled' : 'disabled'} for user ${userId}`);
    return true;
  }

  /**
   * Claims `dateKey` for this user's digest: inside a transaction, re-read the settings and write
   * `lastSentOn = dateKey` only if it is not already that day. Returns whether this caller won.
   *
   * Claim, then send - the same ordering as the reminder sweep. Two overlapping calls can both pass
   * the first `lastSentOn` check, but only one transaction commits the write, and only that winner
   * sends. So a double digest is impossible; the cost is that a failed send is not retried that day.
   */
  async claimToday(userId: number, dateKey: string): Promise<boolean> {
    const db = this.firestore.db;
    if (!db) {
      return false;
    }

    const ref = db.collection('users').doc(String(userId));
    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const current = readSettings(snapshot.data(), userId);
      if (current?.lastSentOn === dateKey) {
        return false;
      }

      tx.set(ref, { digest: { lastSentOn: dateKey } }, { merge: true });
      return true;
    });
  }

  /** The `/export` view of the settings. */
  async export(userId: number): Promise<DigestExport> {
    const settings = await this.get(userId);
    return settings ? { enabled: settings.enabled, lastSentOn: settings.lastSentOn } : null;
  }
}

/**
 * The `digest` map read defensively: `enabled` is true only when stored as true, a missing chat
 * falls back to the user id (a private chat's id), and a malformed `lastSentOn` reads as none.
 */
function readSettings(data: DocumentData | undefined, userId: number): DigestSettings | undefined {
  const raw = data?.digest;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const digest = raw as Record<string, unknown>;
  return {
    enabled: digest.enabled === true,
    chatId: typeof digest.chatId === 'number' ? digest.chatId : userId,
    lastSentOn:
      typeof digest.lastSentOn === 'string' && DATE_KEY.test(digest.lastSentOn)
        ? digest.lastSentOn
        : null,
  };
}
