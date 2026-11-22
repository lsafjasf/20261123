/**
 * 前端主控制器：负责视图切换、轮次生命周期、引擎装配与数据分发。
 * 轮次 ID 贯穿 WebSocket 房间、状态存储与报告请求，确保不同轮次物理隔离。
 */

import { WsClient } from './transport/ws-client.ts';
import { ClockBridge } from './transport/clock-bridge.ts';
import { SenderEngine } from './sender/sender-engine.ts';
import { ReceiverEngine } from './receiver/receiver-engine.ts';
import { StateStore } from './ui/state-store.ts';
import { drawStageLines } from './ui/charts.ts';
import { downloadJson, renderReport } from './ui/report-view.ts';
import { buildRoundReport } from '../shared/analytics.ts';
import type {
  ControlMessage,
} from '../shared/protocol.ts';
import type {
  DropEvent,
  MarkerTimeline,
  Role,
  RoundReport,
} from '../shared/types.ts';

interface Session {
  roundId: string;
  label: string;
  role: Role;
  ws: WsClient;
  clock: ClockBridge;
  sender?: SenderEngine;
  receiver?: ReceiverEngine;
}

class AppController {
  private readonly store = new StateStore();
  private session: Session | null = null;
  private readonly elements = this.collectElements();

  collectElements(): Record<string, HTMLElement> {
    const ids = [
      'round-label', 'round-id-input', 'btn-create-round', 'btn-join-round',
      'round-list', 'btn-role-sender', 'btn-role-receiver', 'loopback-mode',
      'home-status', 'view-home', 'view-sender', 'view-receiver', 'view-report',
      'sender-round-id', 'btn-sender-start', 'btn-sender-fire',
      'btn-sender-stop', 'fire-interval', 'btn-auto-fire', 'sender-status',
      'flash-canvas', 'sender-line', 'receiver-round-id',
      'btn-receiver-start', 'btn-receiver-stop', 'btn-refresh-report',
      'receiver-status', 'playback', 'receiver-flash', 'receiver-line',
      'report-round-id', 'report-summary', 'report-bars', 'marker-table',
      'drop-list', 'btn-export-json', 'btn-back-home',
    ];
    return Object.fromEntries(
      ids.map((id) => [id, document.getElementById(id) as HTMLElement]),
    );
  }

  init(): void {
    this.bindHome();
    this.bindSender();
    this.bindReceiver();
    this.bindReport();
    this.store.subscribe(() => this.renderLiveCharts());
    void this.loadRoundList();
  }

  private show(view: 'home' | 'sender' | 'receiver' | 'report'): void {
    for (const name of ['home', 'sender', 'receiver', 'report'] as const) {
      this.elements[`view-${name}`].classList.toggle(
        'hidden',
        name !== view,
      );
    }
  }

  private status(text: string, target: 'home' | 'sender' | 'receiver'): void {
    const element = this.elements[`${target}-status`];
    if (element) {
      element.textContent = text;
    }
  }

  private bindHome(): void {
    this.elements['btn-create-round'].addEventListener('click', () => {
      const label =
        (this.elements['round-label'] as HTMLInputElement).value ||
        `轮次 ${new Date().toLocaleString()}`;
      const roundId = crypto.randomUUID();
      localStorage.setItem('pending-round', JSON.stringify({ roundId, label }));
      this.status(`已创建轮次 ${roundId}，请选择角色`, 'home');
    });
    this.elements['btn-join-round'].addEventListener('click', () => {
      const roundId = (
        this.elements['round-id-input'] as HTMLInputElement
      ).value.trim();
      if (roundId) {
        localStorage.setItem(
          'pending-round',
          JSON.stringify({ roundId, label: '加入的轮次' }),
        );
        this.status(`已锁定轮次 ${roundId}，请选择角色`, 'home');
      }
    });
    this.elements['btn-role-sender'].addEventListener('click', () =>
      this.enterSession('sender'),
    );
    this.elements['btn-role-receiver'].addEventListener('click', () =>
      this.enterSession('receiver'),
    );
  }

  private async loadRoundList(): Promise<void> {
    try {
      const response = await fetch('/api/rounds');
      const rounds: { roundId: string; label: string; closedAt: number | null }[] =
        await response.json();
      const list = this.elements['round-list'];
      list.innerHTML = '';
      for (const round of rounds) {
        const item = document.createElement('li');
        item.textContent = `${round.label}（${round.roundId}）${
          round.closedAt ? ' [已关闭]' : ''
        }`;
        const button = document.createElement('button');
        button.textContent = '查看报告';
        button.addEventListener('click', () => void this.openStoredReport(round.roundId));
        item.appendChild(button);
        list.appendChild(item);
      }
    } catch {
      this.status('轮次列表加载失败', 'home');
    }
  }

