import { GoogleGenAI, Schema, Type } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Classification,
  ClassificationResult,
  ClassifierContext,
  CONFIDENCE_ASK,
  Intent,
  INTENTS,
  QUESTION_SHAPES,
  QuestionShape,
  fallbackResult,
} from './classifier.types';

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_LOCATION = 'global';
const DEFAULT_TIMEZONE = 'UTC';

/** Thrown when `classify` is called with no project configured. */
export class ClassifierUnavailableError extends Error {}

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    language: {
      type: Type.STRING,
      description: 'BCP-47 tag of the message language, e.g. "en" or "uk".',
    },
    mentions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'People referred to, as the exact words used ("my wife", "Andriy"). Empty if none.',
    },
    keywords: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        'Proper nouns, medication names, places and rare terms worth searching for later.',
    },
    items: {
      type: Type.ARRAY,
      description:
        'One entry per intent present. A message can contain several: "I have a headache and ' +
        'remind me to call the doctor" is a symptom AND a reminder. Never merge them.',
      items: {
        type: Type.OBJECT,
        properties: {
          intent: { type: Type.STRING, format: 'enum', enum: [...INTENTS] },
          confidence: {
            type: Type.NUMBER,
            description:
              'How sure you are, 0 to 1. Be honest: below 0.5 the bot asks the user instead ' +
              'of filing it, which is the correct outcome when the message is ambiguous.',
          },
          summary: {
            type: Type.STRING,
            description: 'One short line restating this intent, in the language of the message.',
          },
          reminder: {
            type: Type.OBJECT,
            description: 'Only for intent=reminder.',
            properties: {
              title: { type: Type.STRING, description: 'What should happen.' },
              eventAt: {
                type: Type.STRING,
                description:
                  'When the event itself happens, ISO 8601 with offset, resolved from the ' +
                  'current local time given below. Omit if the message gives no time at all.',
              },
              leadMinutes: {
                type: Type.INTEGER,
                description:
                  'Minutes before eventAt to remind. OMIT THIS unless the user actually said ' +
                  'how far ahead. Do not guess a default - the bot asks.',
              },
              recurrence: {
                type: Type.STRING,
                description: 'Plain description if it repeats, e.g. "every day at 09:00".',
              },
            },
            required: ['title'],
            propertyOrdering: ['title', 'eventAt', 'leadMinutes', 'recurrence'],
          },
          symptom: {
            type: Type.OBJECT,
            description: 'Only for intent=symptom.',
            properties: {
              type: {
                type: Type.STRING,
                description:
                  'Lowercase English snake_case slug, e.g. "headache", "sore_throat". Reuse an ' +
                  'existing slug from the known list when it fits, even if the user used ' +
                  'different words or another language.',
              },
              severity: {
                type: Type.INTEGER,
                minimum: 1,
                maximum: 10,
                description:
                  'OMIT unless the user gave a number or an explicit scale. Never infer one ' +
                  'from words like "bad" - a made-up number corrupts every later average.',
              },
              startedAt: { type: Type.STRING, description: 'ISO 8601 with offset, if stated.' },
              durationMinutes: { type: Type.INTEGER, description: 'If stated.' },
              notes: {
                type: Type.STRING,
                description: "The user's own description, kept in their words.",
              },
            },
            required: ['type'],
            propertyOrdering: ['type', 'severity', 'startedAt', 'durationMinutes', 'notes'],
          },
          question: {
            type: Type.OBJECT,
            description: 'Only for intent=question.',
            properties: {
              shape: {
                type: Type.STRING,
                format: 'enum',
                enum: [...QUESTION_SHAPES],
                description:
                  'structured = countable or date-bounded ("how many headaches in August", ' +
                  '"reminders this week"). semantic = about a topic ("when did I talk about the ' +
                  'roof"). mixed = both.',
              },
              topic: { type: Type.STRING, description: 'The subject, for a semantic search.' },
              symptomType: { type: Type.STRING, description: 'Slug, if the question names one.' },
              from: { type: Type.STRING, description: 'ISO date lower bound, if implied.' },
              to: { type: Type.STRING, description: 'ISO date upper bound, if implied.' },
            },
            required: ['shape'],
            propertyOrdering: ['shape', 'topic', 'symptomType', 'from', 'to'],
          },
        },
        required: ['intent', 'confidence', 'summary'],
        propertyOrdering: ['intent', 'confidence', 'summary', 'reminder', 'symptom', 'question'],
      },
    },
  },
  required: ['items', 'language', 'mentions', 'keywords'],
  propertyOrdering: ['language', 'mentions', 'keywords', 'items'],
};

