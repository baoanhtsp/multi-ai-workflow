export const AUTH_PATTERNS: Record<string, RegExp[]> = {
  claude: [
    /OAuth (session|token) (has )?expired/i,
    /Please run \/login/i,
    /Invalid API key/i,
    /authentication_error/i,
    /\b401\b.*(unauthori[sz]ed|auth)/i,
  ],
  codex: [
    /Not logged in/i,
    /Please (run )?`?codex login`?/i,
    /401 Unauthorized/i,
    /token (has )?expired/i,
    /refresh token/i,
  ],
  gemini: [
    /Please set an Auth method/i,
    /GEMINI_API_KEY.*(not set|missing)/i,
    /Login required/i,
    /\b401\b.*(unauthori[sz]ed|auth|credential)/i,
  ],
  antigravity: [
    /unauthenticated/i,
    /sign in to Antigravity/i,
  ],
  '*': [
    /\b401\b.*(unauthori[sz]ed|auth|credential)/i,
    /authentication (failed|required)/i,
    /not (logged|signed) in/i,
  ],
};

export const RATE_PATTERNS: RegExp[] = [
  /\b429\b/,
  /\b529\b/,
  /overloaded/i,
  /rate.?limit/i,
  /usage limit/i,
  /quota (exceeded|exhausted|reached)|exceeded your current quota/i,
];

export function classifyLog(agent: string, text: string): 'needs_login' | 'rate_limited' | null {
  if (!text) {
    return null;
  }
  const normAgent = String(agent ?? '').trim().toLowerCase();
  const patterns = AUTH_PATTERNS[normAgent] ?? AUTH_PATTERNS['*'] ?? [];
  const fallback = AUTH_PATTERNS['*'] ?? [];

  for (const pat of patterns) {
    if (pat.test(text)) {
      return 'needs_login';
    }
  }
  if (patterns !== fallback) {
    for (const pat of fallback) {
      if (pat.test(text)) {
        return 'needs_login';
      }
    }
  }

  for (const pat of RATE_PATTERNS) {
    if (pat.test(text)) {
      return 'rate_limited';
    }
  }

  return null;
}
