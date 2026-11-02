import { Module } from '@nestjs/common';
import { ClassifierModule } from '../classifier/classifier.module';
import { ClockModule } from '../clock/clock.module';
import { DigestModule } from '../digest/digest.module';
import { DigestRunnerService } from '../digest/digest-runner.service';
import { TelegramModule } from '../telegram/telegram.module';
import { IngestController } from './ingest.controller';
import { IngestGuard } from './ingest.guard';

@Module({
  // TelegramService is reused, not duplicated: ingested text takes the same path a chat message does.
  // The digest runner lives here because it needs TelegramService to send, and TelegramModule
  // already imports DigestModule - see DigestRunnerService.
  imports: [TelegramModule, DigestModule, ClassifierModule, ClockModule],
  controllers: [IngestController],
  providers: [IngestGuard, DigestRunnerService],
  exports: [IngestGuard],
})
export class IngestModule {}
