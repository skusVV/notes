import { Message } from './alert-state';

const TEXT: Record<Exclude<Message, 'expiry'>, string> = {
  down: 'Garmin sync is down: Garmin rejected the API key (expired or deleted). Create a new key in Garmin Connect and update the secret.',
  renudge: 'Garmin sync is still down. Renew the API key when you can.',
  recovery: 'Garmin sync is back - data is flowing again.',
};

const MONTHS = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
/** The bot's "no raw ISO in chat" rule; the ingester cannot import the bot, so a tiny copy. */
export function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${d} ${MONTHS[m - 1]} ${y}` : iso;
}

export function render(m: Message, keyExpiresOn: string | null): string {
  if (m === 'expiry') {
    return `Your Garmin API key expires on ${humanDate(keyExpiresOn ?? '')}. Create a new one before then.`;
  }
  return TEXT[m];
}

/** Plain text, no parse_mode. Errors are described without the URL (it contains the bot token). */
export async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`telegram send failed: HTTP ${res.status}`);
    return res.ok;
  } catch {
    console.error('telegram send failed: network error');
    return false;
  }
}
