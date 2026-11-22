import type { ErrorCode } from "./types.js";

export class ControlledPlaybackError extends Error {
  readonly code: ErrorCode;
  readonly title: string;
  readonly guidance: string;
  readonly segmentId: string | null;
  readonly technical: string;
  readonly recoverable: boolean;

  constructor(options: {
    code: ErrorCode;
    title: string;
    guidance: string;
    segmentId?: string | null;
    technical?: string;
    recoverable?: boolean;
    cause?: unknown;
  }) {
    super(options.title, { cause: options.cause });
    this.name = "ControlledPlaybackError";
    this.code = options.code;
    this.title = options.title;
    this.guidance = options.guidance;
    this.segmentId = options.segmentId ?? null;
    this.technical = options.technical ?? "";
    this.recoverable = options.recoverable ?? false;
  }
}

export function asPlaybackError(error: unknown, segmentId?: string): ControlledPlaybackError {
  if (error instanceof ControlledPlaybackError) {
    return error;
  }
  const technical = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new ControlledPlaybackError({
    code: "UNEXPECTED",
    title: "播放链路意外中断",
    guidance: "播放器已停止并保留错误现场。可返回目录或重新联机建立会话。",
    segmentId,
    technical,
    cause: error,
  });
}
