import type { StructuredHandoffResult } from '../agents-ws/lib/handoff-block.ts';

export type HandoffStatus =
  | 'started'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'needs_review'
  | 'cancelled';

export interface Handoff {
  id: string;
  team_id: string;
  lead_agent_id: string;
  lead_conversation_id: string;
  lead_seq: number;
  batch: string;
  from: string;
  to: string;
  to_role: string;
  task: string;
  acceptance: string;
  status: HandoffStatus;
  job_id: string;
  member_conversation_id: string;
  isolated: boolean;
  worktree: string;
  branch: string;
  platform: string;
  actual_model: string;
  created_at: string;
  started_at: string;
  finished_at: string;
  duration_sec: number | null;
  result: StructuredHandoffResult | null;
  parse_error: string;
  scope_violations: string[];
  attempts: number;
  base_commit?: string;
  dirty_baseline?: Record<string, string>;
  baseline_error?: boolean;
  lead_notified_at?: string;
}
