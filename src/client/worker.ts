import { analyzeMonoFeatures } from "../analysis/features.ts";
import { findRepeatedTakes } from "../analysis/matching.ts";
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  WorkerReply,
} from "../shared/types.ts";

interface WorkerScope {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  if (event.data.type !== "analyze") return;
  try {
    const { samples, sampleRate, durationSec, settings } = event.data;
    const features = analyzeMonoFeatures(
      samples,
      sampleRate,
      durationSec,
      {
        onProgress: (value) => {
          scope.postMessage({
            type: "progress",
            phase: "features",
            value: value * 0.76,
            detail: "提取音高与噪声置信度",
          });
        },
      },
    );
    const result = findRepeatedTakes(features, settings, (value) => {
      scope.postMessage({
        type: "progress",
        phase: "matching",
        value: 0.76 + value * 0.23,
        detail: "比对远距离旋律片段",
      });
    });
    const response: AnalyzeResponse = {
      type: "complete",
      features,
      result,
    };
    scope.postMessage(response);
  } catch (error) {
    scope.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
