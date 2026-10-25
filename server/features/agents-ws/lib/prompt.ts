import { ApiValidationError } from '../../../lib/validate.ts';

export type ReplyLanguage = 'vi' | 'en';

export const ALLOWED_REPLY_LANGUAGES: readonly ReplyLanguage[] = ['vi', 'en'];

export const LANGUAGE_SECTION_VI =
  '# Language\nAlways reply in Vietnamese (tiếng Việt), whatever language the message or the history uses. Keep code, commands, file paths and identifiers as they are.';

export const LANGUAGE_SECTION_EN =
  '# Language\nAlways reply in English. Keep code, commands, file paths and identifiers as they are.';

export function validateReplyLanguage(
  raw: unknown,
  options?: { allowEmpty?: boolean; fieldName?: string }
): '' | ReplyLanguage {
  const fieldName = options?.fieldName ?? 'reply_language';
  if (raw === undefined || raw === null) {
    if (options?.allowEmpty !== false) {
      return '';
    }
    throw new ApiValidationError(`Invalid ${fieldName}: must be "vi" or "en".`, 400);
  }
  if (typeof raw !== 'string') {
    throw new ApiValidationError(`Invalid ${fieldName}: must be "vi" or "en".`, 400);
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') {
    if (options?.allowEmpty !== false) {
      return '';
    }
    throw new ApiValidationError(`Invalid ${fieldName}: must be "vi" or "en".`, 400);
  }
  if (trimmed !== 'vi' && trimmed !== 'en') {
    throw new ApiValidationError(`Invalid ${fieldName} '${raw}'. Allowed: vi, en.`, 400);
  }
  return trimmed;
}

export function resolveEffectiveReplyLanguage(
  agentReplyLanguage?: string,
  requestReplyLanguage?: string
): ReplyLanguage {
  const ag = String(agentReplyLanguage ?? '').trim().toLowerCase();
  if (ag === 'vi' || ag === 'en') return ag;
  const req = String(requestReplyLanguage ?? '').trim().toLowerCase();
  if (req === 'vi' || req === 'en') return req;
  return 'vi';
}

export function getLanguageSection(lang?: string): string {
  const normalized = String(lang ?? '').trim().toLowerCase();
  return normalized === 'en' ? LANGUAGE_SECTION_EN : LANGUAGE_SECTION_VI;
}

export interface PromptAgentInfo {
  name: string;
  persona?: string;
  team_role?: string;
  reply_language?: string;
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
  replyLanguage?: string;
  maxChars?: number; // default 17000
}

export interface GetMaxMessageCharsOptions {
  attachmentLines?: string[];
  replyLanguage?: string;
  maxBudget?: number;
}

export function getMaxMessageCharsForAgent(
  agent: PromptAgentInfo,
  options?: GetMaxMessageCharsOptions | number
): number {
  const maxBudget = typeof options === 'number' ? options : (options?.maxBudget ?? 17000);
  const attachmentLines = typeof options === 'object' ? options.attachmentLines : undefined;
  const requestReplyLang = typeof options === 'object' ? options.replyLanguage : undefined;

  // 1. Agent section after maximal trimming
  const minimalAgentHeader =
    '# Agent\nName: ' + agent.name + (agent.team_role ? '\nTeam role: ' + agent.team_role : '');

  // 2. Fixed message section wrapper (hooks, attachments, headers)
  const messageParts: string[] = ['# Message'];
  if (agent.hooks?.before && agent.hooks.before.trim()) {
    messageParts.push(agent.hooks.before.trim());
  }
  if (attachmentLines && attachmentLines.length > 0) {
    messageParts.push(attachmentLines.join('\n'));
  }
  if (agent.hooks?.after && agent.hooks.after.trim()) {
    messageParts.push(agent.hooks.after.trim());
  }
  const messageFixedWrapper = messageParts.join('\n\n');

  const fixedSections: string[] = [minimalAgentHeader, messageFixedWrapper];

  // 3. Dispatch tool instructions for Lead (if may_delegate)
  if (agent.may_delegate) {
    const minimalDispatch =
      '# Dispatch Tool\nTo delegate tasks to members, end your reply with exactly one fenced handoff block:\n```handoff\n{ "handoffs": [ { "to": "<role_key>", "task": "<task description>", "acceptance": "<criteria>", "thread": "" } ] }\n```\nDo not do members\' work yourself. Results come back as [Handoff <id>] messages.';
    fixedSections.push(minimalDispatch);
  }

  // 4. Language section (never trimmed, always last)
  const effectiveLang = resolveEffectiveReplyLanguage(agent.reply_language, requestReplyLang);
  fixedSections.push(getLanguageSection(effectiveLang));

  // When message text is present, it is added to messageParts with '\n\n' separator (+2 chars)
  const fixedTotal = fixedSections.join('\n\n').length + 2;
  return Math.max(0, maxBudget - fixedTotal);
}

