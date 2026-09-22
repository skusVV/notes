import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ActorsModule } from './actors/actors.module';
import { ClockModule } from './clock/clock.module';
import { FirestoreModule } from './firestore/firestore.module';
import { NotesModule } from './notes/notes.module';
import { RemindersModule } from './reminders/reminders.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    // Reads .env locally; in Cloud Functions the values arrive as real env vars.
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    // Persistence and time, wired here so they exist for anything the app initialises.
    ClockModule,
    FirestoreModule,
    RemindersModule,
    ActorsModule,
    NotesModule,
    TelegramModule,
  ],
})
export class AppModule {}
