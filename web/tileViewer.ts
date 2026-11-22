// 分块滚动浏览器：用一个全帧尺寸的滚动容器承载每块独立 canvas，
// IntersectionObserver 驱动懒渲染。滚到任何一块都会触发该块（含 halo 的
// 采样区 -> 核心区）GPU 渲染并贴入，块间靠共享整帧纹理与同一坐标数学无缝。

import type { TileRenderer } from './tileRenderer.ts';
import type { TileGrid, TileRect } from '../shared/tiling.ts';
import type { FilterParams } from '../shared/filters.ts';

export class TileViewer {
  private readonly container: HTMLDivElement;
  private readonly cells = new Map<number, HTMLCanvasElement>();
  private readonly observer: IntersectionObserver;
  private currentFilter: FilterParams | null = null;
  private renderedTiles = new Set<number>();
  onTileRendered: ((index: number, elapsedMs: number) => void) | null = null;

  constructor(
    private readonly renderer: TileRenderer,
    private readonly grid: TileGrid,
    host: HTMLElement,
  ) {
    this.container = document.createElement('div');
    this.container.style.position = 'relative';
    this.container.style.width = `${grid.frameWidth}px`;
    this.container.style.height = `${grid.frameHeight}px`;
    this.container.style.background = '#000';
    host.innerHTML = '';
    host.style.overflow = 'auto';
    host.appendChild(this.container);

    for (const tile of grid.tiles) {
      const cell = document.createElement('canvas');
      cell.width = tile.width;
      cell.height = tile.height;
      cell.style.position = 'absolute';
      cell.style.left = `${tile.x0}px`;
      cell.style.top = `${tile.y0}px`;
      cell.style.outline = '1px solid rgba(255,255,255,0.15)';
      cell.dataset.index = String(tile.index);
      this.container.appendChild(cell);
      this.cells.set(tile.index, cell);
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const index = Number((entry.target as HTMLCanvasElement).dataset.index);
            this.renderCell(index);
          }
        }
      },
      { root: host, rootMargin: '200px' },
    );
    for (const cell of this.cells.values()) this.observer.observe(cell);
  }

  /** 更新滤镜参数并使所有块失效，下次进入视口时重渲染。 */
  setFilter(filter: FilterParams): void {
    this.currentFilter = filter;
    this.renderedTiles.clear();
    for (const cell of this.cells.values()) {
      const ctx = cell.getContext('2d')!;
      ctx.clearRect(0, 0, cell.width, cell.height);
    }
    // 重新评估视口内的块
    for (const cell of this.cells.values()) this.observer.unobserve(cell);
    for (const cell of this.cells.values()) this.observer.observe(cell);
  }

  /** 立即渲染指定块（滚动定位/测试可直接调用）。 */
  renderCell(index: number): void {
    if (this.renderedTiles.has(index) || !this.currentFilter) return;
    const tile: TileRect = this.grid.tiles[index];
    const cell = this.cells.get(index)!;
    const start = performance.now();
    // 单块重渲染：复用整帧纹理，仅绘制该块 FBO
    this.renderer.renderSingleTile(index, this.currentFilter);
    const ctx = cell.getContext('2d')!;
    this.renderer.blitTileCore(index, ctx);
    this.renderedTiles.add(index);
    this.onTileRendered?.(index, performance.now() - start);
  }

  /** 程序化滚动到某块中心并保证其已渲染（“滚动任何一块都能看到最终画面”）。 */
  scrollToTile(host: HTMLElement, index: number): void {
    const tile = this.grid.tiles[index];
    const cell = this.cells.get(index)!;
    host.scrollTo({
      left: tile.x0 - host.clientWidth / 2 + tile.width / 2,
      top: tile.y0 - host.clientHeight / 2 + tile.height / 2,
      behavior: 'auto',
    });
    this.renderCell(index);
    cell.scrollIntoView({ block: 'center', inline: 'center' });
  }

  get renderedCount(): number {
    return this.renderedTiles.size;
  }

  dispose(): void {
    this.observer.disconnect();
    this.container.remove();
  }
}
