import test from 'node:test';
import assert from 'node:assert/strict';
import { BotClientDeps, DIGEST_PAUSE_MS, requestDigest } from './bot-client';

const SECRET = 'not-a-real-secret-0123456789';

interface Call { url: string; init: RequestInit }

/** A stand-in fetch that plays back answers in order: a status/body pair, or 'network' to throw. */
function fakeDeps(answers: Array<{ status: number; body?: unknown } | 'network'>) {
  const calls: Call[] = [];
  const pauses: number[] = [];
  const deps: BotClientDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const a = answers[Math.min(calls.length, answers.length) - 1];
      if (a === 'network') throw new TypeError(`fetch failed for ${url}`);
      return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status });
    }) as typeof fetch,
    sleep: async (ms: number) => { pauses.push(ms); },
  };
  return { deps, calls, pauses };
}

/** Captures everything written to the console while `fn` runs. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { result: await fn(), logs: lines.join('\n') };
  } finally {
    Object.assign(console, saved);
  }
}

test('posts the documented request', async () => {
  const f = fakeDeps([{ status: 200, body: { ok: true, sent: true } }]);
  const r = await requestDigest('https://bot.example/', SECRET, '777888', f.deps);
  assert.deepEqual(r, { status: 200, tries: 1, sent: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://bot.example/ingest/digest');
  const init = f.calls[0].init;
  assert.equal(init.method, 'POST');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers['x-ingest-secret'], SECRET);
  assert.equal(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body as string), { userId: 777888 });
});

test('200 with a reason is the end, not an error', async () => {
  for (const reason of ['disabled', 'empty', 'already_sent', 'send_failed']) {
    const f = fakeDeps([{ status: 200, body: { ok: true, sent: false, reason } }]);
    assert.deepEqual(await requestDigest('https://bot.example', SECRET, '1', f.deps), { status: 200, tries: 1, sent: false, reason });
    assert.equal(f.calls.length, 1);
  }
});

test('400, 401 and 403 are not retried', async () => {
  for (const status of [400, 401, 403]) {
    const f = fakeDeps([{ status, body: { message: 'nope' } }]);
    assert.deepEqual(await requestDigest('https://bot.example', SECRET, '1', f.deps), { status, tries: 1 });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.pauses, []);
  }
});

test('5xx is retried up to 3 tries with a 5 s pause', async () => {
  const f = fakeDeps([{ status: 503 }]);
  assert.deepEqual(await requestDigest('https://bot.example', SECRET, '1', f.deps), { status: 503, tries: 3 });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.pauses, [DIGEST_PAUSE_MS, DIGEST_PAUSE_MS]);
  assert.equal(DIGEST_PAUSE_MS, 5_000);
});

test('a network error is retried, then a 200 ends it', async () => {
  const f = fakeDeps(['network', { status: 500 }, { status: 200, body: { ok: true, sent: true } }]);
  assert.deepEqual(await requestDigest('https://bot.example', SECRET, '1', f.deps), { status: 200, tries: 3, sent: true });
  assert.equal(f.calls.length, 3);
});

test('network errors on every try give no status and never throw', async () => {
  const f = fakeDeps(['network']);
  assert.deepEqual(await requestDigest('https://bot.example', SECRET, '1', f.deps), { status: null, tries: 3 });
  assert.equal(f.calls.length, 3);
});

test('an unreadable 200 body still ends it', async () => {
  const deps: BotClientDeps = {
    fetch: (async () => new Response('not json', { status: 200 })) as typeof fetch,
    sleep: async () => {},
  };
  assert.deepEqual(await requestDigest('https://bot.example', SECRET, '1', deps), { status: 200, tries: 1 });
});

test('never logs the secret or the response body', async () => {
  const body = { ok: true, sent: true, replies: ['DIGEST-TEXT-MARKER'] };
  const f = fakeDeps(['network', { status: 502, body: { error: 'BODY-MARKER' } }, { status: 200, body }]);
  const { result, logs } = await captureLogs(() => requestDigest('https://bot.example', SECRET, '1', f.deps));
  assert.deepEqual(result, { status: 200, tries: 3, sent: true });
  assert.ok(logs.length > 0, 'retries are logged');
  assert.ok(!logs.includes(SECRET));
  assert.ok(!logs.includes('MARKER'));
  assert.ok(!logs.includes('bot.example'));
  assert.ok(!('replies' in result));
});
