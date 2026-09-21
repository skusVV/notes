import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { ActorsService } from './actors.service';

@Module({
  imports: [FirestoreModule],
  providers: [ActorsService],
  exports: [ActorsService],
})
export class ActorsModule {}
