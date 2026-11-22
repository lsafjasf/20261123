interface StatusPayload {
  source: { state: "online" | "offline"; protocol: string; reconnectCount: number; lastSeenAt: number };
  cache: { gops: number; samples: number; bytes: number; limitBytes: number; oversizeDrops: number };
  clients: Array<{ state: string }>;
  totals: { ingressSamples: number; slowEvents: number };
}

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

async function refresh(): Promise<void> {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("status unavailable");
    const status = (await response.json()) as StatusPayload;
    const online = status.source.state === "online";
    $("source-state").textContent = online ? "在线" : "离线";
    $("source-state").className = online ? "online" : "offline";
    $("source-detail").textContent = online
      ? `${status.source.protocol} · 重连 ${status.source.reconnectCount} 次`
      : "等待制作机推流";
    $("cache-bytes").textContent = bytes(status.cache.bytes);
    $("cache-detail").textContent = `${status.cache.gops} GOP / ${status.cache.samples} 帧 · 上限 ${bytes(status.cache.limitBytes)}`;
    $("client-count").textContent = String(status.clients.length);
    const slow = status.clients.filter((client) => client.state === "slow").length;
    $("slow-count").textContent = `${slow} 个拥塞`;
    $("totals").textContent = `${status.totals.ingressSamples} 帧`;
    $("drop-count").textContent = `${status.totals.slowEvents} 次慢客户端降级`;
  } catch {
    $("source-state").textContent = "中继不可达";
    $("source-state").className = "error";
    $("source-detail").textContent = "检查 Node 服务是否运行";
  }
}

void refresh();
setInterval(refresh, 1000);
