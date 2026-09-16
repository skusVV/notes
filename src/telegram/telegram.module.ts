import { Module } from '@nestjs/common';
import { ClassifierModule } from '../classifier/classifier.module';
import { ClockModule } from '../clock/clock.module';
import { RemindersModule } from '../reminders/reminders.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [TranscriptionModule, ClassifierModule, RemindersModule, ClockModule],
  controllers: [TelegramController],
  providers: [TelegramService],
})
export class TelegramModule {}
