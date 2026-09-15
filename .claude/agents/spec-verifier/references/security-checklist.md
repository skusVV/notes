# Bot security & spam checklist

The spec-verifier runs this over `git diff main...feat/<id>` after the functional criteria pass. It is
tailored to *this* bot - a public webhook that spends money on Gemini and stores health data - not a
generic list. Emit `PASS`, `ATTENTION`, or `FAIL` per section and an overall verdict (`FAIL` if any
section is `FAIL`; the pipeline treats `FAIL` as a rework).

## A. Access control - the money gate

- The `ALLOWED_USERS` gate (`isAllowed`) still runs **before** any voice download, transcription, or
  classification. No new code path reaches the model or downloads a file before the gate.
- With a list configured, an update whose `from` is missing is still refused.
- Verdict `FAIL` if any paid call can be reached by a non-allowlisted or unattributable sender.

## B. Webhook authentication & the response contract

- The `X-Telegram-Bot-Api-Secret-Token` check is intact: timing-safe compare, `401` on mismatch when
  a secret is configured, skipped only when unset.
- Every handled update still returns `200`; handling failures are logged, never returned as `5xx`
  (a `5xx` causes Telegram retry storms).
- Reply reflection stays gated behind `TEST_REFLECT_REPLY` and is off in production.
- Verdict `FAIL` on a `5xx` path, a broken/removed auth check, or reflection reachable in production.

## C. Cost & spam abuse

- The `MAX_VOICE_SECONDS` duration cap and the ~15 MB size cap are still checked **before** the file
  download, not after.
- No new path sends unbounded or attacker-controlled bulk input to a model.
- Verdict `ATTENTION` for a weakened cap; `FAIL` if a caller can trigger unbounded model spend.

## D. Prompt-injection surface

- User text flows into the classifier prompt. The model's output must remain confined: unknown intents
  are dropped, confidence is clamped, and a bad payload degrades to `other`/clarify (parse/coerce in
  the classifier).
- No code executes, evals, shells out, or makes an arbitrary call *driven by model output or user
  text*. A crafted message can only land in a known intent branch.
- Verdict `FAIL` if user/model text can cause an unintended action beyond the intent table.

## E. Secrets

- No secret value (token, webhook secret) is logged, echoed in a reply, or committed. `.env.example`
  and the repo contain no real secret.
- Any new secret follows the four-step ritual: `.env.example`, a Secret Manager secret, the
  `--set-secrets` list, and the accessor grant (see [CLAUDE.md](../../../CLAUDE.md)).
- Verdict `FAIL` on any leaked or committed secret.

## F. Health-data & PII logging discipline

- New log lines keep the sender's user id for traceability but **never** log transcript text,
  extraction output, or query results - lengths and ids only.
- Verdict `FAIL` if any private content is logged.

## G. Scope & blast radius

- The diff stays within the spec's declared Scope; nothing touches deploy config, the classifier, or
  transcription unless the spec said so.
- Verdict `ATTENTION` for out-of-scope edits, `FAIL` for an out-of-scope change to auth, the gate, or
  the response contract.
