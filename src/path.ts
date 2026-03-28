export function basename(path: string) {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? path;
}

export function normalizeIncludeTarget(value: string) {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

export function isGlobPattern(path: string) {
  return /[*?[]/.test(path);
}

export function validateGlobPattern(pattern: string) {
  if (pattern.includes('***')) {
    return { isValid: false, reason: 'Three or more consecutive asterisks are not supported.' };
  }

  let bracketDepth = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === '[') {
      bracketDepth += 1;
      continue;
    }

    if (char === ']') {
      if (bracketDepth === 0) {
        return { isValid: false, reason: 'Unmatched closing bracket in glob pattern.' };
      }

      bracketDepth -= 1;
    }
  }

  if (bracketDepth > 0) {
    return { isValid: false, reason: 'Unclosed character class in glob pattern.' };
  }

  return { isValid: true, reason: null };
}

export function matchGlob(pattern: string, filePath: string): boolean {
  const validation = validateGlobPattern(pattern);

  if (!validation.isValid) {
    return false;
  }

  const normalized = pattern.replace(/\*\*([^/*?[\]])/g, '**/*$1');
  const regexSource = globToRegex(normalized);
  return new RegExp(`^${regexSource}$`).test(filePath);
}

export function expandGlob(pattern: string, knownPaths: Iterable<string>): string[] {
  const validation = validateGlobPattern(pattern);

  if (!validation.isValid) {
    return [];
  }

  const normalized = pattern.replace(/\*\*([^/*?[\]])/g, '**/*$1');
  const regexSource = globToRegex(normalized);
  const expression = new RegExp(`^${regexSource}$`);
  const matches: string[] = [];

  for (const currentPath of knownPaths) {
    if (expression.test(currentPath)) {
      matches.push(currentPath);
    }
  }

  matches.sort((left, right) => left.localeCompare(right));
  return matches;
}

function globToRegex(pattern: string): string {
  let result = '';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '*' && pattern[index + 1] === '*') {
      index += 2;

      if (pattern[index] === '/') {
        index += 1;
      }

      result += '(?:.*/)?';
      continue;
    }

    if (char === '*') {
      result += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      result += '[^/]';
      index += 1;
      continue;
    }

    if (char === '[') {
      const closeIndex = pattern.indexOf(']', index + 1);
      result += pattern.slice(index, closeIndex + 1);
      index = closeIndex + 1;
      continue;
    }

    if ('.+^${}()|\\'.includes(char ?? '')) {
      result += `\\${char}`;
      index += 1;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

export function resolveRelativePath(basePath: string, target: string) {
  const baseSegments = basePath.split('/').slice(0, -1);
  const targetSegments = target.split('/').filter(Boolean);
  const resolved = [...baseSegments];

  for (const segment of targetSegments) {
    if (segment === '.') {
      continue;
    }

    if (segment === '..') {
      resolved.pop();
      continue;
    }

    resolved.push(segment);
  }

  return resolved.join('/');
}
