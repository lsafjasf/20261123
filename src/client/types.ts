export interface MediaTechnical {
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  sampleRate: number | null;
}

export interface AudioFingerprint {
  v: 1;
  sr: number;
  bands: number;
  frames: number;
  data: string;
}

export interface TimelineRef {
  id: string;
  kind: string;
  offset: string | null;
  start: string | null;
  duration: string | null;
}

export interface MediaRef extends MediaTechnical {
  key: string;
  assetId: string;
  name: string;
  filename: string;
  sourcePath: string;
  timelineRefs: TimelineRef[];
  sha256?: string;
  visualHash?: string;
  audioFingerprint?: AudioFingerprint;
}

export interface ParsedProject {
  name: string;
  path: string;
  format: "fcpxml" | "xmeml" | "manifest" | "generic";
  refs: MediaRef[];
  warnings: string[];
  sha256?: string;
}

export interface ScanFile extends MediaTechnical {
  path: string;
  relPath: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
}

export interface Candidate extends ScanFile {
  sha256?: string;
  visualHash?: string;
  audioFingerprint?: AudioFingerprint;
  thumbnail?: string;
  analysisError?: string;
}

export interface SignalScore {
  available: boolean;
  score: number | null;
  weight: number;
  detail: string;
}

export interface CandidateEvidence {
  filename: SignalScore;
  duration: SignalScore;
  params: SignalScore;
  hash: SignalScore;
  audio: SignalScore;
  visual: SignalScore;
  coverage: number;
}

export interface RankedCandidate {
  candidate: Candidate;
  score: number;
  evidence: CandidateEvidence;
  flags: string[];
}

export type MatchDecision = "auto" | "review" | "missing";

export interface MatchProposal {
  ref: MediaRef;
  decision: MatchDecision;
  ranked: RankedCandidate[];
  selectedPath: string | null;
  reason: string;
  confidence: number;
}

export interface MatchState extends MatchProposal {
  confirmed: boolean;
  overridden: boolean;
  rejectedPaths: Set<string>;
}

export interface ScanResponse {
  root: string;
  files: ScanFile[];
  skipped: number;
  elapsedMs: number;
}

export interface HashResponse {
  path: string;
  sha256: string;
  size: number;
}