export function buildPrompt(opts: BuildPromptOptions): string {
  const maxBudget = opts.maxChars ?? 17000;

  // 1. # Agent section
  let persona = opts.agent.persona ? opts.agent.persona.trim() : '';
  let roleSec = opts.agent.role_sections ? { ...opts.agent.role_sections } : undefined;

  const renderAgentSection = (p: string, rs?: typeof roleSec): string => {
    const aLines: string[] = ['# Agent', `Name: ${opts.agent.name}`];
    if (opts.agent.team_role) {
      aLines.push(`Team role: ${opts.agent.team_role}`);
    }
    if (p) {
      aLines.push(`Persona: ${p}`);
    }
    if (rs) {
      if (rs.responsibility) aLines.push(`Responsibility: ${rs.responsibility.trim()}`);
      if (rs.delegation) aLines.push(`Delegation & reporting: ${rs.delegation.trim()}`);
      if (rs.output) aLines.push(`Output: ${rs.output.trim()}`);
      if (rs.permissions) aLines.push(`Permissions: ${rs.permissions.trim()}`);
      if (rs.extra) aLines.push(rs.extra.trim());
    }
    return aLines.join('\n');
  };

  let agentSection = renderAgentSection(persona, roleSec);

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

  // 7. # Language section (never trimmed, always last)
  const effectiveLang = resolveEffectiveReplyLanguage(opts.agent.reply_language, opts.replyLanguage);
  const languageSection = getLanguageSection(effectiveLang);

  const assemble = (
    msgs: string[],
    mem: string,
    sum: string,
    agSec: string,
    dispSec: string
  ): string => {
    const sections: string[] = [agSec];
    if (mem) sections.push(mem);
    if (sum) sections.push(sum);
    if (msgs.length > 0) {
      sections.push('# Recent messages\n\n' + msgs.join('\n\n'));
    }
    sections.push(messageSection);
    if (dispSec) sections.push(dispSec);
    sections.push(languageSection);
    return sections.join('\n\n');
  };

  let currentMsgs = [...renderedMessages];
  let currentMem = memorySection;
  let currentSum = summarySection;
  let currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);

  // Trimming order:
  // 1. Drop older messages from history
  while (currentFull.length > maxBudget && currentMsgs.length > 0) {
    currentMsgs.shift(); // drop oldest
    currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
  }

  // 2. Trim project memory
  if (currentFull.length > maxBudget && currentMem) {
    currentMem = '';
    currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
  }

  // 3. Trim conversation summary
  if (currentFull.length > maxBudget && currentSum) {
    const allowed = maxBudget - assemble(currentMsgs, currentMem, '', agentSection, dispatchSection).length;
    if (allowed > 100) {
      currentSum = currentSum.slice(0, allowed);
    } else {
      currentSum = '';
    }
    currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
  }

  // 4. Trim team member list in dispatch tool instructions
  if (currentFull.length > maxBudget && dispatchSection) {
    dispatchSection =
      '# Dispatch Tool\nTo delegate tasks to members, end your reply with exactly one fenced handoff block:\n```handoff\n{ "handoffs": [ { "to": "<role_key>", "task": "<task description>", "acceptance": "<criteria>", "thread": "" } ] }\n```\nDo not do members\' work yourself. Results come back as [Handoff <id>] messages.';
    currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
  }

  // 5. Trim agent section (extra, permissions, output, delegation, responsibility, persona)
  if (currentFull.length > maxBudget) {
    if (roleSec?.extra) {
      delete roleSec.extra;
      agentSection = renderAgentSection(persona, roleSec);
      currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
    }
    if (currentFull.length > maxBudget && roleSec?.permissions) {
      delete roleSec.permissions;
      agentSection = renderAgentSection(persona, roleSec);
      currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
    }
    if (currentFull.length > maxBudget && roleSec?.output) {
      delete roleSec.output;
      agentSection = renderAgentSection(persona, roleSec);
      currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
    }
    if (currentFull.length > maxBudget && roleSec?.delegation) {
      delete roleSec.delegation;
      agentSection = renderAgentSection(persona, roleSec);
      currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
    }
    if (currentFull.length > maxBudget && roleSec?.responsibility) {
      delete roleSec.responsibility;
      agentSection = renderAgentSection(persona, roleSec);
      currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
    }
    if (currentFull.length > maxBudget && persona) {
      persona = '';
      agentSection = renderAgentSection(persona, roleSec);
      currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
    }
    if (currentFull.length > maxBudget && dispatchSection) {
      dispatchSection = '';
      currentFull = assemble(currentMsgs, currentMem, currentSum, agentSection, dispatchSection);
    }
  }

  return currentFull;
}
