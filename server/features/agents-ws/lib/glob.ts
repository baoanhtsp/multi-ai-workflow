export function globToRegex(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, '/').replace(/^\/+/, '');
  let re = '';
  let i = 0;
  while (i < norm.length) {
    const c = norm[i];
    if (c === '*' && norm[i + 1] === '*') {
      if (norm[i + 2] === '/') {
        re += '(?:.*?/|^)';
        i += 3;
        continue;
      } else {
        re += '.*';
        i += 2;
        continue;
      }
    }
    if (c === '*') {
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|'].includes(c!)) {
      re += '\\' + c;
      i++;
      continue;
    }
    re += c;
    i++;
  }
  return new RegExp(`^${re}$`, 'i');
}

export function matchesAnyScope(fileRel: string, scopes: string[]): boolean {
  if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
    return false;
  }
  const normFile = fileRel.replace(/\\/g, '/').replace(/^\/+/, '');
  for (const scope of scopes) {
    const trimmed = String(scope ?? '').trim();
    if (!trimmed) continue;
    const re = globToRegex(trimmed);
    if (re.test(normFile)) {
      return true;
    }
  }
  return false;
}
