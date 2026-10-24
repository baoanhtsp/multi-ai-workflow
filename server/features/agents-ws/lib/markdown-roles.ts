export interface RoleSections {
  responsibility: string;
  delegation: string;
  output: string;
  permissions: string;
  extra?: string;
}

const SECTION_MAP: Record<string, keyof RoleSections> = {
  responsibility: 'responsibility',
  'trách nhiệm': 'responsibility',
  'trach nhiem': 'responsibility',
  'delegation & reporting': 'delegation',
  'delegation and reporting': 'delegation',
  delegation: 'delegation',
  'giao việc & báo cáo': 'delegation',
  'giao việc và báo cáo': 'delegation',
  'giao viec & bao cao': 'delegation',
  output: 'output',
  'đầu ra': 'output',
  'dau ra': 'output',
  permissions: 'permissions',
  quyền: 'permissions',
  quyen: 'permissions',
};

export function parseRoleMarkdown(md: string): { name: string; sections: RoleSections } {
  const raw = String(md ?? '').replace(/^\uFEFF/, '').trim();
  const lines = raw.split(/\r?\n/);

  let name = '';
  let currentKey: keyof RoleSections | 'extra' | null = null;
  const collected: Record<string, string[]> = {
    responsibility: [],
    delegation: [],
    output: [],
    permissions: [],
    extra: [],
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Check # <Role Name>
    if (/^#\s+([^#].*)$/.test(trimmed)) {
      if (!name) {
        name = trimmed.replace(/^#\s+/, '').trim();
      }
      continue;
    }

    // Check ## <Section Heading>
    const h2Match = /^##\s+(.*)$/.exec(trimmed);
    if (h2Match) {
      const headingText = h2Match[1]!.trim().toLowerCase();
      const mappedKey = SECTION_MAP[headingText];
      if (mappedKey) {
        currentKey = mappedKey;
      } else {
        currentKey = 'extra';
        collected.extra!.push(line);
      }
      continue;
    }

    if (currentKey) {
      collected[currentKey]!.push(line);
    } else if (trimmed) {
      // Any text before first section goes into extra
      collected.extra!.push(line);
    }
  }

  const clean = (arr: string[]): string => {
    let text = arr.join('\n').trim();
    if (text.length > 6000) {
      text = text.slice(0, 6000);
    }
    return text;
  };

  const sections: RoleSections = {
    responsibility: clean(collected.responsibility!),
    delegation: clean(collected.delegation!),
    output: clean(collected.output!),
    permissions: clean(collected.permissions!),
  };

  const extraText = clean(collected.extra!);
  if (extraText) {
    sections.extra = extraText;
  }

  return { name: name || 'Role', sections };
}

export function renderRoleMarkdown(roleName: string, sections: RoleSections): string {
  const parts: string[] = [`# ${roleName.trim() || 'Role'}`];

  parts.push('## Responsibility\n' + (sections.responsibility?.trim() || ''));
  parts.push('## Delegation & reporting\n' + (sections.delegation?.trim() || ''));
  parts.push('## Output\n' + (sections.output?.trim() || ''));
  parts.push('## Permissions\n' + (sections.permissions?.trim() || ''));

  if (sections.extra && sections.extra.trim()) {
    parts.push(sections.extra.trim());
  }

  return parts.join('\n\n') + '\n';
}
