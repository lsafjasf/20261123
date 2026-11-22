// Serves browser TypeScript modules by stripping types on the fly.
// Uses only node:module (Node >= 22.13). Sources must stay within
// "erasable syntax" (no enums / namespaces / parameter properties).

import { stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, normalize } from 'node:path';

const cache = new Map<string, string>();

export function stripFile(rootDir: string, urlPath: string): string | null {
  const filePath = normalize(resolve(rootDir, '.' + urlPath));
  if (!filePath.startsWith(rootDir)) return null;
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  cache.set(filePath, stripped);
  return stripped;
}
