import type {
  LayoutManifest,
  ManifestEvent,
} from '/shared/types.ts';

/** Collects timeline events and serializes the frame-number change list. */
export class ManifestBuilder {
  private readonly events: ManifestEvent[] = [];
  private readonly frameRate: number;
  private readonly width: number;
  private readonly height: number;

  constructor(
    frameRate: number,
    width: number,
    height: number,
  ) {
    this.frameRate = frameRate;
    this.width = width;
    this.height = height;
  }

  add(event: ManifestEvent | null): void {
    if (event) this.events.push(event);
  }

  addAll(events: ManifestEvent[]): void {
    this.events.push(...events);
  }

  build(): LayoutManifest {
    const sorted = [...this.events].sort((a, b) =>
      a.frame === b.frame ? a.type.localeCompare(b.type) : a.frame - b.frame,
    );
    return {
      frameRate: this.frameRate,
      width: this.width,
      height: this.height,
      generatedAt: new Date().toISOString(),
      events: sorted,
    };
  }

  toJson(): string {
    return JSON.stringify(this.build(), null, 2);
  }

  /** Only the frames at which a layout segment changed. */
  layoutChangeFrames(): number[] {
    return this.events
      .filter((e) => e.type === 'layout-change')
      .map((e) => e.frame);
  }

  download(filename: string): void {
    const blob = new Blob([this.toJson()], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
