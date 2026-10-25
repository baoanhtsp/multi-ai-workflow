export interface AgentRetryPolicy {
  max_attempts: number;
  backoff_sec: number;
}

export interface AgentHooks {
  before: string;
  after: string;
}

export interface Agent {
  id: string;
  name: string;
  group_id: string;
  order: number;
  platform: string;
  model: string;
  effort: string;
  workdir: string;
  role: string;
  persona: string;
  reply_language?: string;
  team_id: string;
  team_role: string;
  cli_args: string[];
  env: Record<string, string>;
  hooks: AgentHooks;
  retry_policy: AgentRetryPolicy;
  bookmark: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Group {
  id: string;
  name: string;
  order: number;
  collapsed: boolean;
  team_id: string;
}

export interface AgentGitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  modified: number;
}

export interface LiveAgent extends Agent {
  status: 'thinking' | 'waiting' | 'error' | 'needs-login' | 'idle';
  active_job_id: string;
  active_conversation_id: string;
  queue_len: number;
  last_activity: string;
  last_actual_model: string;
  git: AgentGitStatus;
}

export interface PlatformCapability {
  write: boolean;
  review: boolean;
  new_session: boolean;
  sessions: boolean;
  ide_send: boolean;
}

export interface PlatformInfo {
  id: string;
  label: string;
  color: string;
  installed: boolean;
  version: string | null;
  models: string[];
  efforts: string[];
  capabilities: PlatformCapability;
}
