export interface MemoryEntry {
  id: string; // ADR-xxxx
  title: string;
  body: string;
  date: string;
  source?: string;
  agent?: string;
  pinned?: boolean;
  tags?: string[];
}

export interface MemoryContextResult {
  text: string;
  ids: string[];
}