const INTENT_GUIDE = [
  'note - a thought, fact or observation to remember. The default for anything worth keeping.',
  'reminder - something to be reminded about later. Needs a time or the bot will ask.',
  'symptom - a health event the user or someone they name is experiencing.',
  'question - asking to read back their own history. Never answer it; just classify it.',
  'actor_info - a fact about a person ("my wife\'s birthday is in May"). Not a note.',
  'correction - fixing or deleting what they just said ("no, that was 3pm"). Needs the previous',
  '  message to make sense, which is given below when there is one.',
  'other - genuinely none of the above, or you are not sure enough to pick. Not an error.',
].join('\n');

/**
 * Turns a message into intents the bot can branch on. Named for the outcome, not the vendor:
 * swapping the model or moving to a fine-tuned classifier should touch this file only.
 */
@Injectable()
export class ClassifierService {
  private readonly logger = new Logger(ClassifierService.name);
  private readonly model: string;
  private readonly ai?: GoogleGenAI;
  readonly defaultTimezone: string;

  constructor(config: ConfigService) {
    this.model = config.get<string>('CLASSIFIER_MODEL')?.trim() || DEFAULT_MODEL;
    this.defaultTimezone = this.parseTimezone(config.get<string>('DEFAULT_TIMEZONE'));

    const location = config.get<string>('VERTEX_LOCATION')?.trim() || DEFAULT_LOCATION;
    const project =
      config.get<string>('GCP_PROJECT')?.trim() ||
      config.get<string>('GOOGLE_CLOUD_PROJECT')?.trim();

    if (!project) {
      // Same rule as TranscriptionService: never throw. Without this the bot must still echo.
      this.logger.warn('GCP_PROJECT is not set - messages cannot be classified');
      return;
    }

    this.ai = new GoogleGenAI({ vertexai: true, project, location });
    this.logger.log(
      `Classifying with ${this.model} via Vertex AI (${project}, ${location}), ` +
        `timezone ${this.defaultTimezone}`,
    );
  }

