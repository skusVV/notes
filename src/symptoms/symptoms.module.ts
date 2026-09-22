import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { SymptomsService } from './symptoms.service';

@Module({
  imports: [FirestoreModule],
  providers: [SymptomsService],
  exports: [SymptomsService],
})
export class SymptomsModule {}
