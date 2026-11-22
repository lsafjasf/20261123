import { stripTypeScriptTypes } from 'node:module';

// Rewrites explicit ".ts" specifiers to ".js" URLs so the browser can load
// type-stripped modules without a bundler. Only relative specifiers are touched.
const rewriteSpecifiers = (source: string): string =>
  source.replace(
    /(from\s+|import\s+|export\s+\*\s+from\s+)(['"])(\.\.?\/[^'"]+)\.ts(\2)/g,
    (_full, prefix: string, quote: string, specifier: string) => {
      const sharedMatch = specifier.match(/(^|\/)shared\/(.+)$/);
      if (sharedMatch) {
        return `${prefix}${quote}/shared/${sharedMatch[2]}.js?ts=1${quote}`;
      }
      const local = specifier.startsWith('.')
        ? specifier
        : `./${specifier}`;
      return `${prefix}${quote}${local}.js?ts=1${quote}`;
    },
  );

export const transformBrowserTs = (source: string): string => {
  const stripped = stripTypeScriptTypes(source, {
    mode: 'transform',
    // Only syntax that type stripping can safely remove; no enums/namespaces.
  }) as string;
  return rewriteSpecifiers(stripped);
};
