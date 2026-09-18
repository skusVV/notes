/**
 * The intents the bot can act on. `other` is deliberately last and deliberately not an error:
 * an unclassifiable message is still something the user said, so it degrades to a note rather
 * than being dropped. See docs/architecture.md section 4.
 */
export const INTENTS = [
  'note',
  'reminder',
  'symptom',
  'question',
  'actor_info',
  'correction',
  'other',
] as const;

export type Intent = (typeof INTENTS)[number];

import { Recurrence } from '../reminders/recurrence';

/** How a question should be answered. Conflating these is the classic retrieval mistake. */
export const QUESTION_SHAPES = ['structured', 'semantic', 'mixed'] as const;
export type QuestionShape = (typeof QUESTION_SHAPES)[number];

export interface ReminderDraft {
  title: string;
  /** ISO 8601 with offset, resolved from relative speech using the user's timezone. */
  eventAt?: string;
  /**
   * When to nudge, one entry per notify time the message asked for - "remind me the evening before
   * and the morning of" is two. Each entry is an ISO 8601 instant with offset or one of the
   * relative keywords in `RELATIVE_NOTIFY`. Empty means the message named no notify time, which
   * resolves to a single notification at `eventAt`.
   */
  notifyAt?: string[];
  /** Absent means the user did not say - the bot has to ask rather than guess. */
  leadMinutes?: number;
  /**
   * A structured repeat rule, present **only** when the message explicitly said it repeats. A
   * recurring reminder needs no `eventAt`: each occurrence is computed from this rule instead, so
   * this being present is what makes a birthday ("on June 12", no clock time) storable.
   */
  recurrence?: Recurrence;
}

export interface SymptomDraft {
  /** Normalized slug, reused from the known vocabulary so aggregation works across wordings. */
  type: string;
  /** 1-10. Absent when not stated: a fabricated number pollutes every later average. */
  severity?: number;
  startedAt?: string;
  durationMinutes?: number;
  notes?: string;
}

export interface QuestionDraft {
  shape: QuestionShape;
  /** Free-text topic for the semantic path. */
  topic?: string;
  /** Normalized symptom slug when the question is about one. */
  symptomType?: string;
  /** ISO dates bounding the question, where it implies a range. */
  from?: string;
  to?: string;
}

export interface Classification {
  intent: Intent;
  /** 0-1. Drives whether the bot acts quietly, confirms visibly, or asks. */
  confidence: number;
  /** One-line restatement, used in the reply so a misread is visible immediately. */
  summary: string;
  reminder?: ReminderDraft;
  symptom?: SymptomDraft;
  question?: QuestionDraft;
}

export interface ClassificationResult {
  /** An array, not one label: "I have a headache and remind me to call the doctor" is two. */
  items: Classification[];
  /** BCP-47-ish tag of the message language, so replies can match it later. */
  language: string;
  /** Raw person surface forms as spoken ("my wife", "Andriy"). Captured before actors exist. */
  mentions: string[];
  /** Proper nouns and rare terms, for the keyword half of hybrid retrieval later. */
  keywords: string[];
}

/** What the classifier needs to know beyond the message itself. */
export interface ClassifierContext {
  /** IANA timezone. Without it every relative date ("tomorrow at 9") is a guess. */
  timezone: string;
  /**
   * Current local time as ISO 8601 with offset, in the user's timezone. The model cannot resolve
   * "Thursday" without knowing what day it is now, so this is required.
   */
  now: string;
  /** Existing symptom slugs, so "my head hurts" reuses `headache` instead of inventing. */
  knownSymptomTypes?: string[];
  /** Existing people and the forms used for them, so mentions resolve to one actor. */
  knownActors?: { name: string; aliases: string[] }[];
  /** The user's previous message, which is the only way `correction` can be detected. */
  previousText?: string;
}

/** Below this, treat as `other` and ask rather than file. */
export const CONFIDENCE_ASK = 0.5;
/** Between ASK and this, act but show the interpretation so a misread is catchable. */
export const CONFIDENCE_QUIET = 0.8;

/** A safe result for when the model is unreachable or returns something unusable. */
export function fallbackResult(text: string): ClassificationResult {
  return {
    items: [{ intent: 'other', confidence: 0, summary: text.slice(0, 200) }],
    language: 'unknown',
    mentions: [],
    keywords: [],
  };
}
