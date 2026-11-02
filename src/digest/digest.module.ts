import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { DigestSettingsService } from './digest-settings.service';
import { DigestService } from './digest.service';
import { DIGEST_SECTIONS, DigestSection } from './digest.types';

/**
 * The morning digest's assembly and settings. Sections are not listed here: each registers itself
 * into `DIGEST_SECTIONS` from its own module (reminders today), so this module never imports a
 * feature module and a new section never touches it.
 *
 * `DigestRunnerService` (the `/ingest/digest` logic) is provided by `IngestModule` - see its doc
 * comment for why.
 */
@Module({
  imports: [FirestoreModule],
  providers: [
    // A fresh array per application, filled by the sections' onModuleInit and read at build time.
    { provide: DIGEST_SECTIONS, useFactory: (): DigestSection[] => [] },
    DigestService,
    DigestSettingsService,
  ],
  exports: [DIGEST_SECTIONS, DigestService, DigestSettingsService],
})
export class DigestModule {}
