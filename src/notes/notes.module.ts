import { Module } from '@nestjs/common';
import { FirestoreModule } from '../firestore/firestore.module';
import { NotesService } from './notes.service';

@Module({
  imports: [FirestoreModule],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
