export type ErrorCode =
  | "CUE_SYNTAX"
  | "CUE_UNSUPPORTED"
  | "CUE_INDEX_INVALID"
  | "WAV_PARSE"
  | "WAV_TRUNCATED"
  | "LENGTH_INSUFFICIENT"
  | "OFFSET_INVALID"
  | "IO_ERROR";

export class CdcueError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "CdcueError";
    this.code = code;
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new CdcueError(code, message);
}
