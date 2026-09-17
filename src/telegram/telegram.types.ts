export interface TelegramChat {
  id: number;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

/** A voice note. Telegram always records these as Opus in an OGG container. */
export interface TelegramVoice {
  file_id: string;
  file_unique_id?: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  voice?: TelegramVoice;
}

/** One tappable button. `callback_data` is capped by Telegram at 64 bytes. */
export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** The `reply_markup` payload that turns a message into a message with buttons. */
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * A button tap. It arrives as a normal update on the webhook, so it is already behind the
 * webhook-secret check. `message` is the message the keyboard was attached to, which is how the
 * keyboard can be removed after the tap.
 */
export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** The getFile result. `file_path` is relative to https://api.telegram.org/file/bot<TOKEN>/. */
export interface TelegramFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
}
