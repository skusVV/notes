import { Module } from '@nestjs/common';
import { ActorsModule } from '../actors/actors.module';
import { ClassifierModule } from '../classifier/classifier.module';
import { ClockModule } from '../clock/clock.module';
import { DigestModule } from '../digest/digest.module';
import { NotesModule } from '../notes/notes.module';
import { RemindersModule } from '../reminders/reminders.module';
import { SymptomsModule } from '../symptoms/symptoms.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { SweeperService } from './sweeper.service';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [
    TranscriptionModule,
    ClassifierModule,
    RemindersModule,
    ActorsModule,
    NotesModule,
    SymptomsModule,
    ClockModule,
    // For the /digest command and the digest key in /export.
    DigestModule,
  ],
  controllers: [TelegramController],
  providers: [TelegramService, SweeperService],
  // IngestModule feeds phone-captured text through the same handleUpdate path as a chat message.
  exports: [TelegramService],
})
export class TelegramModule {}
