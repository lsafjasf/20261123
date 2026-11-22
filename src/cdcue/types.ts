export interface CueIndex {
  number: number;
  msf: string;
  frame: number;
}

export interface CueTrack {
  number: number;
  indexes: CueIndex[];
}

export interface CueSheet {
  filePath: string;
  fileType: string;
  tracks: CueTrack[];
  warnings: string[];
}

export interface WavInfo {
  path: string;
  formatCode: number;
  channels: number;
  sampleRate: number;
  bytesPerSecond: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  frameCount: number;
  frameBytes: number;
  rf64: boolean;
}

export interface Marker {
  kind: "hidden-start" | "index" | "source-end";
  trackNumber?: number;
  indexNumber?: number;
  msf?: string;
  sample: number;
  originalSample: number;
}

export interface PlannedRegion {
  id: string;
  kind: "hidden" | "track";
  trackNumber?: number;
  startSample: number;
  endSample: number;
  frameCount: number;
  markers: Marker[];
}

export interface SplitPlan {
  regions: PlannedRegion[];
  markers: Marker[];
  totalSamples: number;
  offsetSamples: number;
}

export interface OutputRecord {
  id: string;
  kind: "hidden" | "track";
  trackNumber: number | null;
  file: string;
  startSample: number;
  frameCount: number;
  byteLength: number;
  sha256: string;
  markers: Marker[];
}

export interface Manifest {
  manifestVersion: 1;
  createdAt: string;
  cueSheet: string;
  source: {
    file: string;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    frameBytes: number;
    totalSamples: number;
    dataSha256: string;
  };
  offset: {
    samples: number;
    msfFrames: number | null;
  };
  outputs: OutputRecord[];
  reconstructed: {
    dataBytes: number;
    sha256: string;
  };
  warnings: string[];
}
