import { Module } from '@nestjs/common';
import { DigestModule } from '../digest/digest.module';
import { FirestoreModule } from '../firestore/firestore.module';
import { GarminDigestReader } from './garmin-digest.reader';
import { GarminRecoverySection } from './garmin-recovery.section';
import { GarminYesterdaySection } from './garmin-yesterday.section';

/**
 * The morning digest's Garmin sections (spec 0018). The bot only **reads** what the morning job
 * writes (`health_daily`, `activities`, `system/garminSync`); no endpoint, secret or schedule here.
 */
@Module({
  // DigestModule only for its DIGEST_SECTIONS list; it never imports this module back.
  imports: [FirestoreModule, DigestModule],
  // Both sections register themselves into DIGEST_SECTIONS on module init.
  providers: [GarminDigestReader, GarminYesterdaySection, GarminRecoverySection],
})
export class GarminModule {}
