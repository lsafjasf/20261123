import { analyzeMonoFeatures } from "../analysis/features.js";
import { findRepeatedTakes } from "../analysis/matching.js";
             
                 
                  
              
                            

                       
                                                                    
                                                                     
 

const scope = self                          ;

scope.onmessage = (event                              ) => {
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
    const response                  = {
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
