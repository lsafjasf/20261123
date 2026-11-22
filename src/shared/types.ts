export type Aspect = "16:9" | "9:16";

export type BackgroundStyle = "box" | "glass" | "outline" | "none";

export type PlacementPreference = "auto" | "bottom" | "top";

export interface SubjectBox {
  /** Normalized coordinates in the output frame. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextMetricsLike {
  width: number;
}

export type MeasureText = (text: string, font: string) => TextMetricsLike;

export interface SubtitleSentence {
  id: number;
  text: string;
  startUs: number;
  endUs: number;
}

export interface SubtitleCue {
  id: string;
  startUs: number;
  endUs: number;
  text: string;
  sentences: SubtitleSentence[];
  speaker?: string;
}

export interface SubtitleDocument {
  cues: SubtitleCue[];
  title?: string;
  sourceType: "srt" | "vtt" | "json" | "plain";
  warnings: string[];
}

export interface VideoPreset {
  aspect: Aspect;
  width: number;
  height: number;
  safe: { x: number; y: number; width: number; height: number };
  fontSize: number;
  minFontSize: number;
  lineHeight: number;
  maxLines: number;
  marginX: number;
  marginY: number;
  bottomInset: number;
  horizontalPadding: number;
  verticalPadding: number;
  foregroundFit: "cover" | "contain";
}

export interface LayoutStyle {
  background: BackgroundStyle;
  accent: string;
  foreground: string;
  muted: string;
  backgroundRGBA: string;
  borderRGBA: string;
  fontFamily: string;
  fontWeight: number;
  fontScale?: number;
  radius: number;
  shadowBlur: number;
  showSpeaker: boolean;
}

export interface RenderRequest {
  preset: VideoPreset;
  style: LayoutStyle;
  subjectBox: SubjectBox | null;
  placement: PlacementPreference;
  timeUs: number;
  cue: SubtitleCue | null;
}

export interface StyledRun {
  text: string;
  sentenceId: number;
  active: boolean;
}

export interface LayoutLine {
  runs: StyledRun[];
  text: string;
  width: number;
  baseline: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SubtitleLayout {
  visible: boolean;
  cueId: string | null;
  activeSentenceId: number;
  fontSize: number;
  lineHeight: number;
  lines: LayoutLine[];
  textBox: Rect;
  backgroundBox: Rect;
  placement: "bottom" | "top" | "subject-left" | "subject-right";
  subjectOverlap: number;
  warnings: string[];
}

export interface FrameTiming {
  index: number;
  timestampUs: number;
  durationUs: number;
  cueId: string | null;
  activeSentenceId: number;
}

export interface LayoutCheck {
  aspect: Aspect;
  width: number;
  height: number;
  safe: Rect;
  subject: SubjectBox | null;
  textBox: Rect;
  backgroundBox: Rect;
  fontSize: number;
  lineCount: number;
  lineWidths: number[];
  lineCharacters: number[];
  placement: string;
  margins: { top: number; right: number; bottom: number; left: number };
  insideSafeArea: boolean;
  subjectOverlap: number;
  frameTime: number;
  frameIndex: number;
}
