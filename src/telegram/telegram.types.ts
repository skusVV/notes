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

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
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
