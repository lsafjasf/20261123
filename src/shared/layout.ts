import { activeSentenceAt, activeCueAt, isPunctuationOnly } from "./cues.js";
import type {
  LayoutLine,
  LayoutStyle,
  MeasureText,
  Rect,
  RenderRequest,
  StyledRun,
  SubjectBox,
  SubtitleCue,
  SubtitleLayout,
  VideoPreset
} from "./types.js";

interface Unit {
  text: string;
  sentenceId: number;
  space: boolean;
  width: number;
}

function overlaps(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function rectInside(inner: Rect, outer: Rect): boolean {
  const epsilon = 0.5;
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon
  );
}

function subjectRect(subject: SubjectBox | null, preset: VideoPreset): Rect | null {
  if (!subject) return null;
  return {
    x: subject.x * preset.width,
    y: subject.y * preset.height,
    width: subject.width * preset.width,
    height: subject.height * preset.height
  };
}

function fontFor(size: number, style: LayoutStyle): string {
  return `${style.fontWeight} ${size}px ${style.fontFamily}`;
}

function isCjk(character: string): boolean {
  return /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(character);
}

function tokenizeSentence(text: string, sentenceId: number, measure: MeasureText, font: string): Unit[] {
  const units: Unit[] = [];
  const tokenPattern = /([A-Za-z0-9@#$%&*+=<>/\\|_~^°'’"“”\-.:?]+)|(\s+)|([\u2e80-\u9fff\uf900-\ufaff])|([^\s])/gu;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    const raw = match[0];
    const isSpace = /^\s+$/u.test(raw);
    if (!isSpace && isPunctuationOnly(raw) && units.length > 0) {
      const previous = units[units.length - 1];
      previous.text += raw;
      previous.width = measure(previous.text, font).width;
      continue;
    }
    let target = raw;
    if (isCjk(target) && units.length > 0) {
      const nextIndex = tokenPattern.lastIndex;
      const nextCharacter = text.slice(nextIndex, nextIndex + 1);
      if (nextCharacter && isPunctuationOnly(nextCharacter)) {
        target += nextCharacter;
        tokenPattern.lastIndex += 1;
      }
    }
    units.push({
      text: isSpace ? " " : target,
      sentenceId,
      space: isSpace,
      width: measure(isSpace ? " " : target, font).width
    });
  }
  return units;
}

function joinLines(units: Unit[]): StyledRun[] {
  const runs: StyledRun[] = [];
  for (const unit of units) {
    const last = runs[runs.length - 1];
    if (last && last.sentenceId === unit.sentenceId) {
      last.text += unit.text;
    } else {
      runs.push({ text: unit.text, sentenceId: unit.sentenceId, active: false });
    }
  }
  return runs;
}

function wrapUnits(units: Unit[], maxWidth: number): Unit[][] {
  const lines: Unit[][] = [];
  let line: Unit[] = [];
  let width = 0;

  const flush = () => {
    while (line.length > 0 && line[line.length - 1].space) line.pop();
    if (line.length > 0) lines.push(line);
    line = [];
    width = 0;
  };

  for (const unit of units) {
    if (line.length === 0 && unit.space) continue;
    const nextWidth = width + unit.width;
    if (line.length > 0 && nextWidth > maxWidth) {
      flush();
      if (unit.space) continue;
    }
    line.push(unit);
    width += unit.width;
  }
  flush();
  return lines;
}

function balanceLines(lines: Unit[][], maxWidth: number): Unit[][] {
  if (lines.length !== 2) return lines;
  const all = lines.flat();
  const totalWidth = all.reduce((sum, unit) => sum + unit.width, 0);
  let best = lines;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (let split = 1; split < all.length; split += 1) {
    const left = all.slice(0, split);
    const right = all.slice(split);
    if (left[left.length - 1]?.space || right[0]?.space) continue;
    const leftWidth = left.reduce((sum, unit) => sum + unit.width, 0);
    const rightWidth = right.reduce((sum, unit) => sum + unit.width, 0);
    if (leftWidth > maxWidth || rightWidth > maxWidth) continue;
    const delta = Math.abs(leftWidth - rightWidth);
    if (delta < bestDelta && Math.abs(leftWidth + rightWidth - totalWidth) < 0.01) {
      bestDelta = delta;
      best = [left, right];
    }
  }
  return best;
}

function wrapsToRuns(lines: Unit[][], activeSentenceId: number, size: number, lineHeight: number, contentTop: number) {
  return lines.map((units, index): LayoutLine => {
    const runs = joinLines(units);
    for (const run of runs) run.active = run.sentenceId === activeSentenceId;
    return {
      runs,
      text: units.map((unit) => unit.text).join(""),
      width: units.reduce((sum, unit) => sum + unit.width, 0),
      baseline: contentTop + size * 0.86 + index * size * lineHeight
    };
  });
}

function cueUnits(cue: SubtitleCue, measure: MeasureText, font: string): Unit[] {
  const units: Unit[] = [];
  for (let index = 0; index < cue.sentences.length; index += 1) {
    const sentence = cue.sentences[index];
    if (index > 0) {
      units.push({ text: " ", sentenceId: sentence.id, space: true, width: measure(" ", font).width });
    }
    units.push(...tokenizeSentence(sentence.text, sentence.id, measure, font));
  }
  return units;
}

interface PlacementCandidate {
  placement: SubtitleLayout["placement"];
  x: number;
  y: number;
}

function candidatePlacements(
  preset: VideoPreset,
  backgroundWidth: number,
  backgroundHeight: number,
  preference: RenderRequest["placement"]
): PlacementCandidate[] {
  const safe = preset.safe;
  const xCenter = safe.x + (safe.width - backgroundWidth) / 2;
  const xLeft = safe.x;
  const xRight = safe.x + safe.width - backgroundWidth;
  const yBottom = Math.min(safe.y + safe.height, preset.height - preset.bottomInset) - backgroundHeight;
  const yTop = safe.y;
  const all: PlacementCandidate[] = [
    { placement: "bottom", x: xCenter, y: yBottom },
    { placement: "top", x: xCenter, y: yTop },
    { placement: "subject-left", x: xLeft, y: yBottom },
    { placement: "subject-right", x: xRight, y: yBottom }
  ];

  if (preference === "bottom") return all.filter((candidate) => candidate.placement !== "top");
  if (preference === "top") return all.filter((candidate) => candidate.placement === "top");
  return [all[0], all[1], all[2], all[3]];
}

export function layoutSubtitle(request: RenderRequest, measure: MeasureText): SubtitleLayout {
  const { preset, style, cue, timeUs } = request;
  if (!cue) {
    return {
      visible: false,
      cueId: null,
      activeSentenceId: -1,
      fontSize: preset.fontSize,
      lineHeight: preset.lineHeight,
      lines: [],
      textBox: { x: 0, y: 0, width: 0, height: 0 },
      backgroundBox: { x: 0, y: 0, width: 0, height: 0 },
      placement: "bottom",
      subjectOverlap: 0,
      warnings: []
    };
  }

  const activeSentence = activeSentenceAt(cue, timeUs);
  const activeSentenceId = activeSentence?.id ?? cue.sentences[0]?.id ?? -1;
  const availableWidth = preset.safe.width - preset.horizontalPadding * 2;
  const warnings: string[] = [];
  const baseFontSize = Math.round(preset.fontSize * (style.fontScale ?? 1));
  const minFontSize = Math.round(preset.minFontSize * (style.fontScale ?? 1));
  let fontSize = baseFontSize;
  let lines: Unit[][] = [];

  for (; fontSize >= minFontSize; fontSize -= 2) {
    const font = fontFor(fontSize, style);
    const units = cueUnits(cue, measure, font);
    lines = balanceLines(wrapUnits(units, availableWidth), availableWidth);
    if (lines.length <= preset.maxLines) break;
  }

  fontSize = Math.max(minFontSize, fontSize);
  const font = fontFor(fontSize, style);
  const units = cueUnits(cue, measure, font);
  lines = balanceLines(wrapUnits(units, availableWidth), availableWidth);

  if (fontSize < baseFontSize) warnings.push(`字号自适应 ${baseFontSize} → ${fontSize}px`);
  if (lines.length > preset.maxLines) {
    warnings.push(`接近 ${preset.maxLines + 1} 行，建议拆分字幕`);
    lines = lines.slice(0, preset.maxLines);
    const last = lines[lines.length - 1];
    last.push({ text: "…", sentenceId: last[last.length - 1]?.sentenceId ?? 0, space: false, width: measure("…", font).width });
  }

  const contentWidth = Math.min(availableWidth, Math.max(1, ...lines.map((line) => line.reduce((sum, unit) => sum + unit.width, 0))));
  const contentHeight = Math.max(fontSize, (lines.length - 1) * fontSize * preset.lineHeight + fontSize * 1.18);
  const backgroundWidth = Math.min(preset.safe.width, contentWidth + preset.horizontalPadding * 2);
  const backgroundHeight = contentHeight + preset.verticalPadding * 2;
  const subject = subjectRect(request.subjectBox, preset);
  const expandedSubject = subject
    ? { x: subject.x - 8, y: subject.y - 8, width: subject.width + 16, height: subject.height + 16 }
    : null;
  const candidates = candidatePlacements(preset, backgroundWidth, backgroundHeight, request.placement);

  let chosen = candidates[0];
  let chosenOverlap = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const backgroundRect: Rect = { x: candidate.x, y: candidate.y, width: backgroundWidth, height: backgroundHeight };
    if (!rectInside(backgroundRect, preset.safe)) continue;
    const overlap = expandedSubject ? overlaps(backgroundRect, expandedSubject) : 0;
    if (overlap < chosenOverlap) {
      chosen = candidate;
      chosenOverlap = overlap;
      if (overlap === 0 && candidate.placement === (request.placement === "top" ? "top" : "bottom")) break;
    }
  }
  if (!Number.isFinite(chosenOverlap)) {
    chosen = candidates[0];
    chosenOverlap = 0;
  }

  const contentTop = chosen.y + preset.verticalPadding;
  const layoutLines = wrapsToRuns(lines, activeSentenceId, fontSize, preset.lineHeight, contentTop);
  const actualMaxWidth = Math.max(fontSize, ...layoutLines.map((line) => line.width));
  const contentLeft = chosen.x + Math.max(preset.horizontalPadding, (backgroundWidth - actualMaxWidth) / 2);
  const textBox: Rect = {
    x: contentLeft,
    y: contentTop,
    width: actualMaxWidth,
    height: contentHeight
  };
  const backgroundBox: Rect = { x: chosen.x, y: chosen.y, width: backgroundWidth, height: backgroundHeight };
  const normalizedOverlap = subject ? Math.max(0, chosenOverlap) / (subject.width * subject.height) : 0;
  if (normalizedOverlap > 0) warnings.push(`主体避让不足，重叠 ${Math.round(normalizedOverlap * 100)}%`);
  if (!rectInside(backgroundBox, preset.safe)) warnings.push("字幕超出安全区");

  return {
    visible: true,
    cueId: cue.id,
    activeSentenceId,
    fontSize,
    lineHeight: fontSize * preset.lineHeight,
    lines: layoutLines,
    textBox,
    backgroundBox,
    placement: chosen.placement,
    subjectOverlap: normalizedOverlap,
    warnings
  };
}

export function getLayoutAtTime(
  cues: SubtitleCue[],
  timeUs: number,
  preset: VideoPreset,
  style: LayoutStyle,
  subjectBox: SubjectBox | null,
  placement: RenderRequest["placement"],
  measure: MeasureText
): SubtitleLayout {
  return layoutSubtitle(
    { preset, style, subjectBox, placement, timeUs, cue: activeCueAt(cues, timeUs) },
    measure
  );
}

export function approximateMeasure(fontSize: number): MeasureText {
  return (text: string, font: string) => {
    const size = Number(font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? fontSize);
    let width = 0;
    for (const character of text) {
      if (isCjk(character)) width += size;
      else if (/\s/u.test(character)) width += size * 0.28;
      else if (/[ilI.,'!:;|]/u.test(character)) width += size * 0.32;
      else if (/[mwMW@%]/u.test(character)) width += size * 0.85;
      else width += size * 0.56;
    }
    return { width };
  };
}

export { overlaps, rectInside, subjectRect };