  private async openStoredReport(roundId: string): Promise<void> {
    const response = await fetch(`/api/rounds/${roundId}/report`);
    if (!response.ok) {
      return;
    }
    const report = (await response.json()) as RoundReport;
    this.store.setActiveRound(roundId);
    this.store.setReport(report);
    this.showReportView(report);
  }

  private enterSession(role: Role): void {
    const raw = localStorage.getItem('pending-round');
    if (!raw) {
      this.status('请先创建或加入一个轮次', 'home');
      return;
    }
    const { roundId, label } = JSON.parse(raw) as {
      roundId: string;
      label: string;
    };
    this.store.setActiveRound(roundId);
    const ws = new WsClient(roundId, role, {
      onControl: (message) => this.handleControl(message),
      onBinary: (bytes) => this.session?.receiver?.ingestBinary(bytes),
      onStatus: (text) =>
        this.status(text, role === 'sender' ? 'sender' : 'receiver'),
    });
    const clock = new ClockBridge(ws.raw as WebSocket, roundId);
    this.session = { roundId, label, role, ws, clock };
    ws.connect();
    this.waitForSocket(ws).then(() => clock.start(2000));
    if (role === 'sender') {
      (this.elements['sender-round-id'] as HTMLElement).textContent = roundId;
      this.show('sender');
    } else {
      (this.elements['receiver-round-id'] as HTMLElement).textContent = roundId;
      this.show('receiver');
    }
  }

  private waitForSocket(ws: WsClient): Promise<void> {
    return ws.onceOpen();
  }

  private bindSender(): void {
    this.elements['btn-sender-start'].addEventListener('click', () =>
      void this.startSender(),
    );
    this.elements['btn-sender-fire'].addEventListener('click', () => {
      this.session?.sender?.fireMarker();
    });
    this.elements['btn-auto-fire'].addEventListener('click', (event) => {
      const button = event.currentTarget as HTMLButtonElement;
      const sender = this.session?.sender;
      if (!sender) {
        return;
      }
      const interval = Number(
        (this.elements['fire-interval'] as HTMLInputElement).value,
      );
      sender.startAutoFire(interval);
      button.disabled = true;
      button.textContent = '自动标记进行中';
    });
    this.elements['btn-sender-stop'].addEventListener('click', () =>
      this.finishSession(),
    );
  }

  private async startSender(): Promise<void> {
    if (!this.session) {
      return;
    }
    await this.session.ws.onceOpen();
    const loopback = (
      this.elements['loopback-mode'] as HTMLInputElement
    ).checked;
    const sender = new SenderEngine(
      {
        roundId: this.session.roundId,
        label: this.session.label,
        ws: this.session.ws.raw as WebSocket,
        clock: this.session.clock,
        flashCanvas: this.elements['flash-canvas'] as HTMLCanvasElement,
        useLoopback: loopback,
      },
      {
        onMarker: (marker) => this.store.upsertMarker(marker),
        onDrop: (detail, stage) =>
          this.store.addDrop({
            roundId: this.session?.roundId ?? '',
            at: Date.now(),
            stage,
            detail,
            expectedSeq: null,
          }),
        onStatus: (text) => this.status(text, 'sender'),
      },
    );
    this.session.sender = sender;
    try {
      await sender.start();
    } catch (error) {
      this.status(`发送端启动失败：${(error as Error).message}`, 'sender');
    }
  }

  private bindReceiver(): void {
    this.elements['btn-receiver-start'].addEventListener('click', () =>
      void this.startReceiver(),
    );
    this.elements['btn-receiver-stop'].addEventListener('click', () =>
      this.finishSession(),
    );
    this.elements['btn-refresh-report'].addEventListener('click', () =>
      void this.buildClientReport(),
    );
  }

