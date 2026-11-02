import { Module } from '@nestjs/common';
import { DigestModule } from '../digest/digest.module';
import { FirestoreModule } from '../firestore/firestore.module';
import { RemindersDigestSection } from './reminders-digest.section';
import { RemindersService } from './reminders.service';

@Module({
  // DigestModule only for its DIGEST_SECTIONS list; it never imports this module back.
  imports: [FirestoreModule, DigestModule],
  // RemindersDigestSection registers the digest's "Нагадування" section on module init.
  providers: [RemindersService, RemindersDigestSection],
  exports: [RemindersService],
})
export class RemindersModule {}
