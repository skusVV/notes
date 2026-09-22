import { Module } from '@nestjs/common';
import { ActorsModule } from '../actors/actors.module';
import { ClassifierModule } from '../classifier/classifier.module';
import { ClockModule } from '../clock/clock.module';
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
  ],
  controllers: [TelegramController],
  providers: [TelegramService, SweeperService],
})
export class TelegramModule {}
