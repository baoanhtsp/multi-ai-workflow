export interface PromptAgentInfo {
  name: string;
  persona?: string;
  team_role?: string;
  role_sections?: {
    responsibility?: string;
    delegation?: string;
    output?: string;
    permissions?: string;
    extra?: string;
  };
  hooks?: {
    before?: string;
    after?: string;
  };
  may_delegate?: boolean;
}

export interface PromptMemberInfo {
  key: string;
  name: string;
  platform: string;
  responsibility: string;
}

export interface PromptHistoryMessage {
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'handoff';
  text: string;
  handoff_id?: string;
}

export interface BuildPromptOptions {
  agent: PromptAgentInfo;
  newMessageText: string;
  summary?: string;
  session?: number;
  memoryContext?: string;
  recentMessages?: PromptHistoryMessage[];
  teamMembers?: PromptMemberInfo[];
  attachmentLines?: string[];
  maxChars?: number; // default 17000
}

export function buildPrompt(opts: BuildPromptOptions): string {
  const maxBudget = opts.maxChars ?? 17000;

  // 1. # Agent section
  const agentLines: string[] = ['# Agent'];
  agentLines.push(`Name: ${opts.agent.name}`);
  if (opts.agent.team_role) {
    agentLines.push(`Team role: ${opts.agent.team_role}`);
  }
  if (opts.agent.persona && opts.agent.persona.trim()) {
    agentLines.push(`Persona: ${opts.agent.persona.trim()}`);
  }
  if (opts.agent.role_sections) {
    const s = opts.agent.role_sections;
    if (s.responsibility) agentLines.push(`Responsibility: ${s.responsibility.trim()}`);
    if (s.delegation) agentLines.push(`Delegation & reporting: ${s.delegation.trim()}`);
    if (s.output) agentLines.push(`Output: ${s.output.trim()}`);
    if (s.permissions) agentLines.push(`Permissions: ${s.permissions.trim()}`);
    if (s.extra) agentLines.push(s.extra.trim());
  }
  const agentSection = agentLines.join('\n');

  // 5. # Message section (never trimmed)
  const messageParts: string[] = ['# Message'];
  if (opts.agent.hooks?.before && opts.agent.hooks.before.trim()) {
    messageParts.push(opts.agent.hooks.before.trim());
  }
  messageParts.push(opts.newMessageText.trim());
  if (opts.attachmentLines && opts.attachmentLines.length > 0) {
    messageParts.push(opts.attachmentLines.join('\n'));
  }
  if (opts.agent.hooks?.after && opts.agent.hooks.after.trim()) {
    messageParts.push(opts.agent.hooks.after.trim());
  }
  const messageSection = messageParts.join('\n\n');

  // 6. Dispatch tool instructions for Lead (team role with may_delegate)
  let dispatchSection = '';
  if (opts.agent.may_delegate) {
    const dLines: string[] = [
      '# Dispatch Tool',
      'To delegate tasks to members, end your reply with exactly one fenced handoff block:',
      '```handoff\n{ "handoffs": [ { "to": "<role_key>", "task": "<task description>", "acceptance": "<criteria>", "thread": "" } ] }\n```',
    ];
    if (opts.teamMembers && opts.teamMembers.length > 0) {
      dLines.push('Available team members:');
      for (const m of opts.teamMembers) {
        const resp = m.responsibility ? `: ${m.responsibility}` : '';
        dLines.push(`- ${m.key} (${m.name}, platform: ${m.platform})${resp}`);
      }
    }
    dLines.push(
      "Do not do members' work yourself. Results come back as [Handoff <id>] messages."
    );
    dispatchSection = dLines.join('\n');
  }

  // 2. # Project memory
  let memorySection = '';
  if (opts.memoryContext && opts.memoryContext.trim()) {
    let memText = opts.memoryContext.trim();
    if (memText.length > 2500) {
      memText = memText.slice(0, 2500);
    }
    memorySection = `# Project memory\n${memText}`;
  }

  // 3. # Conversation summary (session n)
  let summarySection = '';
  if (opts.summary && opts.summary.trim()) {
    const sessNum = opts.session ?? 1;
    summarySection = `# Conversation summary (session ${sessNum})\n${opts.summary.trim()}`;
  }

  // 4. # Recent messages
  // newest-first selection rendered oldest-first, each <= 2500 chars
  const renderedMessages: string[] = [];
  if (opts.recentMessages && opts.recentMessages.length > 0) {
    for (const msg of opts.recentMessages) {
      let t = msg.text.trim();
      if (t.length > 2500) {
        t = t.slice(0, 2500);
      }
      if (msg.role === 'user') {
        renderedMessages.push(`User:\n${t}`);
      } else if (msg.role === 'handoff') {
        const hid = msg.handoff_id ? ` ${msg.handoff_id}` : '';
        renderedMessages.push(`[Handoff${hid}]\n${t}`);
      } else if (msg.role === 'system') {
        renderedMessages.push(`[System]: ${t}`);
      } else {
        renderedMessages.push(`${opts.agent.name}:\n${t}`);
      }
    }
  }

  const assemble = (
    msgs: string[],
    mem: string,
    sum: string
  ): string => {
    const sections: string[] = [agentSection];
    if (mem) sections.push(mem);
    if (sum) sections.push(sum);
    if (msgs.length > 0) {
      sections.push('# Recent messages\n\n' + msgs.join('\n\n'));
    }
    sections.push(messageSection);
    if (dispatchSection) sections.push(dispatchSection);
    return sections.join('\n\n');
  };

  let currentMsgs = [...renderedMessages];
  let currentMem = memorySection;
  let currentSum = summarySection;

  let currentFull = assemble(currentMsgs, currentMem, currentSum);

  // Trimming order:
  // 1. Drop older messages from history
  while (currentFull.length > maxBudget && currentMsgs.length > 0) {
    currentMsgs.shift(); // drop oldest
    currentFull = assemble(currentMsgs, currentMem, currentSum);
  }

  // 2. Trim project memory
  if (currentFull.length > maxBudget && currentMem) {
    currentMem = '';
    currentFull = assemble(currentMsgs, currentMem, currentSum);
  }

  // 3. Trim conversation summary
  if (currentFull.length > maxBudget && currentSum) {
    const allowed = maxBudget - assemble(currentMsgs, currentMem, '').length;
    if (allowed > 100) {
      currentSum = currentSum.slice(0, allowed);
    } else {
      currentSum = '';
    }
    currentFull = assemble(currentMsgs, currentMem, currentSum);
  }

  return currentFull;
}
