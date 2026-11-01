import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module';
import { IngestController } from './ingest.controller';
import { IngestGuard } from './ingest.guard';

@Module({
  // TelegramService is reused, not duplicated: ingested text takes the same path a chat message does.
  imports: [TelegramModule],
  controllers: [IngestController],
  providers: [IngestGuard],
  exports: [IngestGuard],
})
export class IngestModule {}
