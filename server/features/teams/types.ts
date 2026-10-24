import type { RoleSections } from '../agents-ws/lib/markdown-roles.ts';

export interface TeamRoleOverride {
  workdir?: string;
  platform?: string;
  model?: string;
  effort?: string;
  write_scope?: string[];
}

export interface TeamRole {
  key: string;
  name: string;
  enabled: boolean;
  working_style: 'persistent' | 'per_task' | 'new_chat_per_task';
  persona: string;
  may_delegate: boolean;
  exec_role: string;
  override?: TeamRoleOverride;
  agent_id: string;
}

export interface TeamSharedSettings {
  workdir: string;
  platform: string;
  model: string;
  effort: string;
  write_scope: string[];
  writable_dirs: string[];
  isolate: boolean;
  max_parallel: number;
  auto_continue: boolean;
}

export interface Team {
  version: 1;
  id: string;
  name: string;
  template: string;
  shared: TeamSharedSettings;
  roles: TeamRole[];
}

export interface TeamTemplate {
  id: string;
  name: string;
  builtin?: boolean;
  team: Team;
  roles_md: Record<string, RoleSections>;
  updated_at?: string;
}

export interface RoleProfile {
  id: string;
  name: string;
  role: Partial<TeamRole>;
  sections: RoleSections;
  updated_at: string;
}
