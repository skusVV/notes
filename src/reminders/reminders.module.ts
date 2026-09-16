import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { RemindersService } from './reminders.service';

@Module({
  imports: [FirestoreModule],
  providers: [RemindersService],
  exports: [RemindersService],
})
export class RemindersModule {}
