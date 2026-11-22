import type { CaptionCue, Project } from "./types.ts";

export function formatTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function makeCues(project: Project): CaptionCue[] {
  return project.shots.map((shot) => ({
    id: shot.id,
    start: shot.start,
    end: shot.end,
    text: shot.text,
  }));
}

export function buildVtt(project: Project): string {
  const blocks = makeCues(project).map((cue, index) => {
    const shot = project.shots[index];
    return `${cue.id}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n<v ${shot.speaker}>${cue.text}</v>`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

export function wrapCaption(
  text: string,
  maxChars: number,
  maxLines = 2,
): string[] {
  const lines: string[] = [];
  let rest = text.trim();
  while (rest && lines.length < maxLines) {
    if (rest.length <= maxChars) {
      lines.push(rest);
      rest = "";
      break;
    }
    let cut = maxChars;
    const punctuation = Math.max(
      rest.lastIndexOf("，", maxChars),
      rest.lastIndexOf("。", maxChars),
      rest.lastIndexOf("、", maxChars),
    );
    if (punctuation >= Math.floor(maxChars * 0.55)) cut = punctuation + 1;
    lines.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest && lines.length === maxLines) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
  }
  return lines.filter(Boolean);
}
