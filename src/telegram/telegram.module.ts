import { Module } from '@nestjs/common';
import { ClassifierModule } from '../classifier/classifier.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [TranscriptionModule, ClassifierModule],
  controllers: [TelegramController],
  providers: [TelegramService],
})
export class TelegramModule {}
