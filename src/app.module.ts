import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    // Reads .env locally; in Cloud Functions the values arrive as real env vars.
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    TelegramModule,
  ],
})
export class AppModule {}
