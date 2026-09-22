import { GoogleGenAI, Schema, Type } from '@google/genai';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DateTime } from 'luxon';
import { normalizeEventAt } from '../reminders/event-at';
import { EVENING_HOUR, MORNING_HOUR, RELATIVE_NOTIFY } from '../reminders/notify-times';
import {
  DEFAULT_RECURRENCE_HOUR,
  RECURRENCE_FREQ,
  WEEKDAYS,
  normalizeRecurrence,
} from '../reminders/recurrence';
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
        'People referred to, each in its BASE DICTIONARY FORM - nominative case, no grammatical ' +
        'inflection ("Антона" -> "Антон", "Олені" -> "Олена"). Include someone only if they could ' +
        'plausibly be a specific, recurring person: a proper name, or a personal/relational ' +
        'reference ("my wife", "сусідка"). Never a generic professional or service role (doctor, ' +
        'taxi driver, cashier, plumber). Empty if none.',
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
                  'current local time given below. Emit ONLY when the message gives both a ' +
                  'specific date AND an explicit clock time. Omit entirely otherwise - never ' +
                  'copy or assume the time of day from the current local time.',
              },
              hasTimeOfDay: {
                type: Type.BOOLEAN,
                description:
                  'true ONLY if the message states an explicit clock time (e.g. "at 12", ' +
                  '"18:00", "noon", "half past nine"). false when it names only a date or a ' +
                  'weekday with no time. Judge the words the user actually said - do NOT set ' +
                  'true just because eventAt has a time; the current local time is not a time ' +
                  'the user gave.',
              },
              notifyAt: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description:
                  'One entry per nudge the message asks for - "remind me the evening before AND ' +
                  'the morning of" is TWO entries. Each entry is either an ISO 8601 instant with ' +
                  'offset, or one of these keywords, which the bot resolves itself: ' +
                  `${RELATIVE_NOTIFY.join(', ')} ("_of" = the day of the event, "_before" = the ` +
                  'day before it). Prefer a keyword when the phrase is one of those; use an ISO ' +
                  'instant only when the user gave an explicit notify date and clock time. OMIT ' +
                  'this entirely when the message asks for no separate notify time - the bot then ' +
                  'nudges once, at the event itself.',
              },
              leadMinutes: {
                type: Type.INTEGER,
                description:
                  'Minutes before eventAt to remind. OMIT THIS unless the user actually said ' +
                  'how far ahead. Do not guess a default - the bot asks.',
              },
              recurrence: {
                type: Type.OBJECT,
                description:
                  'The repeat rule, ONLY when the message explicitly says this repeats (a ' +
                  'birthday or anniversary date, "every Monday", "every year on...", "on the 1st ' +
                  'of each month", "every day"). OMIT this object entirely for a one-off. Never ' +
                  'add a recurrence because a message sounds routine - a repeat the user did not ' +
                  'ask for fires forever. When a recurrence is present, OMIT eventAt: the bot ' +
                  'computes each occurrence from the rule itself.',
                properties: {
                  freq: { type: Type.STRING, format: 'enum', enum: [...RECURRENCE_FREQ] },
                  month: {
                    type: Type.INTEGER,
                    minimum: 1,
                    maximum: 12,
                    description: 'Month 1-12. Required for freq=yearly, omit otherwise.',
                  },
                  day: {
                    type: Type.INTEGER,
                    minimum: 1,
                    maximum: 31,
                    description:
                      'Day of the month 1-31. Required for freq=monthly and freq=yearly, omit ' +
                      'otherwise.',
                  },
                  weekday: {
                    type: Type.STRING,
                    format: 'enum',
                    enum: [...WEEKDAYS],
                    description: 'Required for freq=weekly, omit otherwise.',
                  },
                  atLocal: {
                    type: Type.STRING,
                    description:
                      'The stated local clock time as "HH:mm", 24-hour. OMIT when the message ' +
                      `named no time - the bot then uses ${DEFAULT_RECURRENCE_HOUR}:00 local. Do ` +
                      'not invent an hour.',
                  },
                  evidence: {
                    type: Type.STRING,
                    description:
                      'The exact words from the user\'s own message that say this repeats, ' +
                      'quoted verbatim - "every Monday", "щодня", "every year on". For a ' +
                      'birthday or anniversary, quote the phrase naming it as one. If there is ' +
                      'no real phrase to quote, do not add a recurrence object at all.',
                  },
                },
                required: ['freq', 'evidence'],
                propertyOrdering: ['freq', 'month', 'day', 'weekday', 'atLocal', 'evidence'],
              },
            },
            required: ['title', 'hasTimeOfDay'],
            propertyOrdering: [
              'title',
              'eventAt',
              'hasTimeOfDay',
              'notifyAt',
              'leadMinutes',
              'recurrence',
            ],
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
  'actor_info - a fact about a person ("my wife is allergic to penicillin"). Not a note. But a',
  '  recurring DATE about a person (a birthday, an anniversary) is a reminder - see Repeats below.',
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

    return this.parse(
      response.text,
      text,
      this.resolveNow(context.now),
      context.timezone || this.defaultTimezone,
    );
  }

  /** The instant relative reminders are validated against, from the context's local-ISO "now". */
  private resolveNow(now: string | undefined): Date {
    const parsed = now ? DateTime.fromISO(now, { setZone: true }) : undefined;
    return parsed?.isValid ? parsed.toJSDate() : new Date();
  }

  private buildInstruction(context: ClassifierContext): string {
    const timezone = context.timezone || this.defaultTimezone;
    const now = context.now || this.describeNow(timezone);
    const parts = [
      'You classify messages sent to a personal memory assistant. The user speaks or types a',
      'short message; you decide what kind of thing it is so the bot can file it. You never',
      'answer the message, never give advice, and never add information the user did not give.',
      '',
      'Intents:',
      INTENT_GUIDE,
      '',
      `Current local time: ${now} (timezone ${timezone}).`,
      'Resolve every relative date and time against that "now", and emit eventAt as ISO 8601 with',
      "the user's local offset. Date-resolution rules:",
      '- Emit eventAt ONLY when the message gives BOTH a specific date AND an explicit time of day.',
      '  If either is missing, omit eventAt and set hasTimeOfDay=false.',
      '- The current local time above is context for resolving dates, NOT a default time. Never copy',
      '  its hour/minute into eventAt. If the user named no clock time, there is no time to emit.',
      '- Set hasTimeOfDay=true only when the user stated an explicit clock time ("at 12", "18:00",',
      '  "noon"); set it false for a date/weekday with no time.',
      '- A bare weekday ("Thursday") means its next occurrence strictly after now.',
      '- "next {weekday}" means the occurrence in the following week, not tomorrow.',
      '- "the Nth" means the next occurrence of that day-of-month that is not before today.',
      'Examples (now = Wednesday):',
      '- "remind me on Thursday at 12 to get a haircut" -> eventAt = Thursday 12:00 local,',
      '  hasTimeOfDay=true.',
      '- "remind me on Thursday to call the doctor" -> NO time of day given, so omit eventAt and set',
      '  hasTimeOfDay=false. Do NOT reuse the current time.',
      '',
      'Notify times (notifyAt). eventAt is when the thing HAPPENS; notifyAt is when to NUDGE, and a',
      'message can ask for several nudges about one event. Rules:',
      `- Use the keywords where they fit: ${RELATIVE_NOTIFY.join(', ')}. The bot resolves "morning"`,
      `  to ${String(MORNING_HOUR).padStart(2, '0')}:00 and "evening" to ${EVENING_HOUR}:00 local,`,
      '  so do NOT invent an hour for them.',
      '- One entry per nudge asked for, in the order they were said.',
      '- Omit notifyAt when the message asks for no separate notify time. Do not add a default.',
      'Examples:',
      '- "doctor on the 22nd at 2PM, remind me the evening before and the morning of" ->',
      '  eventAt = the 22nd 14:00 local, notifyAt = ["evening_before", "morning_of"].',
      '- "remind me on the 25th at 12 to pay rent" -> eventAt = the 25th 12:00 local, notifyAt omitted.',
      '',
      'Repeats (recurrence). Emit the recurrence object ONLY when the message itself says the thing',
      'repeats. Rules:',
      '- A birthday or an anniversary IS a repeat: intent=reminder with freq=yearly on that month',
      '  and day, and a title naming whose it is. Do NOT file it as actor_info - there are no person',
      '  records yet, so it would be lost.',
      '- "every Monday" -> freq=weekly, weekday=monday. "on the 1st of each month" -> freq=monthly,',
      '  day=1. "every year on December 25" -> freq=yearly, month=12, day=25. "every morning" ->',
      '  freq=daily.',
      '- With a recurrence, OMIT eventAt and set hasTimeOfDay from the words as usual. The bot',
      `  resolves each occurrence itself and uses ${DEFAULT_RECURRENCE_HOUR}:00 local when no time`,
      '  was stated, so there is no hour to guess.',
      '- A one-off stays a one-off. "remind me on Monday at 8" is NOT weekly. Nothing about a',
      '  routine-sounding message makes it a repeat - only explicit repeating words do. A message',
      '  about a routine ACTION ("wife needs to take her pills", "I need to water the plants") is a',
      '  one-off unless it also names a repeat - the action being the kind of thing someone might',
      '  repeat daily is not the same as the user having asked for it daily.',
      '- Every recurrence must carry `evidence`: the exact words, quoted from the message, that say',
      '  it repeats. This is checked against the message text - a quote that is not really there',
      '  gets the whole recurrence discarded, so do not fill it with a paraphrase.',
      'Examples:',
      '- "Bob has a birthday on June 12" -> reminder, title "Bob\'s birthday",',
      '  recurrence = {freq: yearly, month: 6, day: 12}, no eventAt, no atLocal.',
      '- "Take out the trash every Monday at 8am" -> recurrence = {freq: weekly, weekday: monday,',
      '  atLocal: "08:00"}, no eventAt.',
      '',
      'People (mentions). The bot asks the user once about someone it does not know yet, so this',
      'list decides who it asks about. Rules:',
      '- Write each person in their BASE DICTIONARY FORM: nominative case, no grammatical',
      '  inflection, whatever case the sentence used. "привітати Антона" -> "Антон";',
      '  "подзвонити Олені" -> "Олена"; "передати документи Марії" -> "Марія".',
      '- Include someone only when they could plausibly be the same specific person every time: a',
      '  proper name, or a personal/relational reference (family, a friend, a neighbour, a named',
      '  colleague).',
      '- Never include a generic professional or service role with no ongoing relationship - лікар/',
      '  doctor, taxi driver, cashier, plumber, hairdresser. That is a different, unnamed person',
      '  each time, and asking about them is noise.',
      '- Never list anyone already named under "Known people" or "Declined mentions" below.',
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
      parts.push('', `Known people (never list these in mentions again): ${described}.`);
    }

    const declined = context.declinedMentions?.filter(Boolean) ?? [];
    if (declined.length > 0) {
      parts.push(
        '',
        'Declined mentions - the user has said these are not a person worth tracking, so never ' +
          `list them in mentions: ${declined.join(', ')}.`,
      );
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
  private parse(
    raw: string | undefined,
    original: string,
    now: Date,
    timezone: string,
  ): ClassificationResult {
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
      .map((item) => this.coerceItem(item, original, now, timezone))
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

  private coerceItem(
    value: unknown,
    original: string,
    now: Date,
    timezone: string,
  ): Classification | undefined {
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
      const notifyAt = stringArray(reminder.notifyAt);
      // A rule the resolver cannot compute occurrences for is dropped, not repaired: half a
      // recurrence ("weekly", no weekday) would have to be invented to be usable, and an
      // invented repeat fires forever at a time the user never named. Likewise a recurrence whose
      // `evidence` is not real text from the message - "sounds routine" is not the same as
      // "the user asked for it daily", and only the latter should fire forever.
      const recurrence = normalizeRecurrence(reminder.recurrence, timezone, original);
      if (reminder.recurrence && !recurrence) {
        this.logger.warn('Classifier recurrence rejected: unresolvable or not quoted from the message');
      }
      item.reminder = {
        title: reminder.title.trim(),
        eventAt: optionalString(reminder.eventAt),
        // Absent stays absent: an empty array would read as "asked for no nudge" rather than
        // "named no notify time", and the store resolves the latter to one nudge at eventAt.
        notifyAt: notifyAt.length > 0 ? notifyAt : undefined,
        leadMinutes: optionalInt(reminder.leadMinutes),
        recurrence,
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
    // the missing part, drop the confidence so the router's clarify branch picks it up. A reminder
    // needs a resolvable future eventAt too: with no clear time it must be asked about, never
    // stored with a guessed time (invent-nothing).
    //
    // hasTimeOfDay is a deterministic, code-enforced signal: the model reports whether the message
    // stated an explicit clock time. A model that copies the hour from "now" still produces a
    // valid-looking instant, which normalizeEventAt cannot catch - so a reminder whose time of day
    // was not actually stated is treated as unresolved even when eventAt parses.
    //
    // A valid recurrence is the one exception: it resolves its own occurrences from a wall-clock
    // rule, so a birthday ("on June 12", no clock time, no eventAt) is fully actionable and the
    // default 09:00 is the spec's fixed value rather than a guess by the model.
    const hasTimeOfDay = reminder?.hasTimeOfDay === true;
    const reminderUnresolved =
      intent === 'reminder' &&
      (!item.reminder ||
        (!item.reminder.recurrence &&
          (!hasTimeOfDay || !normalizeEventAt(item.reminder.eventAt, now))));
    const needsPayload = reminderUnresolved || (intent === 'symptom' && !item.symptom);
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
