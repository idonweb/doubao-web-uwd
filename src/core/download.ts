/**
 * 下载链路：文件名生成（纯函数）+ 单并发队列。
 *
 * 文件名规则（2026-09-28 第十二轮改版，取代方案 §7.1 的 `doubao-<convId>-<下载时刻>`）：
 *   doubao_<资源真实生成时间> <该资源所属对话页标题>.<ext>
 *   时间 = `YYYY-M-D HH-mm-ss`（年月日不补零，时分秒补零），取 `meta.createdAt`；
 *          拿不到时回退为**下载时刻**（用户拍板）。
 *   标题 = 条目的 `convTitle`（弱标题一律视为没有）；拿不到时回退为**会话 ID**（用户拍板）。
 *   多文件序号：首个不编号，同名冲突时从 `-02` 起两位补零。
 *
 * 取流方式由 `bg/service-worker.ts` 实现（方案 A / B），本文件只负责编排与命名。
 */

import { LIMITS } from './constants';
import { isWeakTitle } from './library-store';
import type { DownloadProgress } from './types';

/* --------------------------------------------------------------------------- */
/* 文件名（纯函数）                                                              */
/* --------------------------------------------------------------------------- */

const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** `YYYY-M-D HH-mm-ss`，本地时间 */
export function formatTimestamp(date: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` +
    ` ${p2(date.getHours())}-${p2(date.getMinutes())}-${p2(date.getSeconds())}`
  );
}

/** 净化单个路径片段：去掉非法字符，压掉首尾空白与结尾的点 */
export function sanitizeSegment(input: string): string {
  const cleaned = (input || '').replace(ILLEGAL_CHARS, '_').trim().replace(/[. ]+$/, '');
  return cleaned || 'unknown';
}

/** 净化扩展名（只留字母数字，最长 6 位） */
export function sanitizeExt(ext: string): string {
  const cleaned = (ext || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return cleaned || 'bin';
}

/** 文件名生成的输入（全部可选字段都有兜底，见文件头注释） */
export interface FilenameInput {
  /** 资源所属会话 ID（标题兜底；内联下载没有条目时它是唯一标识） */
  convId: string;
  ext: string;
  /** 资源真实生成时间（毫秒 epoch，= 条目的 `meta.createdAt`）；缺失 → 用 `now` */
  createdAtMs?: number;
  /** 资源所属对话页标题；弱标题 / 缺失 → 用 `convId` */
  convTitle?: string;
  /** 兜底时刻（缺省 = 当前时刻，即下载时刻） */
  now?: Date;
}

/** 标题位取值：弱标题（兜底值 / 站点通用名）一律视为没有 → 回退会话 ID；命中标题同样要净化非法字符 */
function titleSlot(convId: string, convTitle: string | undefined): string {
  const text = (convTitle ?? '').trim();
  if (text && !isWeakTitle(text)) return sanitizeSegment(text);
  return sanitizeSegment(convId);
}

/** 基础文件名（不含序号） */
export function baseFilename(input: FilenameInput): string {
  const when = formatTimestamp(input.createdAtMs ? new Date(input.createdAtMs) : (input.now ?? new Date()));
  return `doubao_${when} ${titleSlot(input.convId, input.convTitle)}.${sanitizeExt(input.ext)}`;
}

/** 带序号的候选名：index 从 2 起，两位补零 */
export function sequencedFilename(base: string, index: number): string {
  const dot = base.lastIndexOf('.');
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const ext = dot >= 0 ? base.slice(dot) : '';
  return `${stem}-${String(index).padStart(2, '0')}${ext}`;
}

/**
 * 一次批量下载内的文件名分配器。
 * 上游没有这一层，同一秒批量下载会互相覆盖；这里基于「本批次已生成的文件名集合」判重。
 */
export class FilenameAllocator {
  private used = new Set<string>();

  /** 已分配的文件名（只读快照） */
  get allocated(): string[] {
    return [...this.used];
  }

  next(input: FilenameInput): string {
    const base = baseFilename(input);
    if (!this.used.has(base)) {
      this.used.add(base);
      return base;
    }
    for (let i = 2; i < 1000; i++) {
      const candidate = sequencedFilename(base, i);
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
    const fallback = `${base}.${Date.now()}`;
    this.used.add(fallback);
    return fallback;
  }
}

/* --------------------------------------------------------------------------- */
/* 字节数实测（纯解析部分）                                                       */
/* --------------------------------------------------------------------------- */

/**
 * 从「Range 探测」的响应里读出**文件总字节数**（2026-09-28 第十轮补丁）。
 *
 * 背景：创作树里没有的条目（候选流 / 超期视频 / 超过约三个月的旧图片）拿不到节点 `size`，
 * 只能在 background 里对该条目的 `primary` 发一次 `Range: bytes=0-0` 的 GET，再从响应头读总长。
 * （调度规则 —— 入库即测、按「条目 + 归一化地址」记账、失败只重试 1 次 —— 见 `core/size-probe.ts`。）
 *
 * 实测（探针）：服务器支持 Range，回 **206** + `Content-Range: bytes 0-0/<总长>`，
 * 并且只下 1 字节（`Content-Length: 1`）。两种情形都要认：
 *   · **206** → 从 `Content-Range` 的 `/` 之后取总长；
 *   · **200**（站点忽略 Range）→ `Content-Length` 就是完整长度，**调用方必须中断响应体**，
 *     否则会把整个文件下下来（本函数只做解析，不负责中断）。
 * 认不出来（缺头 / 单位不明 / 非 2xx / 值非法）一律返回 `undefined` —— **宁缺勿假**。
 *
 * @param status  HTTP 状态码
 * @param header  取响应头的小函数（如 `(h) => res.headers.get(h)`）
 */
export function parseTotalBytes(
  status: number,
  header: (name: string) => string | null | undefined,
): number | undefined {
  const positive = (raw: string | null | undefined): number | undefined => {
    if (raw == null) return undefined;
    const value = Number(String(raw).trim());
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  if (status === 206) {
    const range = header('content-range');
    if (!range) return undefined;
    const total = positive(String(range).split('/')[1]);
    if (total === undefined) return undefined;
    // `bytes 0-0/1234` 之外的形式（`*`、缺 total）一律不认
    return /^bytes\s+\d+-\d+\/\d+$/i.test(String(range).trim()) ? total : undefined;
  }
  if (status === 200) return positive(header('content-length'));
  return undefined;
}

/* --------------------------------------------------------------------------- */
/* 单并发队列                                                                    */
/* --------------------------------------------------------------------------- */

export interface QueueJob {
  /** 条目 id，用于进度上报与失败回写 */
  id: string;
  /** 展示用名字 */
  label: string;
  /** 实际执行体；attempt 从 0 起 */
  run: (attempt: number) => Promise<void>;
}

export interface DownloadQueueOptions {
  concurrency?: number;
  /** 失败重试次数，默认 1 */
  retry?: number;
  onProgress?: (progress: DownloadProgress) => void;
  /** 每个任务结束时回调（成功 / 最终失败） */
  onJobDone?: (job: QueueJob, ok: boolean, error: Error | null) => void;
}

/**
 * 单并发下载队列。事件驱动、无定时器。
 * 失败重试 `retry` 次后仍失败 → 回调 `onJobDone(job, false, err)`，由调用方把条目标记为 fail。
 */
export class DownloadQueue {
  private readonly concurrency: number;
  private readonly retry: number;
  private readonly onProgress?: (progress: DownloadProgress) => void;
  private readonly onJobDone?: (job: QueueJob, ok: boolean, error: Error | null) => void;

  private pending: QueueJob[] = [];
  private running = 0;
  private doneCount = 0;
  private failedCount = 0;
  private current: string | null = null;
  private lastError: string | null = null;
  private stopped = false;

  constructor(options: DownloadQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? LIMITS.DOWNLOAD_CONCURRENCY);
    this.retry = Math.max(0, options.retry ?? LIMITS.DOWNLOAD_RETRY);
    this.onProgress = options.onProgress;
    this.onJobDone = options.onJobDone;
  }

  get progress(): DownloadProgress {
    return {
      total: this.doneCount + this.failedCount + this.running + this.pending.length,
      done: this.doneCount,
      failed: this.failedCount,
      running: this.running,
      current: this.current,
      lastError: this.lastError,
    };
  }

  enqueue(jobs: QueueJob[]): void {
    if (!jobs.length) return;
    this.pending.push(...jobs);
    this.emit();
    this.pump();
  }

  /** 停止接受后续任务（已在飞的任务会跑完） */
  stop(): void {
    this.stopped = true;
    this.pending = [];
    this.emit();
  }

  resume(): void {
    this.stopped = false;
  }

  private emit(): void {
    this.onProgress?.(this.progress);
  }

  private pump(): void {
    while (!this.stopped && this.running < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      if (!job) break;
      this.running++;
      this.current = job.id;
      this.emit();
      void this.execute(job);
    }
    if (!this.running && !this.pending.length) {
      this.current = null;
      this.emit();
    }
  }

  private async execute(job: QueueJob): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.retry; attempt++) {
      try {
        await job.run(attempt);
        lastError = null;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.retry) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }

    this.running--;
    if (lastError) {
      this.failedCount++;
      this.lastError = lastError.message;
      this.onJobDone?.(job, false, lastError);
    } else {
      this.doneCount++;
      this.onJobDone?.(job, true, null);
    }
    this.emit();
    this.pump();
  }
}
