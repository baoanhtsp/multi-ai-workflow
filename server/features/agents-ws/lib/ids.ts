import crypto from 'node:crypto';

export const AGENT_ID_REGEX = /^ag_[a-f0-9]{8}$/;
export const GROUP_ID_REGEX = /^gr_[a-f0-9]{8}$/;
export const CONVERSATION_ID_REGEX = /^cv_[a-f0-9]{10}$/;
export const MESSAGE_ID_REGEX = /^m_[a-f0-9]{8}$/;
export const QUEUE_ID_REGEX = /^q_[a-f0-9]{6}$/;
export const TEAM_ID_REGEX = /^tm_[a-f0-9]{8}$/;
export const TEMPLATE_ID_REGEX = /^(?:full|empty|tt_[a-f0-9]{8})$/;
export const USER_TEMPLATE_ID_REGEX = /^tt_[a-f0-9]{8}$/;
export const PROFILE_ID_REGEX = /^rp_[a-f0-9]{8}$/;
export const HANDOFF_ID_REGEX = /^h_[a-f0-9]{8}$/;
export const BATCH_ID_REGEX = /^b_[a-f0-9]{6}$/;
export const ROLE_KEY_REGEX = /^[a-z][a-z0-9-]{1,23}$/;
export const ADR_ID_REGEX = /^ADR-\d{4}$/;

export function generateAgentId(): string {
  return 'ag_' + crypto.randomBytes(4).toString('hex');
}

export function generateGroupId(): string {
  return 'gr_' + crypto.randomBytes(4).toString('hex');
}

export function generateConversationId(): string {
  return 'cv_' + crypto.randomBytes(5).toString('hex');
}

export function generateMessageId(): string {
  return 'm_' + crypto.randomBytes(4).toString('hex');
}

export function generateQueueId(): string {
  return 'q_' + crypto.randomBytes(3).toString('hex');
}

export function generateTeamId(): string {
  return 'tm_' + crypto.randomBytes(4).toString('hex');
}

export function generateTemplateId(): string {
  return 'tt_' + crypto.randomBytes(4).toString('hex');
}

export function generateProfileId(): string {
  return 'rp_' + crypto.randomBytes(4).toString('hex');
}

export function generateHandoffId(): string {
  return 'h_' + crypto.randomBytes(4).toString('hex');
}

export function generateBatchId(): string {
  return 'b_' + crypto.randomBytes(3).toString('hex');
}
