import { Firestore } from '@google-cloud/firestore';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * A thin Firestore client provider. Named for the outcome, not the vendor lock-in: services that
 * persist go through the `db` handle here rather than constructing their own client.
 *
 * Like TranscriptionService and ClassifierService it must **not** throw on construction when
 * `GCP_PROJECT` is unset - text handling has to survive an unconfigured store. In that case
 * `available` is false and `db` is undefined, and callers degrade to a "could not store" reply.
 */
@Injectable()
export class FirestoreService {
  private readonly logger = new Logger(FirestoreService.name);
  readonly db?: Firestore;

  constructor(config: ConfigService) {
    // Cloud Functions injects GOOGLE_CLOUD_PROJECT itself, but cloudbuild.yaml also sets
    // GCP_PROJECT explicitly, so honour either. No credentials are configured here: the function
    // authenticates as its own runtime service account via Application Default Credentials.
    const project =
      config.get<string>('GCP_PROJECT')?.trim() ||
      config.get<string>('GOOGLE_CLOUD_PROJECT')?.trim();

    if (!project) {
      this.logger.warn('GCP_PROJECT is not set - Firestore is unavailable, reminders are not stored');
      return;
    }

    // FIRESTORE_DATABASE is wired by cloudbuild.yaml: "(default)" in prod, "test" in the test
    // function, so the verifier never touches production data. Default to "(default)" for local runs.
    const databaseId = config.get<string>('FIRESTORE_DATABASE')?.trim() || '(default)';
    this.db = new Firestore({ projectId: project, databaseId });
    this.logger.log(`Firestore ready (${project}, database ${databaseId})`);
  }

  /** False when no project is configured, so callers can refuse politely instead of throwing. */
  get available(): boolean {
    return this.db !== undefined;
  }
}
