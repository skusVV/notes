# Second Memory - architecture plan

Plan for turning the Telegram echo bot into a personal memory: reminders, symptom tracking,
notes, recall by topic, and the people in your life.

**Status:** plan only. No code has been written for any of this.
**Rendered version:** https://claude.ai/code/artifact/a747cd47-1c69-49e1-927a-ebdc45987d48
**Current state of the bot:** gen2 Cloud Function, NestJS 11, text echo plus voice transcription
through Vertex AI, auto-deployed from a Cloud Build push trigger. See [../CLAUDE.md](../CLAUDE.md).

---

## Bottom line

All seven features come from one change: **the bot stops replying and starts remembering**.
Everything after that follows from where the memory lives and one rule about how it gets written.

New infrastructure is small: **Firestore** to store, **Cloud Scheduler** to wake the function when a
reminder is due, and **Vertex embeddings** for topic recall. No servers, no queue, no new secrets,
nothing to run locally. About **$1 a month** at ~20 messages/day, still dominated by the models
rather than the plumbing.

Build order is the part worth arguing about: **persistence and capture first, actors last**. Actors
are the one feature that gets better by arriving late, because it can label months of history in a
single pass.

---

## 1. The one rule

> **Capture is sacred. Interpretation is disposable.**

Every incoming message becomes an immutable record *before* any model looks at it. Intent, extracted
fields, person links and embeddings are written *alongside* that record as derived data - never
instead of it.

This sounds like a detail. It is the load-bearing decision:

- A model that misreads "remind me about the dentist" still leaves your words intact. You lose a
  reminder, not a memory.
- You can re-run extraction over your whole history with a better model later. Backfill becomes
  routine instead of a migration.
- Reminders, symptoms and recall all become *views over one log* rather than three separate stores
  that quietly drift apart.

The alternative - parse the message, store the parsed result, discard the rest - is how these
systems lose data for months before anyone notices.

---

## 2. What actually changes

**Today:** webhook -> allowlist -> echo the text, or transcribe the voice and reply. Fully
stateless. An instance can die at any moment and nothing is lost, because nothing was ever held.

**After:** same `200`-always webhook contract, but the reply is now the *last* step of a pipeline.
The function has to remember things between invocations, and it has to be woken up by a clock as
well as by Telegram.

Three capabilities the current code has none of:

1. **State between messages.** A pending question - "how long before?" - has to survive the instance
   that asked it. It almost never does; a different instance usually handles the answer.
2. **Time-triggered work.** Something must run when nobody sent a message. That is a genuinely new
   trigger, not a new branch.
3. **Retrieval.** Answering "how often do I get headaches" means reading history, not reacting to one
   message.

---

## 3. The pipeline

Every message, text or voice, takes the same eight steps. The ordering is load-bearing at three
points, flagged below.

