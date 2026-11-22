import { stripTypeScriptTypes } from 'node:module';

export interface TranspileResult {
  code: string;
  contentType: string;
}

/**
 * Serve browser TypeScript modules using Node's built-in erasable-syntax
 * type stripper. No third-party compiler, no bundler. Source maps are
 * generated in-memory so browser DevTools point back at the .ts sources.
 */
export function transpileClientModule(
  source: string,
  sourceUrl: string,
): TranspileResult {
  const stripped = stripTypeScriptTypes(source, {
    mode: 'transform',
    sourceMap: true,
    sourceUrl,
  });
  return {
    code: stripped as unknown as string,
    contentType: 'text/javascript; charset=utf-8',
  };
}
