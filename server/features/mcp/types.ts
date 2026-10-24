export interface McpServerConfig {
  name: string; // ^[A-Za-z0-9_.-]{1,64}$
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface PlatformMcpStatus {
  platform: 'claude' | 'codex' | 'gemini';
  file: string;
  exists: boolean;
  writable: boolean;
  servers: McpServerConfig[];
  error?: string;
}

export interface McpBackupEntry {
  platform: string;
  filename: string;
  created_at: string;
  size: number;
}