| # | Step | What happens |
|---|------|--------------|
| 1 | **Receive** | Return `200` to Telegram whatever happens (existing contract). One new update type: `callback_query`, for button taps. |
| 2 | **Gate** | The `ALLOWED_USERS` check, before anything that costs money. *Ordering rule 1* - already in the code, now protecting database writes as well as model calls. |
| 3 | **Normalize** | Voice becomes a transcript via the existing `TranscriptionService`. Text passes through. Either way the output is one string, and nothing downstream knows which it was. |
| 4 | **Capture** | Write the entry, keyed on Telegram's `update_id`. *Ordering rule 2* - if every step after this fails, the user's words are still saved. |
| 5 | **Resolve pending** | Is there an open question for this chat, and is this an answer to it? *Ordering rule 3* - if it is **not** an answer, abandon the draft and continue to step 6. Never drop a new message to protect an old question. |
| 6 | **Classify + extract** | One Gemini call with a JSON schema. See [section 4](#4-classification). |
| 7 | **Act** | Reminder / symptom / note / question / correction. Each writes its own projection but keeps `entryId`. |
| 8 | **Confirm** | Reply with the *resolved* interpretation ("Tue 15 Sep, 09:00, one hour before your 10:00 appointment") plus a button to change it. |

---

## 4. Classification

Step 6 is the branch point for everything. It is one Gemini call returning structured JSON, wrapped
in its own outcome-named service - `ClassifierService.classify(text, context)` - for the same reason
`TranscriptionService` exists: it is the component most likely to be swapped, retuned, or replaced,
and it should be swappable in one file.

### The taxonomy

| Intent | Meaning | Where it goes |
|--------|---------|---------------|
| `note` | "Remember that I thought X" | entry only, embedded and tagged |
| `reminder` | Anything future-dated and actionable | `reminders` projection |
| `symptom` | A health event | `symptoms` projection |
| `question` | A read against your own memory | no write; runs retrieval ([section 7](#7-retrieval-rag)) |
| `actor_info` | "My wife's birthday is in May" | updates an `actors` record, not a note |
| `correction` | "No, that was 3pm" / "delete that" | mutates the **previous** entry's projection |
| `other` | None of the above, or unsure | see below |

Two of these are additions worth arguing for:

- **`correction` has to be an intent, not a feature.** If it isn't classified, "no, that was 3pm"
  gets stored as a cryptic note and the wrong reminder still fires. It also has to be checked
  against the *last* entry, which means the classifier prompt needs the previous entry as context.
- **`actor_info` is not a note.** "Olena's birthday is in May" should end up on the person, where a
  future reminder can find it, not buried in prose you have to search for.

### Slash commands never reach the classifier

Anything starting with `/` (`/export`, `/today`, `/why`) is routed deterministically before step 6.
Free, reliable, and it keeps the model out of the path for the operations you least want to be fuzzy.

### Multi-intent messages are the norm, not an edge case

"I have a headache and remind me to call the doctor tomorrow" is one voice memo and two intents.
Voice makes this common - people do not speak in single-purpose sentences.

**Decision: the schema returns an array of items, not one label.** One entry row, one classify call,
but possibly two projections written from it. This costs a few lines of schema and prevents an
entire class of silent data loss. Single-label classification would keep the headache and throw away
the doctor's appointment, and you would not notice until the appointment was missed.

### How `other` is handled

This is the question that decides how trustworthy the whole system feels. The layered answer:

**1. There is no such thing as an unstored message.** `other` is a label on the *derived* layer. The
entry row already exists from step 4, before the classifier ran. Being unclassified costs you a
projection, never the content.

**2. `other` degrades to `note`, not to an error.** An unclassifiable message is still something you
said and might want to find later, so it gets embedded and tagged and becomes findable by search.
The worst-case outcome of classifier failure is therefore "it became a searchable note" - the
mildest failure available.

**3. Three kinds of `other`, needing three different replies:**

| Case | Example | Response |
|------|---------|----------|
| Low confidence between known intents | "I should probably see someone about my knee" | **Ask**, with buttons: `[Symptom] [Reminder] [Just a note]`. One tap fixes the record. The only case worth interrupting for. |
| Confidently outside scope | "What's the weather tomorrow" | Say plainly that it is not something the bot does. Still stored. Do not silently swallow it. |
| Unintelligible | empty transcript, background noise | Store it, say you could not make it out, ask nothing. |

**4. Two confidence thresholds, not one:**

- below ~0.5 -> treat as `other`; ask only if there is a plausible second candidate
- 0.5 to 0.8 -> act, but confirm visibly ("Logged as a symptom - [not a symptom]")
- above 0.8 -> act with a quiet acknowledgement

The bot is then chatty exactly when it is unsure, which is the right friction profile. Confirmation
volume is the thing that makes people abandon a capture tool, so it should be earned.

**5. `other` is a metric, not just a branch.** Track the rate. Above a few percent means the
taxonomy is wrong or the prompt is stale - that is a signal to *add an intent*, not to lower the
threshold. Because `extraction` is stored on every entry, the `other` pile is directly reviewable: it
tells you what to build next. This is the only self-improvement loop in the design that actually
works.

**6. Classification failure must never block the reply.** If the Gemini call errors or times out, the
fallback is `other` -> stored as a note -> "Saved." That is the same degrade-don't-crash pattern
`TranscriptionService` already uses when `GCP_PROJECT` is missing.

### What the classifier needs in its prompt

A small context object, assembled before the call:

- current local time and IANA timezone (without this, every relative date is a guess)
- known actor names and aliases (so it reuses ids instead of inventing people)
- known symptom types (so "my head hurts" resolves to the existing `headache`)
- the previous entry (so corrections can be detected)

That is roughly one Firestore read, cacheable per instance with a short TTL since actors and symptom
types change rarely.

### One call or two?

**One.** A single call returning `{items: [{intent, confidence, payload}]}` is cheaper and halves
latency versus classify-then-extract. If a specific intent's extraction quality turns out to be poor,
split *that* intent into a second call - do not split all of them preemptively.

### The one place a test suite pays for itself

This project has no test framework, which has been fine. The classifier is the exception: a
regression here is **invisible** - nothing crashes, things just quietly land in the wrong place. A
fixture file of ~30 real messages mapped to expected intents, run on demand, is the cheapest quality
investment available here. Add it with phase 1.

---

## 5. New building blocks

| Piece | Job | Why this, not the obvious alternative |
|-------|-----|---------------------------------------|
| **Firestore** (Native, `europe-west1`) | Stores everything | Serverless, so no connection pool to manage from a function that scales to zero. Free tier (1 GiB, 50k reads/day, 20k writes/day) is far past one person. Has vector search built in, so recall needs no second system. Cloud SQL + pgvector queries and aggregates better but costs ~$10-25/mo idle and needs VPC plumbing. |
| **Cloud Scheduler** -> same function | Wakes a sweeper that delivers due reminders | One cron entry vs one Cloud Task per reminder. Rescheduling and cancelling become a field update instead of task surgery; a missed window catches up next tick; recurring reminders fall out for free. Cost: up to 60s delivery lag, meaningless for "an hour before your appointment". Cloud Tasks is the upgrade if exact-second delivery ever matters - and its 30-day horizon needs a fallback sweeper anyway. |
| **Vertex embeddings** | Topic recall | Same auth as transcription - the function's own service account, no API key. Fractions of a cent per thousand entries. |
| **Telegram inline keyboards** | Clarifications, confirmations, snoozes | Turns "how long before?" from a fragile free-text parse into a `callback_query` with an exact payload. Probably the biggest reliability win in the design, for one new update type. |

No new secret. Firestore and Vertex both authenticate as the function's own runtime service account,
exactly like transcription. Two IAM grants in the Console; nothing enters Secret Manager.

---

## 6. Data model

One capture log, typed projections off it, and one scratch document for unfinished conversations.
Everything scoped under a user, so a single subtree is one person's entire history.

### `users/{telegramUserId}`

| Field | Notes |
|-------|-------|
| `timezone` | IANA name, e.g. `Europe/Kyiv`. Not optional - see hard parts. |
| `locale`, `prefs` | Reply language, how chatty confirmations should be. |

### `users/{id}/entries/{updateId}` - the capture log

| Field | Notes |
|-------|-------|
| *doc id* | Telegram's `update_id`. This is what makes the pipeline safe to re-run. |
| `text` | The transcript, or the original message. The thing you must never lose. |
| `source` | `text` \| `voice` \| `photo` |
| `createdAt`, `chatId`, `telegramMessageId` | The message id lets a reply-to-fix find this entry again. |
| `intents[]` | Derived. Array, not a single value - see multi-intent above. |
| `extraction` | Derived. Raw model output, verbatim. Your debugging surface and your backfill input. |
| `mentions[]` | Derived. Raw surface forms as spoken: `"my wife"`, `"Andriy"`. Captured from day one, even before actors exist. |
| `actorIds[]`, `tags[]`, `keywords[]` | Derived. Resolved links and extracted terms. `keywords[]` is what makes hybrid retrieval work. |
| `ym` | Derived. `"2026-08"`. Exists only because vector pre-filters are equality-only, so a date range cannot pre-filter - see [section 7](#7-retrieval-rag). |
| `embedding` | Derived. Vector for semantic recall. |
| `embeddingModel` | Derived. Which model produced it - see [section 7](#7-retrieval-rag). |

### `users/{id}/reminders/{id}`

| Field | Notes |
|-------|-------|
| `title`, `eventAt` | What, and when the thing itself happens. |
| `remindAt` | UTC instant the sweeper compares against. |
| `leadMinutes` | How far ahead of `eventAt` to fire. The field the bot asks about when you omit it. |
| `recurrence` | Optional. Local wall-clock plus timezone, **not** a UTC instant. |
| `status` | `scheduled` \| `sent` \| `acked` \| `cancelled` |
| `entryId`, `actorIds[]` | Provenance, and who it involves. |

### `users/{id}/symptoms/{id}`

| Field | Notes |
|-------|-------|
| `type` | Normalized slug, e.g. `headache`. The field that makes "how often" possible at all. |
| `severity` | Optional 1-10. **Null when you did not say a number** - never inferred. |
| `startedAt`, `durationMinutes` | Where stated. |
| `notes` | Your own description, as you said it. |
| `entryId`, `actorIds[]` | So a symptom can belong to your son, not only to you. |

### `users/{id}/actors/{id}`

| Field | Notes |
|-------|-------|
| `name`, `relation` | "Olena", "wife". |
| `aliases[]` | Every form you actually use: `["wife", "Olena", "she"]`. What resolution matches on. |
| `notes`, `birthday` | Whatever you told it when it asked. |
| `declinedForms[]` | Mentions you said were not people, so it never asks twice. |

### `users/{id}/pending/{chatId}`

| Field | Notes |
|-------|-------|
| `draft` | The partly-extracted reminder or actor, waiting on one answer. |
| `question`, `options` | What was asked, and the button payloads that count as valid answers. |
| `expiresAt` | A Firestore TTL policy deletes it, so abandoned questions clean up with no sweeper. |

### The hidden hard part: normalization

"Headache", "my head hurts", "migraine" and "голова болить" have to land on **one** `type`, or "how
often do I get headaches" answers "once". Same problem with "my wife" / "Olena" / "she" resolving to
one person.

The fix is to pass your *existing* symptom vocabulary and person list into the classify prompt, so
the model picks from what is already there and only proposes something new when nothing fits. One
small read per message, and it is the difference between the aggregation features working and
silently never working. Designs that skip it look fine for weeks, because the bug only appears when
you ask a counting question.

---

## 7. Retrieval (RAG)

You are right not to want to send all your notes to the model. Retrieval is the fix, and it is not
just a workaround for a context limit - it is the more accurate design.

### The numbers, first

At 20 messages/day, a year is ~7,300 entries, roughly 500k tokens. Retrieving 10 entries is about
800 tokens - **0.2% of the corpus**. Even if the whole corpus fit in a long-context window, you
should not send it: cost scales linearly with tokens, and accuracy *drops* when the one relevant
note is buried among thousands of similar-looking ones. Sending less is both cheaper and better.

### Write path (indexing)

1. Entry is stored raw (pipeline step 4).
2. Compute an embedding of the text, store it as a vector field **on the entry**. No separate index
   store, no second database.
   - **Set `outputDimensionality: 768`** on the embed call. `gemini-embedding-001` returns **3072**
     dimensions by default and Firestore's vector index caps at **2048**, so the default
     configuration does not fit. The model is trained with Matryoshka Representation Learning, so a
     truncated prefix is still a valid embedding.
   - **Then normalize the vector yourself.** This is the part that bites silently: the 3072-dimension
     output is unit-normalized, but `gemini-embedding-001` **does not renormalize when you truncate**.
     Google's own docs say you must do it manually for any non-3072 size. Skip it and cosine
     similarity starts ranking partly by magnitude instead of direction - no error, just quietly
     worse retrieval. Three lines:

     ```ts
     /** gemini-embedding-001 does not renormalize truncated output. Firestore needs unit vectors. */
     function normalize(v: number[]): number[] {
       const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
       return norm > 0 ? v.map((x) => x / norm) : v;
     }
     ```

     Worth an assertion in the fixture test: the stored vector's L2 norm should be 1.0 within
     floating-point tolerance.
3. Store `embeddingModel` alongside it (see versioning below).
4. Store `keywords[]` from the classifier's extraction - proper nouns, medication names, numbers.
   This is what hybrid retrieval uses.

**Chunking:** start with **one vector per entry**. Below ~400 words the entry is the natural
retrieval unit, because it is also the citation unit ("you said this on 12 Aug"). But note
`MAX_VOICE_SECONDS=300` allows a five-minute memo, which at speaking pace is 700-900 words - long
enough that a single embedding smears several topics into an average that matches nothing well. When
you notice long memos retrieving badly, add ~200-word chunks in a subcollection with a pointer back
to the entry. The data model already supports this, so it is not a migration.

### Read path (retrieval)

1. Classifier returns `question`.
2. Produce a **query plan**, not an answer. Three shapes, and conflating them is the classic error:
   - **Structured** - "reminders this week", "how many headaches in August" -> a Firestore query.
   - **Semantic** - "when was I talking about the roof" -> vector search.
   - **Mixed** - "what did I say about school in August" -> metadata filter *plus* vector search.
3. For the semantic path: embed the question, then `findNearest` over `entries.embedding`, cosine
   distance, K=10 to start.
4. **Apply a distance threshold.** Without one, an unrelated question returns the 10
   least-unrelated notes and the model dutifully answers from them. The threshold is what lets the
   bot say "I have nothing about that" instead of confidently citing your dentist appointment.
5. **Pre-filter on metadata where the question implies it** - but only with equality.
   Firestore pre-filters a vector query using `==` plus `and`/`or` composites, given a composite
   index that pairs the vector field with the filtered field. **Inequality is not supported**, which
   means a date *range* cannot be a pre-filter. Store a coarse equality bucket instead - `ym:
   "2026-08"` on every entry - so "what did I say about school in August" pre-filters on
   `ym == "2026-08"` and then ranks. Filtering first and ranking second beats ranking everything and
   hoping.
6. Pass **only those K entries** to the model, each with its date and id, and a prompt that says:
   answer only from these, cite dates, and say you have nothing if they do not cover it.
7. Reply with the answer **and the source dates**, so a bad retrieval is visible immediately.

### The rule that keeps numbers honest

> The model chooses the query. **Code computes the number.** The model narrates the result.

Never let a model produce a count from memory. It will, confidently, and it will be wrong in a way
you cannot spot. "How often do I get headaches" must be a Firestore aggregation, not an inference.

### Hybrid retrieval - what pure vector search gets wrong

Embeddings are bad at exact terms. "When did I mention Dr. Kovalenko" is a keyword query, and vector
search will happily return "went to the doctor" instead of the entry naming her. Two cheap fixes:

- Run a **separate** `array-contains` query on `keywords[]` when the question contains a rare or
  capitalized term. It cannot be a pre-filter on the vector query - Firestore's vector pre-filters
  are equality-only - so this is a second, cheap query.
- **Union the two result sets** - keyword hits plus vector hits - deduplicate, then rank.

This is the single most common RAG failure in practice and it costs one extra array field plus one
extra query.

### Recency

"What was I thinking about last week" is a date query wearing a semantic disguise, and for genuine
ties a more recent note is usually the one you meant. Keep it simple: **rank by similarity to
select, sort by date to present**. Always show dates.

### Embedding model versioning

Embedding models change, and mixing two vector spaces in one collection silently produces
meaningless similarity scores - no error, just bad answers. Storing `embeddingModel` on each entry
turns that from a disaster into a query: find the stale ones, re-embed them. One field, real
insurance.

Also: Vertex embedding models take a task type. Use `RETRIEVAL_DOCUMENT` when indexing and
`RETRIEVAL_QUERY` when embedding the question. Using the same one for both measurably hurts recall
and is easy to miss because nothing fails.

### Cost of a question

One tiny embedding call, a Firestore read of K documents, one generation over ~800 tokens. About the
same as handling a normal message.

### Which GCP service, concretely

GCP offers at least six ways to do this and they differ by two orders of magnitude in cost. The
short version: **use Firestore's own `findNearest`**, and specifically do not reach for the service
with "Vector Search" in the name.

| Option | Verdict | Why |
|--------|---------|-----|
| **Firestore `findNearest`** | **Use this** | Vectors are a field on the entry you already store. No second service, no provisioning, no sync. Covered by the same free tier. Native `distanceThreshold` and `distanceResultField`. Node.js supported. |
| **Vertex AI Vector Search** | Avoid here | Purpose-built ANN that scales to billions - but it requires a deployed index endpoint billed **per node-hour regardless of traffic**. The cheapest node, `e2-standard-2`, is $0.077/hour = **~$56/month sitting idle**, roughly 56x this bot's entire projected bill. Right answer at millions of vectors, badly wrong at thousands. |
| **Vertex AI RAG Engine** (`RagManagedDb`, Spanner-backed) | No | Genuinely managed - it chunks, embeds, indexes and retrieves, no provisioning. But it is built around document corpora, and it would mean **a second copy of your data** to keep in sync with the Firestore entries that reminders and symptoms project from. Also bills index build, streaming updates and storage on top of inference. |
| **Cloud SQL / AlloyDB + pgvector** | No | Better querying and real aggregations, but ~$10-25/month minimum for the smallest always-on instance, plus VPC plumbing to reach from a function. |
| **BigQuery `VECTOR_SEARCH`** | No | Serverless and good at aggregation, but warehouse latency (seconds) on the interactive path. Possibly useful later for symptom analytics; wrong for answering a chat message. |
| **Brute force in the function** | Fallback only | At 7,300 entries a cosine scan is milliseconds of CPU. But it costs 7,300 document reads per question versus ~83 for `findNearest`, so it is *more* expensive, not less. Keep it as a mental fallback, not a plan. |

### What a question actually costs in Firestore

Billing for a kNN query is one read per batch of **100 kNN index entries scanned**, plus one read per
document actually returned. So a top-10 query over 7,300 entries is ~73 + 10 = **~83 reads**. Against
a 50,000 reads/day free tier, that is roughly 600 questions a day before you pay anything.

Free tier, Standard edition, confirmed current: 1 GiB stored, 50,000 reads/day, 20,000 writes/day,
20,000 deletes/day, 10 GiB/month egress, one free database per project.

### Console path for the vector index

This was the open question in the last version of this plan, and it is resolved: **no CLI needed.**

**Firestore -> select the database -> Indexes -> Manual tab -> Create Index -> Create vector index.**
Enter the Collection ID, the vector field path (`embedding`), the number of dimensions (`768`), and
optionally the extra fields to index alongside it - that last box is what enables equality
pre-filtering. Save, and wait for the green check.

Composite indexes for the pre-filtered queries follow the usual rule: do not guess them upfront, run
the query and take the Console link out of the error message.

### Embedding call details worth writing down

- Model `gemini-embedding-001`, `outputDimensionality: 768`, then normalize (above).
- `taskType: RETRIEVAL_DOCUMENT` when indexing an entry, `RETRIEVAL_QUERY` when embedding a
  question. Using one for both measurably hurts recall and nothing fails, so it is easy to miss.
- **One input text per request.** Unlike the older embedding models, `gemini-embedding-001` does not
  batch - each entry is its own call. Irrelevant for live traffic, but a backfill over a year of
  entries is ~7,300 sequential calls, so build it as a resumable loop, not a single pass.
- Input cap is 2048 tokens per text, and **excess is silently truncated** unless you set
  `autoTruncate: false`. A five-minute memo is ~1,000-1,200 tokens so this is not tight, but
  silent truncation is worth turning off so a long entry fails loudly instead of being half-indexed.
- $0.15 per 1M input tokens. A year of entries at this volume is roughly 600k tokens - about
  **$0.09 a year**. The embedding side of this is free in practice.
- Same authentication as transcription: the function's own service account, no API key.
- Same SDK too: `@google/genai` is already a dependency, and `ai.models.embedContent({ model,
  contents, config: { outputDimensionality: 768 } })` is the call shape.

### Why 768, with the actual numbers

Google publishes MTEB scores per MRL dimension for this model. The quality cost of truncating is
close to nothing:

| Dimensions | MTEB score |
|-----------:|-----------:|
| 2048 | 68.16 |
| 1536 | 68.17 |
| **768** | **67.99** |
| 512 | 67.55 |
| 256 | 66.19 |
| 128 | 63.31 |

768 gives up **0.17 points against 2048** and costs half the storage of 1536. Note that 1536 is
technically the best score in the table and also fits under Firestore's cap, so it is a defensible
alternative - but at 7,300 entries the storage difference is 22 MB versus 45 MB against a 1 GiB free
tier, so neither choice is constrained by anything real. Pick 768 and stop thinking about it.

### Why not `gemini-embedding-2`, which would fix the normalization problem

There is a newer model, `gemini-embedding-2` (April 2026). It is genuinely better on paper:
auto-normalizes truncated dimensions, natively multimodal across text/image/audio/video/PDF in one
shared space, 8,192 input tokens, 100+ languages.

**Staying on `gemini-embedding-001` anyway**, for three reasons:

1. It is **Public Preview**. This project auto-deploys on push, and embeddings must stay in one
   consistent vector space for the life of the corpus - a preview model changing behaviour underneath
   a year of stored vectors is the one failure here with no cheap recovery.
2. It **drops `taskType`** in favour of putting task instructions in the prompt. That trades a
   deterministic parameter for prompt wording, which is a downgrade for something on the write path.
3. The problem it solves for us is three lines of normalization.

Revisit when it reaches GA. The migration is already designed for: `embeddingModel` on every entry
makes finding the stale vectors a query, and re-embedding a year of history costs about ten cents.
The multimodal angle is the real prize - it would put a photographed prescription in the same
embedding space as your text notes, which makes the *Photos* idea in section 11 much more useful
than OCR-plus-text would be.

---

## 8. The five mechanics

### Reminders

- **Flow:** extract title, event time, lead time -> if lead time missing, ask with buttons -> store
  `remindAt` -> sweeper picks it up -> deliver with *Done* / *+1h* / *Tomorrow*.
- **Hard part:** "tomorrow at 9" is not a time. It only becomes one if the prompt knows your
  timezone and the current local time.
- **Decision:** store one-offs as a UTC instant; store **recurring** ones as local wall-clock plus
  timezone and resolve each occurrence - otherwise daylight saving shifts your 9am reminder by an
  hour twice a year, silently.

**Lifecycle:** `draft` (in `pending`, expires on its own) -> `scheduled` (resolved to UTC, confirmed
back to you) -> `due` (sweeper query matched) -> `sent` (flipped **inside a transaction**, so two
ticks cannot double-notify) -> `acked` (you tapped *Done*; *+1h* returns it to `scheduled`).

### Symptom tracking

- **Flow:** extract type, severity, start, duration -> normalize `type` against the existing
  vocabulary -> store.
- **Hard part:** severity is usually absent or vague ("pretty bad"). Store null rather than inventing
  a number; one fabricated 7 pollutes every average you ever compute.
- **Decision:** your own words always survive on the entry, so a missing or wrong field never costs
  you what you actually described.

### Notes

- **Flow:** capture, embed, tag, confirm.
- **Hard part:** there isn't one. Pipeline steps 4 and 8 already do it.
- **Decision:** this is exactly why persistence comes first. The moment entries exist, "just remember
  this" works with no intelligence at all - which makes phase 0 useful on its own rather than
  scaffolding you cannot try.

### Recall and questions

See [section 7](#7-retrieval-rag). The short version: three query shapes, a query plan rather than a
freeform answer, and code computes any number.

### Actors

- **Flow:** classifier returns raw mentions -> an unmatched one triggers "Add **wife** as a person?
  `[Yes] [No] [Not a person]`" -> on yes, collect relation and notes -> later mentions resolve
  through aliases.
- **Hard part:** taken literally, "ask whenever I talk about somebody" means a prompt on almost every
  message. Three guards: only unmatched forms, at most one question per message, and remember what
  you declined.
- **Decision:** capture `mentions[]` from day one, resolve to actors later. That is what lets this
  ship last and still label your entire history in one backfill pass.

---

## 9. Cross-cutting hard parts

These sink naive builds. None is difficult; all are easy to leave out.

**Timezone.** The function runs in UTC. Without a per-user timezone and "it is currently 14:20 on
Tuesday in Europe/Kyiv" in the prompt, every relative date is a coin flip. One field, outsized
consequences.

**Idempotency.** Telegram retries a webhook it considers slow. Today a retry costs a duplicate
transcription. With storage, a retry creates a **duplicate reminder**. Keying entries on `update_id`
fixes it for nothing. Delivery needs the same care: flip `status` to `sent` inside a transaction.

**Pending state must be in the database.** Never in memory. The instance handling your answer is
usually not the one that asked. And it must never block a capture - an unanswered question expires
quietly, it does not hold your notes hostage.

**Confidence.** When classification is unsure, ask rather than file. A wrong guess is worse than a
question, because you will not find out for weeks - and by then you have lost the context to correct
it.

**This is health data now.** Symptoms are health information and notes are private thoughts. Keep the
existing "log lengths, not content" discipline and extend it: never log transcripts, extraction
output, or query results. Fine for personal use. If it ever serves anyone else, that is a compliance
conversation, not a config change.

**Audio retention.** Decide once and write it down: keep the original OGG in Cloud Storage for
re-transcription, or discard it after transcribing. Recommend discarding - the transcript is the
artifact, and the audio is the most sensitive object in the system.

---

## 10. Build order

Numbered because the dependencies are real. Each phase leaves something usable.

**0. Persistence and capture.** Firestore, entries keyed on `update_id`, a user timezone. No
intelligence whatsoever.
*Usable:* "remember this thought" already works. *Why first:* it de-risks everything above it, and
it is the phase where the sacred-capture rule either gets built in or gets lost.

**1. Classifier and confirmations.** `ClassifierService`, the intent array, the `other` ladder,
visible confirmations, a correction path, and the fixture test file.
*Why here:* the three mitigations for silent misclassification - immutable capture, visible
confirmation, easy correction - only work as a set. Shipping confirmation later means weeks of
unnoticed misfiling.

> **Built out of order, on request.** The classifier and the per-intent branching shipped *before*
> phase 0, so the routing could be judged against real messages before any schema was committed to.
> Done: `ClassifierService`, the seven intents, multi-intent arrays, the confidence ladder,
> deterministic command routing, defensive parsing, and one branch per intent that composes a reply.
> Not done, and still needing phase 0: persistence (so nothing is stored, and every reply says so),
> `correction` (needs the previous entry), `question` (needs history to search), inline keyboards for
> clarification, and populating `ClassifierContext` with known slugs and people - which is what stops
> the model inventing a new symptom slug per wording.

**2. Reminders.** Pending-question state machine, inline keyboards, the Scheduler sweeper, delivery
idempotency.
*Why here:* first feature needing both state and a clock, so it forces both to be built properly
rather than improvised.

**3. Symptoms.** The normalized vocabulary, plus the doctor-visit summary that makes the tracking
worth doing.
*Why here:* reuses the classify-confirm-store path from phase 2 with no new infrastructure.

**4. Recall.** Structured queries first - deterministic and immediately useful - then embeddings, the
vector index, and hybrid keyword retrieval.
*Why here:* semantic search over an empty corpus proves nothing. By now there is real data to tune
against.

**5. Actors.** Detection, the ask, aliases, then a backfill pass that labels existing entries.
*Why last:* the only feature that improves by arriving late. It can retro-label months of history in
one pass - and the mentions it needs were captured since phase 1.

---

## 11. Ideas worth adding

| Idea | Why it matters | Effort |
|------|----------------|--------|
| **Corrections and undo** | "No, that was 3pm", or reply to the bot's own message to fix that entry - Telegram's native reply gives targeting with no ids to remember. Extraction is fuzzy; without a fix path every error is permanent. **Highest value per hour here.** | Small |
| **Doctor-visit summary** | "My headaches over the last three months" as a clean dated list you can hand over. Arguably the actual point of symptom tracking - real output, not a dashboard you stop opening. | Small |
| **Morning digest** | A scheduled message with today's reminders and anything open. Reuses the sweeper; turns the bot from reactive into present. | Small |
| **Snooze buttons on delivery** | *Done* / *+1h* / *Tomorrow*. A reminder you cannot defer gets ignored, and then all of them do. | Small |
| **`/export`** | Everything as JSON or Markdown on demand. Your backup and your exit. A personal memory you cannot get data out of is a liability. | Small |
| **`/why`** | Show the stored `extraction` for the last entry. You will want it the first time something is misfiled, and it is already on the record. | Trivial |
| **Photos** | A prescription, a lab result, a whiteboard. Gemini is already multimodal: same pipeline, one new branch, `source: 'photo'`. | Medium |
| **Recurring reminders / medication** | Natural once reminders exist - and the thing that makes the daylight-saving decision start to matter. | Medium |
| **Symptom correlation** | "Headaches cluster the day after a late night." Genuinely interesting, but be honest: correlation over a few dozen events for one person is very easy to over-read. Present as "worth noticing", never as a finding. | Later |

---

## 12. Risks and open questions

**[irreversible] Firestore location is permanent.** Chosen once per project, never changeable. Pick
`europe-west1` to match the function, or every read pays a cross-continent hop forever. The one step
here you cannot undo.

**[resolved] Creating a vector index without a CLI.** Verified: the Console supports it directly, at
**Firestore -> Indexes -> Manual -> Create Index -> Create vector index**. Phase 4 needs no CLI.

**[resolved, with a trap] Embedding dimensions and normalization.** `gemini-embedding-001` returns
**3072 dimensions by default while Firestore's vector index caps at 2048**, so the default
configuration fails outright - set `outputDimensionality: 768`. The quieter half: truncated output is
**not renormalized by the model**, and unnormalized vectors degrade cosine ranking without erroring.
Normalize on write and assert the L2 norm in a test. Keep the model id environment-driven like
`TRANSCRIPTION_MODEL`; this project has already been through one product rename.

**[watch] Vector pre-filters are equality-only.** No inequality, so date ranges cannot pre-filter,
and `array-contains` cannot either. Both have workarounds in section 7 (a `ym` bucket field, and a
separate unioned keyword query), but a design that assumes range pre-filtering will hit a wall in
phase 4.

**[watch] Silent misclassification.** The main failure mode of the whole system, and quiet by nature.
Immutable capture, visible confirmations, and an easy correction path are the three mitigations, and
all three belong in phase 1.

**[watch] Vector search returning plausible-but-wrong context.** Mitigated by the distance threshold,
hybrid keyword retrieval, and always citing source dates in the reply so you can see what it read.

**[open] How chatty should it be?** Every confirmation and every actor question is friction, and
friction is what makes people stop using a capture tool. Suggested: always confirm reminders (a wrong
time means a missed appointment); acknowledge symptoms and notes with a quiet tick; ask about a new
person at most once per message. Worth deciding deliberately rather than discovering it is annoying
in week three.

**[deadline, unrelated] `nodejs20` cannot be deployed after 2026-10-30.** Still outstanding from the
voice work. It will silently break auto-deploy - a push that simply stops producing a new revision.
Worth clearing before phase 0.

---

## 13. Cost

At roughly 20 messages/day. The models dominate; infrastructure is effectively free at this scale.

| Item | Per month | Note |
|------|-----------|------|
| Gemini transcription | ~$0.35 | Existing, unchanged. |
| Gemini classify + extract | ~$0.30 | One structured call per message. |
| Embeddings (write) | <$0.05 | One per entry. |
| Embeddings (queries) | <$0.01 | One per question. |
| Retrieval generation | ~$0.05 | ~800 tokens of context per question. |
| Firestore | $0 | ~600 writes/month against a 20k/day free tier. |
| Cloud Scheduler | $0 | Three jobs free; one needed. |
| Function invocations | $0 | ~44k sweeper ticks plus traffic, against 2M free. |
| **Total** | **~$1** | Roughly double today's bill, for all seven features. |

The sweeper is the one line that might surprise: a per-minute cron means ~43,200 extra invocations a
month. That sits inside the gen2 free tier, and it keeps an instance warm, so your own messages get
answered without a cold start. A five-minute tick cuts it by 80% and costs five minutes of reminder
precision.

---

## 14. Console setup

All click-paths, per [../CLAUDE.local.md](../CLAUDE.local.md). No CLI, no new secrets - Firestore and
Vertex both authenticate as the function's own service account, like transcription.

1. **Firestore -> Create database** -> Native mode -> `europe-west1`. **This location is permanent.**
2. **IAM & Admin -> IAM** -> grant `64701441694-compute@developer.gserviceaccount.com` the role
   **Cloud Datastore User** (`roles/datastore.user`). Confusingly, that role governs Firestore in
   Native mode too, despite the Datastore name.
3. **Cloud Scheduler -> Create job** -> frequency `* * * * *`, timezone `Europe/Kyiv`, target HTTP,
   URL the function plus a reminders path, and a header carrying a shared secret - the same pattern
   the Telegram webhook already uses, so nobody else can trigger it.
4. **Firestore -> Time-to-live** -> add a policy on `pending.expiresAt`, so abandoned clarifications
   delete themselves with no sweeper of their own.
5. **Firestore -> Indexes** -> add composite indexes as queries demand them. Do not guess upfront:
   run the query, take the Console link from the error.
