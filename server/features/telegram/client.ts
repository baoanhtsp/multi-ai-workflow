import type { TelegramUpdate } from './types.ts';

export function redactTelegramSecrets(raw: string, token?: string): string {
  let s = String(raw ?? '');
  if (token && token.trim() !== '') {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(escaped, 'g'), '[redacted-token]');
  }
  // Redact bot<token>
  s = s.replace(/bot\d+:[a-zA-Z0-9_-]{20,}/gi, 'bot[redacted-token]');
  s = s.replace(/\b\d{8,11}:[a-zA-Z0-9_-]{25,}\b/g, '[redacted-token]');
  return s;
}

export interface TelegramClientOptions {
  token: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class TelegramClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: TelegramClientOptions) {
    this.token = options.token.trim();
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  private getEndpoint(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  async getUpdates(
    offset: number,
    timeoutSec = 25,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; result?: TelegramUpdate[]; error?: string; status?: number }> {
    const url = `${this.getEndpoint('getUpdates')}?timeout=${timeoutSec}&offset=${offset}&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`;
    try {
      const resp = await this.fetchFn(url, {
        method: 'GET',
        signal,
      });

      if (!resp.ok) {
        return {
          ok: false,
          status: resp.status,
          error: redactTelegramSecrets(`HTTP ${resp.status} ${resp.statusText}`, this.token),
        };
      }

      const data = (await resp.json()) as { ok?: boolean; result?: TelegramUpdate[]; description?: string };
      if (!data || !data.ok) {
        return {
          ok: false,
          error: redactTelegramSecrets(data?.description ?? 'getUpdates failed', this.token),
        };
      }

      return {
        ok: true,
        result: data.result ?? [],
      };
    } catch (err) {
      return {
        ok: false,
        error: redactTelegramSecrets((err as Error)?.message ?? 'Network error', this.token),
      };
    }
  }

  async sendMessage(
    chatId: string | number,
    text: string,
    replyMarkup?: Record<string, unknown>
  ): Promise<{ ok: boolean; messageId?: number; error?: string }> {
    const url = this.getEndpoint('sendMessage');
    const bodyPayload: Record<string, unknown> = {
      chat_id: chatId,
      text: redactTelegramSecrets(text, this.token),
      disable_web_page_preview: true,
    };
    if (replyMarkup) {
      bodyPayload.reply_markup = replyMarkup;
    }

    try {
      const resp = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
        signal: AbortSignal.timeout(15000),
      });

      const data = (await resp.json()) as {
        ok?: boolean;
        result?: { message_id?: number };
        description?: string;
      };

      if (!resp.ok || !data?.ok) {
        return {
          ok: false,
          error: redactTelegramSecrets(data?.description ?? `HTTP ${resp.status}`, this.token),
        };
      }

      return {
        ok: true,
        messageId: data.result?.message_id,
      };
    } catch (err) {
      return {
        ok: false,
        error: redactTelegramSecrets((err as Error)?.message ?? 'Send message failed', this.token),
      };
    }
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string
  ): Promise<{ ok: boolean; error?: string }> {
    const url = this.getEndpoint('answerCallbackQuery');
    const bodyPayload: Record<string, unknown> = {
      callback_query_id: callbackQueryId,
    };
    if (text) {
      bodyPayload.text = text.slice(0, 200);
    }

    try {
      const resp = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
        signal: AbortSignal.timeout(10000),
      });

      const data = (await resp.json()) as { ok?: boolean; description?: string };
      if (!resp.ok || !data?.ok) {
        return {
          ok: false,
          error: redactTelegramSecrets(data?.description ?? `HTTP ${resp.status}`, this.token),
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: redactTelegramSecrets((err as Error)?.message ?? 'answerCallbackQuery failed', this.token),
      };
    }
  }
}
