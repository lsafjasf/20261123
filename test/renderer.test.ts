import test from "node:test";
import assert from "node:assert/strict";
import { makeProject } from "./helpers.ts";
import { buildPlans } from "../src/shared/timeline.ts";
import { renderFrame, type LoadedImage, type RenderContext } from "../src/web/renderer.ts";
import type { Project } from "../src/shared/types.ts";

interface DrawCall {
  imageId: string;
  source: { x: number; y: number; width: number; height: number };
  destination: { width: number; height: number };
  alpha: number;
}

class FakeBitmap {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

class FakeContext {
  readonly calls: DrawCall[] = [];
  fillStyle = "";
  globalAlpha = 1;
  imageSmoothingEnabled = false;
  imageSmoothingQuality: ImageSmoothingQuality = "low";
  private currentId = "";

  fillRect(): void {}

  save(): void {}

  restore(): void {}

  drawImage(
    image: FakeBitmap & { __id?: string },
    x: number,
    y: number,
    width: number,
    height: number,
    destX: number,
    destY: number,
    destWidth: number,
    destHeight: number,
  ): void {
    this.calls.push({
      imageId: image.__id ?? "",
      source: { x, y, width, height },
      destination: { x: destX, y: destY, width: destWidth, height: destHeight },
      alpha: this.globalAlpha,
    });
  }
}

function makeRenderContext(project: Project): { render: RenderContext; ctx: FakeContext } {
  const bundle = buildPlans(project);
  const ctx = new FakeContext();
  const images = new Map<string, LoadedImage>();
  for (const spec of project.images) {
    const bitmap = new FakeBitmap(spec.pixelWidth, spec.pixelHeight) as FakeBitmap & { __id?: string };
    bitmap.__id = spec.id;
    images.set(spec.id, {
      bitmap: bitmap as unknown as HTMLImageElement,
      width: spec.pixelWidth,
      height: spec.pixelHeight,
    });
  }
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    render: {
      ctx: ctx as unknown as CanvasRenderingContext2D,
      project,
      timeline: bundle.timeline,
      plans: bundle.plans,
      images,
    },
  };
}

test("renderer draws full-bleed frames and crossfades during transitions", () => {
  const project = makeProject();
  const { render, ctx } = makeRenderContext(project);
  const timeline = render.timeline;

  renderFrame(render, 0.1);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].destination.width, project.video.width);
  assert.equal(ctx.calls[0].destination.height, project.video.height);

  const first = timeline.segments[0];
  const transitionTime = first.leaveAt + timeline.transitionSeconds * 0.5;
  ctx.calls.length = 0;
  renderFrame(render, transitionTime);
  assert.equal(ctx.calls.length, 2);
  const incoming = ctx.calls[0];
  const outgoing = ctx.calls[1];
  assert.equal(incoming.alpha, 1);
  assert.ok(outgoing.alpha > 0 && outgoing.alpha < 1);
  assert.equal(incoming.imageId, timeline.segments[1].imageId);
  assert.equal(outgoing.imageId, timeline.segments[0].imageId);
  assert.ok(outgoing.alpha < 1);
});

test("every drawn source rectangle stays inside the source image", () => {
  const project = makeProject();
  const { render, ctx } = makeRenderContext(project);
  for (let time = 0; time < render.timeline.duration; time += 0.25) {
    ctx.calls.length = 0;
    renderFrame(render, time);
    for (const call of ctx.calls) {
      assert.ok(call.source.x >= 0);
      assert.ok(call.source.y >= 0);
      assert.ok(call.source.x + call.source.width <= project.video.width * 2);
      const spec = project.images.find((item) => item.id === call.imageId);
      assert.ok(spec);
      assert.ok(call.source.x + call.source.width <= spec.pixelWidth);
      assert.ok(call.source.y + call.source.height <= spec.pixelHeight);
    }
  }
});