  private async startReceiver(): Promise<void> {
    if (!this.session) {
      return;
    }
    await this.session.ws.onceOpen();
    const receiver = new ReceiverEngine(
      {
        roundId: this.session.roundId,
        ws: this.session.ws.raw as WebSocket,
        clock: this.session.clock,
        audioElement: this.elements['playback'] as HTMLAudioElement,
      },
      {
        onMarker: (marker) => this.store.upsertMarker(marker),
        onDrop: (event) => this.store.addDrop(event),
        onStatus: (text) => this.status(text, 'receiver'),
      },
    );
    this.session.receiver = receiver;
    try {
      await receiver.start();
    } catch (error) {
      this.status(`接收端启动失败：${(error as Error).message}`, 'receiver');
    }
  }

  private handleControl(message: ControlMessage): void {
    if (this.session?.clock.handleMessage(message)) {
      // 时钟消息已处理，但无需进入引擎。
      return;
    }
    this.session?.receiver?.ingestControl(JSON.stringify(message));
    if (
      'roundId' in message &&
      this.session &&
      message.roundId !== this.session.roundId
    ) {
      return;
    }
    if (message.kind === 'marker') {
      this.store.upsertMarker({
        roundId: message.roundId,
        seq: message.seq,
        t0Marker: message.t0,
        t1Captured: null,
        t2Processed: null,
        t3Encoded: null,
        t4ServerRx: null,
        t5ServerTx: null,
        t6ClientRx: null,
        t7Decoded: null,
        t8Output: null,
      });
    } else if (message.kind === 'stage') {
      this.patchMarker(message.roundId, message.seq, (marker) => {
        if (message.stage === 'capture') {
          marker.t1Captured = message.t;
        } else if (message.stage === 'process') {
          marker.t2Processed = message.t;
        } else if (message.stage === 'upload') {
          marker.t3Encoded = message.t;
        } else if (message.stage === 'decode') {
          marker.t7Decoded = message.t;
        } else if (message.stage === 'output') {
          marker.t8Output = message.t;
        }
      });
    } else if (message.kind === 'drop') {
      this.store.addDrop(message.event as DropEvent);
    }
  }

  private patchMarker(
    roundId: string,
    seq: number,
    mutate: (marker: MarkerTimeline) => void,
  ): void {
    const existing = this.store.markers(roundId).find((m) => m.seq === seq);
    if (!existing) {
      return;
    }
    mutate(existing);
    this.store.upsertMarker({ ...existing });
  }

  private renderLiveCharts(): void {
    if (!this.session) {
      return;
    }
    const markers = this.store.markers(this.session.roundId);
    if (this.session.role === 'sender') {
      drawStageLines(
        this.elements['sender-line'] as HTMLCanvasElement,
        markers,
      );
    } else {
      drawStageLines(
        this.elements['receiver-line'] as HTMLCanvasElement,
        markers,
      );
    }
  }

  private async finishSession(): Promise<void> {
    if (!this.session) {
      return;
    }
    this.session.sender?.stop();
    this.session.receiver?.stop();
    this.session.clock.stop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await this.buildClientReport();
    this.session.ws.close();
    this.session = null;
    await this.loadRoundList();
  }

  private async buildClientReport(): Promise<void> {
    if (!this.session) {
      return;
    }
    const { roundId, label, clock } = this.session;
    const markers = this.store.markers(roundId);
    const drops = this.store.drops(roundId);
    const estimate = clock.current;
    const report = buildRoundReport({
      roundId,
      label,
      startedAt: markers[0]?.t0Marker ?? Date.now(),
      closedAt: null,
      markers,
      drops,
      clockOffsetMs: estimate.offsetMs,
      clockRttMs: estimate.rttMs,
    });
    this.store.setReport(report);
    this.showReportView(report);
  }

  private showReportView(report: RoundReport): void {
    const roundId = report.roundId;
    renderReport(
      report,
      this.store.markers(roundId),
      this.store.drops(roundId),
      {
        roundId: this.elements['report-round-id'],
        summary: this.elements['report-summary'],
        bars: this.elements['report-bars'] as HTMLCanvasElement,
        table: this.elements['marker-table'] as HTMLTableElement,
        dropList: this.elements['drop-list'],
      },
    );
    this.show('report');
  }

  private bindReport(): void {
    this.elements['btn-export-json'].addEventListener('click', () => {
      const roundId = this.store.activeRound;
      if (!roundId) {
        return;
      }
      const report = this.store.report(roundId);
      if (report) {
        downloadJson(report, this.store.markers(roundId));
      }
    });
    this.elements['btn-back-home'].addEventListener('click', () => {
      this.show('home');
      void this.loadRoundList();
    });
  }
}

const controller = new AppController();
controller.init();
