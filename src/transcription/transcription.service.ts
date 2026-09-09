import { GoogleGenAI } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

// 'global' avoids the ~10% surcharge Vertex charges for a pinned regional endpoint. Override
// with VERTEX_LOCATION only if data residency actually requires it.
const DEFAULT_LOCATION = 'global';

// Deliberately plain: we want the words that were said, not the model's commentary on them.
const PROMPT = [
  'Transcribe this audio verbatim.',
  'Reply with the transcription only - no preamble, no translation, no commentary.',
  'If there is no intelligible speech, reply with nothing at all.',
].join(' ');

/** Thrown when `transcribe` is called without a project configured. */
export class TranscriptionUnavailableError extends Error {}

/**
 * Speech to text. Named for the outcome rather than the vendor: swapping Gemini for Cloud
 * Speech-to-Text should touch this file only.
 */
@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private readonly model: string;
  private readonly ai?: GoogleGenAI;

  constructor(config: ConfigService) {
    this.model = config.get<string>('TRANSCRIPTION_MODEL')?.trim() || DEFAULT_MODEL;
    const location = config.get<string>('VERTEX_LOCATION')?.trim() || DEFAULT_LOCATION;

    // Cloud Functions injects GOOGLE_CLOUD_PROJECT itself, but cloudbuild.yaml also sets
    // GCP_PROJECT explicitly so the value is visible at the deploy boundary rather than implied.
    const project =
      config.get<string>('GCP_PROJECT')?.trim() ||
      config.get<string>('GOOGLE_CLOUD_PROJECT')?.trim();

    if (!project) {
      // Unlike TELEGRAM_BOT_TOKEN this must not throw: text echo has to keep working while
      // transcription is unconfigured.
      this.logger.warn('GCP_PROJECT is not set - voice messages cannot be transcribed');
      return;
    }

    // No API key. The function authenticates as its own runtime service account via Application
    // Default Credentials, which GCP supplies from the metadata server. Note that missing or
    // unauthorised credentials therefore surface on the first transcribe() call, not here, so
    // handleVoice's catch is what turns them into a user-visible message.
    this.ai = new GoogleGenAI({ vertexai: true, project, location });
    this.logger.log(`Transcribing with ${this.model} via Vertex AI (${project}, ${location})`);
  }

  /** False when no project is configured, so callers can refuse politely instead of throwing. */
  get available(): boolean {
    return this.ai !== undefined;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    if (!this.ai) {
      throw new TranscriptionUnavailableError('GCP_PROJECT is not set');
    }

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [{ text: PROMPT }, { inlineData: { mimeType, data: audio.toString('base64') } }],
        },
      ],
    });

    return response.text?.trim() ?? '';
  }
}
