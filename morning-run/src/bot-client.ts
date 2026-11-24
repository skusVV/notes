/**
 * Asks the bot to send the morning digest: `POST {baseUrl}/ingest/digest` (spec 0022). The bot
 * assembles and sends it; this side only triggers it.
 *
 * Never logs the secret or the response body (on the test function the body carries the digest
 * text). Only the HTTP status, `sent` and `reason` come back out.
 */
export interface DigestResult {
  /** Last HTTP status, or null when no try got an answer (network error or timeout). */
  status: number | null;
  tries: number;
  sent?: boolean;
  reason?: string;
}

export interface BotClientDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export const DIGEST_TRIES = 3;
export const DIGEST_PAUSE_MS = 5_000;
const TIMEOUT_MS = 60_000; // a cold start of the bot function plus Firestore reads

const defaultDeps: BotClientDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Retries only what can pass: a network error, a timeout, `5xx` or `429`. A repeat is safe because the
 * bot claims the day before sending. Any other answer - `200` with any `sent`/`reason`, or a `400`,
 * `401`, `403` configuration error - ends it at once. Never throws.
 */
export async function requestDigest(
  baseUrl: string,
  secret: string,
  userId: string,
  deps: BotClientDeps = defaultDeps,
): Promise<DigestResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/ingest/digest`;
  // The bot takes a number or a digit string; a number matches the documented body.
  const body = JSON.stringify({ userId: /^\d+$/.test(userId) ? Number(userId) : userId });
  let status: number | null = null;
  for (let tries = 1; ; tries++) {
    status = null;
    try {
      const res = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-secret': secret },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      if (res.ok) return { status, tries, ...(await readOutcome(res)) };
      if (status !== 429 && status < 500) return { status, tries };
    } catch {
      // Network error or timeout; the error text may carry the URL, so it is not logged.
    }
    if (tries >= DIGEST_TRIES) return { status, tries };
    console.warn(`digest request failed (${status === null ? 'network error' : `HTTP ${status}`}), retrying`);
    await deps.sleep(DIGEST_PAUSE_MS);
  }
}

/** Picks `sent` and `reason` out of the answer and drops everything else unread into any log. */
async function readOutcome(res: Response): Promise<{ sent?: boolean; reason?: string }> {
  try {
    const json = (await res.json()) as { sent?: unknown; reason?: unknown } | null;
    return {
      ...(typeof json?.sent === 'boolean' ? { sent: json.sent } : {}),
      ...(typeof json?.reason === 'string' ? { reason: json.reason } : {}),
    };
  } catch {
    return {};
  }
}