  /** An unknown IANA name would throw on every message, so it is checked once at startup. */
  private parseTimezone(raw: string | undefined): string {
    const value = raw?.trim();
    if (!value) {
      return DEFAULT_TIMEZONE;
    }

    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format(new Date());
      return value;
    } catch {
      this.logger.warn(`DEFAULT_TIMEZONE "${value}" is not a valid IANA name, using UTC`);
      return DEFAULT_TIMEZONE;
    }
  }

  get available(): boolean {
    return this.ai !== undefined;
  }

  async classify(text: string, context: ClassifierContext): Promise<ClassificationResult> {
    if (!this.ai) {
      throw new ClassifierUnavailableError('GCP_PROJECT is not set');
    }

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text }] }],
      config: {
        systemInstruction: this.buildInstruction(context),
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        // Classification should be repeatable: the same message twice must not land in two
        // different collections.
        temperature: 0,
      },
    });

    return this.parse(response.text, text);
  }

  private buildInstruction(context: ClassifierContext): string {
    const timezone = context.timezone || this.defaultTimezone;
    const parts = [
      'You classify messages sent to a personal memory assistant. The user speaks or types a',
      'short message; you decide what kind of thing it is so the bot can file it. You never',
      'answer the message, never give advice, and never add information the user did not give.',
      '',
      'Intents:',
      INTENT_GUIDE,
      '',
      `Current local time: ${this.describeNow(timezone)} (timezone ${timezone}).`,
      'Resolve every relative time ("tomorrow at 9", "in two hours") against that, and emit ISO',
      '8601 with an offset. If the message states no time, omit the field rather than inventing one.',
      '',
      'Rules that matter more than being helpful:',
      '- Omit any field the user did not actually state. An absent value is correct; a guessed',
      '  value is a silent error the user will not notice for weeks.',
      '- Return one item per intent present, not one item per message.',
      '- Free text stays in the user\'s language. Slugs (symptom type) are English snake_case.',
      '- Lower your confidence when the message is ambiguous. Asking is a good outcome.',
    ];

    const symptoms = context.knownSymptomTypes?.filter(Boolean) ?? [];
    if (symptoms.length > 0) {
      parts.push(
        '',
        `Known symptom slugs - reuse one of these when it fits: ${symptoms.join(', ')}.`,
      );
    }

    const actors = context.knownActors?.filter((a) => a.name) ?? [];
    if (actors.length > 0) {
      const described = actors
        .map((a) => (a.aliases.length > 0 ? `${a.name} (${a.aliases.join(', ')})` : a.name))
        .join('; ');
      parts.push('', `Known people: ${described}.`);
    }

    if (context.previousText) {
      parts.push(
        '',
        `The user's previous message was: "${context.previousText}". Use it only to decide`,
        'whether this new message is a correction to it.',
      );
    }

    return parts.join('\n');
  }

  private describeNow(timezone: string): string {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'short',
        hour12: false,
      }).format(new Date());
    } catch {
      return new Date().toISOString();
    }
  }

  /**
   * Structured output makes malformed replies unlikely, not impossible - and a model that
   * invents an intent must not crash the webhook. Anything unusable becomes `other`, which the
   * router already knows how to handle.
   */
  private parse(raw: string | undefined, original: string): ClassificationResult {
    const body = raw?.trim();
    if (!body) {
      this.logger.warn('Classifier returned an empty body');
      return fallbackResult(original);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(body));
    } catch {
      this.logger.warn('Classifier returned unparseable JSON');
      return fallbackResult(original);
    }

    const root = parsed as Record<string, unknown> | null;
    const rawItems = Array.isArray(root?.items) ? root.items : [];
    const items = rawItems
      .map((item) => this.coerceItem(item))
      .filter((item): item is Classification => item !== undefined);

    if (items.length === 0) {
      this.logger.warn('Classifier returned no usable items');
      return fallbackResult(original);
    }

    return {
      items,
      language: typeof root?.language === 'string' ? root.language : 'unknown',
      mentions: stringArray(root?.mentions),
      keywords: stringArray(root?.keywords),
    };
  }

  private coerceItem(value: unknown): Classification | undefined {
    const raw = value as Record<string, unknown> | null;
    if (!raw || typeof raw.intent !== 'string') {
      return undefined;
    }

    const intent = raw.intent as Intent;
    if (!INTENTS.includes(intent)) {
      this.logger.warn(`Classifier returned unknown intent "${raw.intent}"`);
      return undefined;
    }

    const confidence =
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.min(1, Math.max(0, raw.confidence))
        : 0;
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';

    const item: Classification = { intent, confidence, summary };

    const reminder = raw.reminder as Record<string, unknown> | undefined;
    if (intent === 'reminder' && typeof reminder?.title === 'string' && reminder.title.trim()) {
      item.reminder = {
        title: reminder.title.trim(),
        eventAt: optionalString(reminder.eventAt),
        leadMinutes: optionalInt(reminder.leadMinutes),
        recurrence: optionalString(reminder.recurrence),
      };
    }

    const symptom = raw.symptom as Record<string, unknown> | undefined;
    if (intent === 'symptom' && typeof symptom?.type === 'string' && symptom.type.trim()) {
      item.symptom = {
        type: symptom.type.trim().toLowerCase(),
        severity: clampSeverity(symptom.severity),
        startedAt: optionalString(symptom.startedAt),
        durationMinutes: optionalInt(symptom.durationMinutes),
        notes: optionalString(symptom.notes),
      };
    }

    const question = raw.question as Record<string, unknown> | undefined;
    if (intent === 'question') {
      const shape = question?.shape as QuestionShape | undefined;
      item.question = {
        // 'semantic' is the safe default: it searches rather than asserting a number.
        shape: shape && QUESTION_SHAPES.includes(shape) ? shape : 'semantic',
        topic: optionalString(question?.topic),
        symptomType: optionalString(question?.symptomType)?.toLowerCase(),
        from: optionalString(question?.from),
        to: optionalString(question?.to),
      };
    }

    // An intent whose payload did not survive validation is not actionable. Rather than invent
    // the missing part, drop the confidence so the router's clarify branch picks it up.
    const needsPayload =
      (intent === 'reminder' && !item.reminder) || (intent === 'symptom' && !item.symptom);
    if (needsPayload) {
      this.logger.warn(`Classifier returned ${intent} without a usable payload`);
      item.confidence = Math.min(item.confidence, CONFIDENCE_ASK - 0.01);
    }

    return item;
  }
}

/** responseMimeType should prevent fences, but a stray ```json costs one cheap guard. */
function stripFence(body: string): string {
  if (!body.startsWith('```')) {
    return body;
  }
  return body.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.round(value);
}

/** Out-of-range severity is likelier to be a hallucination than a real reading. */
function clampSeverity(value: unknown): number | undefined {
  const parsed = optionalInt(value);
  if (parsed === undefined || parsed < 1 || parsed > 10) {
    return undefined;
  }
  return parsed;
}
