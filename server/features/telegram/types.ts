export interface TelegramDigestConfig {
  enabled: boolean;
  morning: string; // "HH:MM" e.g. "08:30"
  evening: string; // "HH:MM" e.g. "18:00"
}

export interface TelegramConfigData {
  inbound: boolean;
  push_inbox: boolean;
  digest: TelegramDigestConfig;
}

export interface TelegramStateData {
  offset: number;
  push_since?: string;
  last_digest: {
    morning: string;
    evening: string;
  };
  msg_map: Record<string, string>; // message_id -> inbox_id or job_id (capped at 500)
}

export interface TelegramLockData {
  pid: number;
  port?: number;
  heartbeat: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number | string };
    text?: string;
    reply_to_message?: {
      message_id: number;
      text?: string;
    };
  };
  callback_query?: {
    id: string;
    from: { id: number | string };
    message?: {
      message_id: number;
      chat: { id: number | string };
    };
    data?: string;
  };
}
