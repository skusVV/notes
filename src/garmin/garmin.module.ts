import { Module } from '@nestjs/common';
import { DigestModule } from '../digest/digest.module';
import { FirestoreModule } from '../firestore/firestore.module';
import { InsightPhrasingService } from '../insights/insight-phrasing.service';
import { GarminDigestReader } from './garmin-digest.reader';
import { GarminHistoryReader } from './garmin-history.reader';
import { GarminInsightsSection } from './garmin-insights.section';
import { GarminRawService } from './garmin-raw';

/**
 * The morning digest's Garmin part (spec 0026, replacing 0018's two raw sections): the
 * `garmin-insights` section and the `📊 Дані Garmin` raw-data reply. The bot only **reads** what the
 * morning job writes (`health_daily`, `activities`, `system/garminSync`); its one write is its own
 * `system/digestInsights` journal. No endpoint, secret or schedule here.
 */
@Module({
  // DigestModule only for its DIGEST_SECTIONS list; it never imports this module back.
  imports: [FirestoreModule, DigestModule],
  // The section registers itself into DIGEST_SECTIONS on module init.
  providers: [
    GarminDigestReader,
    GarminHistoryReader,
    InsightPhrasingService,
    GarminInsightsSection,
    GarminRawService,
  ],
  // TelegramModule answers the `gd:raw` button with it.
  exports: [GarminRawService],
})
export class GarminModule {}
