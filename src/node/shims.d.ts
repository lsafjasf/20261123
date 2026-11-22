// 最小 Node.js 类型声明：仅覆盖本项目用到的 API，避免引入 @types/node。
declare const process: {
  exit(code: number): never;
  argv: string[];
  env: Record<string, string | undefined>;
};

declare module "node:http" {
  export function createServer(
    listener: (req: unknown, res: unknown) => void,
  ): { listen(port: number, callback?: () => void): void };
}

declare module "node:fs/promises" {
  export function readFile(path: string): Promise<Uint8Array>;
}

declare module "node:fs" {
  export function writeFileSync(path: string, data: Uint8Array): void;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function extname(p: string): string;
  export function normalize(p: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string): string;
}
