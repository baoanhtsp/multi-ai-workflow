export interface QueueItem {
  id: string;
  text: string;
  platform?: string;
  account?: string;
  model?: string;
  effort?: string;
  reply_language?: string;
  handoff_letter?: string;
  ts: string;
  attachments?: Array<{ name: string; path?: string; data_url?: string }>;
  system_generated?: boolean;
  is_retry?: boolean;
}

export interface LimitHandoffRecord {
  at: string;
  from: { agent: string; account: string };
  to: { agent: string; account: string };
  reason: string;
  quota?: Record<string, number | null>;
  message_seq?: number;
}

export interface PendingLimitHandoff {
  from: { agent: string; account: string };
  to: { agent: string; account: string };
  reason: string;
  quota?: Record<string, number | null>;
  resets_at?: string | null;
  failed_turn_text?: string;
  reply_language?: string;
  message_seq: number;
}

export interface ConversationResume {
  platform: string;
  token: string;
  session: number;
}

export interface ConversationContext {
  used_tokens: number;
  window_tokens: number;
  pct: number;
}

export interface Conversation {
  id: string;
  agent_id: string;
  title: string;
  kind: 'chat' | 'handoff';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  seq: number;
  session: number;
  platform: string;
  account?: string;
  model: string;
  effort: string;
  resume: ConversationResume | null;
  summary: string;
  summary_seq: number;
  active_job_id: string;
  active_kind: 'turn' | 'compact' | '';
  active_started_at: string;
  queue: QueueItem[];
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  context: ConversationContext;
  last_status: string;
  last_error: string;
  reply_language?: string;
  compact_error?: string;
  compact_failed_at?: string;
  retry_attempts?: number;
  limit_handoffs?: LimitHandoffRecord[];
  pending_limit_handoff?: PendingLimitHandoff | null;
  pending_next_handoff_letter?: string;
}

export interface MessageAttachment {
  name: string;
  path: string;
}

export interface MessageLimitHandoffInfo {
  from: { agent: string; account: string };
  to: { agent: string; account: string };
  reason: string;
  quota?: Record<string, number | null>;
  resets_at?: string | null;
  state: 'done' | 'pending' | 'declined';
}

export interface Message {
  seq: number;
  id: string;
  role: 'user' | 'assistant' | 'system' | 'handoff';
  kind?: 'limit_handoff' | string;
  state?: 'done' | 'pending' | 'declined';
  handoff?: MessageLimitHandoffInfo;
  text: string;
  ts: string;
  platform: string;
  account?: string;
  model: string;
  effort: string;
  actual_model: string;
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  duration_sec: number | null;
  attachments: MessageAttachment[];
  handoff_id: string;
  steered: boolean;
  system_generated?: boolean;
}
