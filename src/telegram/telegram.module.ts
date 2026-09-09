import { Module } from '@nestjs/common';
import { TranscriptionModule } from '../transcription/transcription.module';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  imports: [TranscriptionModule],
  controllers: [TelegramController],
  providers: [TelegramService],
})
export class TelegramModule {}
