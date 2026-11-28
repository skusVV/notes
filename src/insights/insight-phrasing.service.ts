import { GoogleGenAI, Schema, Type } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CLASSIFIER_DEFAULT_LOCATION, CLASSIFIER_DEFAULT_MODEL } from '../classifier/classifier.service';
import { PlannedLine } from './rank';

/** Gemini never holds the digest up longer than this (spec 0026, decision 10). */
export const PHRASING_TIMEOUT_MS = 8_000;
/** A rewritten line longer than this is rejected (the prompt asks for 160). */
export const PHRASING_MAX_CHARS = 200;

const RESPONSE_SCHEMA: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING, description: 'The id of the input line, unchanged.' },
      text: { type: Type.STRING, description: 'The rewritten line: one sentence, Ukrainian.' },
    },
    required: ['id', 'text'],
  },
};

const INSTRUCTION = [
  'You rewrite the lines of a morning health digest for one person, in Ukrainian.',
  'Input: a JSON array of {id, text, numbers}. Output: a JSON array of {id, text}, one entry per',
  'input line, same ids.',
  'Tone: a friendly coach talking to the person with "ти"; one sentence per line, at most 160',
  'characters; light humour is fine; no moralising; no medical claims or diagnoses.',
  'Keep every string from "numbers" in the text exactly as written (same digits, spaces, units,',
  'signs and percent). Do not add facts, causes, numbers or advice that the input line does not',
  'already contain. If the line says something is a coincidence or a signal, keep that meaning.',
  'No line breaks, no emoji at the start, no Markdown.',
].join('\n');

/** Leading readiness colours: code prepends its own, so the model's are dropped. */
const LEADING_MARKERS = /^(?:\s*(?:🟢|🟡|🔴))+\s*/u;

export interface PhrasingResult {
  /** One text per input line, in order, without markers. */
  texts: string[];
  /** How many rewritable lines fell back to their template. */
  fallback: number;
}

/**
 * Whether the model's `text` may replace `line`'s template (decision 9): not empty, one line, at
 * most {@link PHRASING_MAX_CHARS}, and every one of the line's numbers present verbatim.
 */
export function acceptPhrase(line: PlannedLine, text: unknown): text is string {
  if (typeof text !== 'string') {
    return false;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0 || /[\r\n]/.test(trimmed) || trimmed.length > PHRASING_MAX_CHARS) {
    return false;
  }
  return line.numbers.every((number) => trimmed.includes(number));
}

/**
 * Applies a raw model reply to the lines, line by line. Anything unusable - not JSON, not an array,
 * a missing or unknown id, a failed {@link acceptPhrase} - keeps that line's template. Never throws.
 */
export function applyPhrasing(lines: readonly PlannedLine[], raw: string | undefined): PhrasingResult {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    parsed = undefined;
  }

  const byId = new Map<string, unknown>();
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const item = entry as { id?: unknown; text?: unknown } | null;
      if (item && typeof item.id === 'string' && !byId.has(item.id)) {
        byId.set(item.id, typeof item.text === 'string' ? item.text.replace(LEADING_MARKERS, '') : item.text);
      }
    }
  }

  let fallback = 0;
  const texts = lines.map((line) => {
    if (line.fixed) {
      return line.template;
    }
    const candidate = byId.get(line.id);
    if (acceptPhrase(line, candidate)) {
      return candidate.trim();
    }
    fallback += 1;
    return line.template;
  });
  return { texts, fallback };
}

/** Every line kept as its template. */
export function templateResult(lines: readonly PlannedLine[]): PhrasingResult {
  return {
    texts: lines.map((line) => line.template),
    fallback: lines.filter((line) => !line.fixed).length,
  };
}

/**
 * Rewrites the insight lines in a coach's voice with **one** Gemini call (spec 0026, decisions
 * 8-10). Vertex AI with Application Default Credentials, the same model and location defaults as
 * `ClassifierService` - no API key. Like that service it never throws: no `GCP_PROJECT`, a timeout,
 * an error or garbage all mean the templates.
 *
 * Never logs a line, the prompt or the reply - the caller logs counts and `fallback=<n>` only.
 */
@Injectable()
export class InsightPhrasingService {
  private readonly logger = new Logger(InsightPhrasingService.name);
  private readonly model: string;
  private readonly ai?: GoogleGenAI;
  /** Overridable in tests only. */
  timeoutMs = PHRASING_TIMEOUT_MS;

  constructor(config: ConfigService) {
    this.model = config.get<string>('CLASSIFIER_MODEL')?.trim() || CLASSIFIER_DEFAULT_MODEL;
    const location = config.get<string>('VERTEX_LOCATION')?.trim() || CLASSIFIER_DEFAULT_LOCATION;
    const project =
      config.get<string>('GCP_PROJECT')?.trim() || config.get<string>('GOOGLE_CLOUD_PROJECT')?.trim();

    if (!project) {
      this.logger.warn('GCP_PROJECT is not set - digest insights use their template text');
      return;
    }
    this.ai = new GoogleGenAI({ vertexai: true, project, location });
  }

  get available(): boolean {
    return this.ai !== undefined;
  }

  /** The texts for `lines`, rewritten where the model's line passed validation. Never throws. */
  async phrase(lines: readonly PlannedLine[]): Promise<PhrasingResult> {
    const rewritable = lines.filter((line) => !line.fixed);
    if (rewritable.length === 0 || !this.ai) {
      return templateResult(lines);
    }

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('phrasing timed out'));
        }, this.timeoutMs);
      });
      const raw = await Promise.race([this.generate(rewritable, controller.signal), timeout]);
      return applyPhrasing(lines, raw);
    } catch (error) {
      // The reason only - the prompt carries health values.
      const reason = controller.signal.aborted ? 'timeout' : ((error as Error)?.name ?? 'error');
      this.logger.warn(`Insight phrasing fell back to templates: ${reason}`);
      return templateResult(lines);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /** The one model call. Separate so tests can stand in for the network. */
  protected async generate(lines: readonly PlannedLine[], signal: AbortSignal): Promise<string | undefined> {
    if (!this.ai) {
      return undefined;
    }
    const input = lines.map((line) => ({ id: line.id, text: line.template, numbers: line.numbers }));
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(input) }] }],
      config: {
        systemInstruction: INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        abortSignal: signal,
      },
    });
    return response.text;
  }
}
