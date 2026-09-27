/**
 * `vid` → 无水印高清原片（三步 API）。
 *
 * 这是本项目**唯一向豆包发起的主动网络请求**，也是唯一能拿到 39MB 级原始视频的路径
 * （带水印的播放版通常只有 2MB）。接口契约全部来自 site-contract.ts。
 *
 * 拆分理由：三个「从响应里取 id / url」的动作是纯函数，单独可测；
 * 网络编排（串行三步 + 缓存 + 并发闸门）单独一层。
 */

import { LIMITS } from './constants';
import { asNumber, asString, getPath, isObject } from './extract/common';
import {
  AISPACE_DOWNLOAD_INFO_BODY,
  AISPACE_GET_DOWNLOAD_INFO,
  AISPACE_HOMEPAGE,
  AISPACE_NODE_INFO,
  AISPACE_NODE_INFO_BODY,
  AISPACE_QUERY,
  CREATION_ROOT_NAME,
} from './site-contract';

/* --------------------------------------------------------------------------- */
/* 纯函数：三步响应解析                                                          */
/* --------------------------------------------------------------------------- */

/** 第 1 步：data.children[] 里 name === '我的创作' 的 id */
export function findCreationId(homepage: unknown, rootName: string = CREATION_ROOT_NAME): string | null {
  const children = getPath(homepage, ['data', 'children']);
  if (!Array.isArray(children)) return null;
  for (const child of children) {
    if (isObject(child) && child.name === rootName) return asString(child.id) ?? null;
  }
  return null;
}

/** 第 2 步：data.children[] 里 key === vid 的 id */
export function findNodeId(nodeInfo: unknown, vid: string): string | null {
  const children = getPath(nodeInfo, ['data', 'children']);
  if (!Array.isArray(children)) return null;
  for (const child of children) {
    if (isObject(child) && String(child.key) === String(vid)) return asString(child.id) ?? null;
  }
  return null;
}

/** 第 3 步：data.download_infos[0].main_url */
export function findDownloadUrl(downloadInfo: unknown): string | null {
  const infos = getPath(downloadInfo, ['data', 'download_infos']);
  if (!Array.isArray(infos) || !infos.length) return null;
  return asString(getPath(infos[0], ['main_url'])) ?? null;
}

/** 第 3 步顺带可得的媒体元数据（2026-09-27 补：解析时若有就带回，避免界面显示「—」） */
export interface VidMeta {
  width?: number;
  height?: number;
  /** 字节 */
  size?: number;
}

/**
 * 第 3 步：`data.download_infos[0]` 里的 width / height / size。
 *
 * ⚠️ 上游只取了 `main_url`，其余字段全扔；这里同样**只读不猜** ——
 * 字段存在（且能转成数字）才带回，不存在就缺省，绝不编造。
 */
export function findDownloadMeta(downloadInfo: unknown): VidMeta {
  const meta: VidMeta = {};
  const infos = getPath(downloadInfo, ['data', 'download_infos']);
  const info = Array.isArray(infos) && isObject(infos[0]) ? infos[0] : null;
  if (!info) return meta;
  const width = asNumber(info.width);
  const height = asNumber(info.height);
  const size = asNumber(info.size);
  if (width !== undefined) meta.width = width;
  if (height !== undefined) meta.height = height;
  if (size !== undefined) meta.size = size;
  return meta;
}

/* --------------------------------------------------------------------------- */
/* 诊断：三步 API 的步骤级事实                                                     */
/* --------------------------------------------------------------------------- */

/**
 * 三步的机器名（与三个接口一一对应）。
 *
 * 做这层诊断的原因（2026-09-27）：卡片长期停在「解析中」时，诊断页原先只有一行
 * `vid.resolve … → null`，**看不出是哪一步、什么原因**（HTTP 状态？超时？返回了风控页？）。
 * 实测中最容易混在一起的三类：网络层失败（代理/证书）、超时、以及站点返回非 200。
 */
export type VidStepName = 'homepage' | 'node_info' | 'get_download_info';

/** 单步结果。只喂给 `onStep` 回调做诊断，不参与任何解析判定。 */
export interface VidStepEvent {
  vid: string;
  step: VidStepName;
  ok: boolean;
  /** 该步耗时（毫秒） */
  ms: number;
  /** HTTP 状态码（请求真的到达服务器时才有） */
  status?: number;
  /** 失败原因；或成功时的关键事实（`创作 id=…` / `node id=…` / `download_infos=1`） */
  detail?: string;
}

/** 一步一行，可直接进诊断页 */
export function formatVidStep(event: VidStepEvent): string {
  const status = event.status === undefined ? '' : ` status=${event.status}`;
  const detail = event.detail ? ` ${event.detail}` : '';
  return `step=${event.step} ${event.ok ? 'ok' : '失败'} ms=${event.ms}${status}${detail}`;
}

/** HTTP 非 2xx：带上状态码与响应体片段（判断是不是风控页 / 登录页 / 被代理改写，看它最快） */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly preview?: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

/**
 * 把三步 API 的异常翻译成人话。
 *
 * 三类在实机上表现完全相同（都只是「解析不出来」），但处置完全不同：
 *   ① 非 2xx —— 站点侧拒绝（未登录 / 风控 / 被代理改写）；
 *   ② 超时 —— 链路慢（境外节点常见），换代理或直连即可；
 *   ③ 其它网络层失败 —— `TypeError: Failed to fetch` 这类，代理不可达 / 证书不受信最常见。
 */
export function describeVidError(error: unknown, timeoutMs?: number): { status?: number; detail: string } {
  if (error instanceof HttpStatusError) {
    const preview = error.preview ? `；响应片段=${error.preview}` : '';
    return { status: error.status, detail: `HTTP ${error.status}${preview}` };
  }
  const name = (error as { name?: string } | null)?.name;
  if (name === 'AbortError') {
    return { detail: `请求超时${timeoutMs === undefined ? '' : `（>${timeoutMs}ms）`}` };
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { detail: `请求未完成（${message}）—— 网络层/代理/证书问题常见于此` };
}

/**
 * 摘出响应里的 `code` / `msg` 与关键列表长度 —— **只摘实际存在的字段，不猜**。
 * 站点若返回风控或错误结构，这一行通常就能看出差别。
 */
export function describeVidPayload(payload: unknown, countKey?: string): string {
  const parts: string[] = [];
  if (isObject(payload)) {
    const code = asNumber(payload.code);
    if (code !== undefined) parts.push(`code=${code}`);
    const msg = asString(payload.msg) ?? asString(payload.message);
    if (msg) parts.push(`msg=${msg.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  if (countKey) {
    const list = getPath(payload, ['data', countKey]);
    parts.push(`${countKey}=${Array.isArray(list) ? list.length : '缺失'}`);
  }
  return parts.join(' ') || '无可用字段';
}

/** 非 2xx 时抓一小段响应体（受长度限制），用于判断页面到底是什么 */
async function readPreview(response: Response, max = 200): Promise<string | undefined> {
  try {
    const text = await response.text();
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat ? flat.slice(0, max) : undefined;
  } catch {
    return undefined;
  }
}

/* --------------------------------------------------------------------------- */
/* 编排层                                                                        */
/* --------------------------------------------------------------------------- */

export interface VidResolverOptions {
  /** 便于注入测试替身；默认使用页面 window.fetch */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** 同时在飞的请求上限（豆包限流未知，取保守值） */
  concurrency?: number;
  /**
   * 缓存有效期（毫秒）。0 = 永久缓存（测试或特殊场景可用）。
   * 默认 `LIMITS.VID_RESOLVE_TTL_MS` —— 见该常量的说明：原片地址是带时效的签名 URL。
   */
  ttlMs?: number;
  /** 便于注入时钟（单测用） */
  now?: () => number;
  /**
   * 每走完一步回调一次（成功与失败都回调），供调用方写进诊断。
   * 只在 `resolve()` 真的发起请求时触发（命中缓存不会触发）。
   */
  onStep?: (event: VidStepEvent) => void;
}

export interface VidResolveOptions {
  /** 忽略缓存，强制重新走三步 API（用于签名过期后的自愈重试） */
  force?: boolean;
}

export interface VidResolver {
  /** 解析 vid；成功返回原片 URL，失败返回 null（不缓存失败，允许重试） */
  resolve(vid: string, options?: VidResolveOptions): Promise<string | null>;
  /** 最近一次成功解析时第 3 步带出的元数据（未命中缓存返回 null） */
  metaOf(vid: string): VidMeta | null;
  /** 是否已有**未过期**的缓存结果 */
  has(vid: string): boolean;
  /** 丢弃全部缓存（切换会话 / 怀疑签名过期时调用） */
  clear(): void;
  /** 当前在飞请求数 */
  readonly inflight: number;
}

export function createVidResolver(options: VidResolverOptions = {}): VidResolver {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? LIMITS.VID_RESOLVE_TIMEOUT_MS;
  const maxConcurrency = Math.max(1, options.concurrency ?? 2);
  const ttlMs = options.ttlMs ?? LIMITS.VID_RESOLVE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const onStep = options.onStep;

  /** vid → { url, meta, at }；`at` 用于 TTL 判定 */
  const cache = new Map<string, { url: string; meta: VidMeta; at: number }>();
  const pending = new Map<string, Promise<string | null>>();
  let running = 0;
  const waiting: Array<() => void> = [];

  /** 命中且未过期的缓存；过期的顺手删掉 */
  function freshCached(vid: string): { url: string; meta: VidMeta } | null {
    const hit = cache.get(vid);
    if (!hit) return null;
    if (ttlMs > 0 && now() - hit.at >= ttlMs) {
      cache.delete(vid);
      return null;
    }
    return { url: hit.url, meta: hit.meta };
  }

  async function acquire(): Promise<void> {
    if (running < maxConcurrency) {
      running++;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
  }

  function release(): void {
    running--;
    const next = waiting.shift();
    if (next) next();
  }

  async function postJson(pathName: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`${pathName}?${AISPACE_QUERY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'include',
        signal: controller.signal,
      });
      if (!response.ok) throw new HttpStatusError(response.status, await readPreview(response));
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 串行三步。**每一步无论成败都回调 `onStep`** —— 这是「解析失败」可归因的唯一来源：
   * 原先只把 null 交给上层，风控、超时、结构变化在诊断页里长得一模一样。
   */
  async function runThreeSteps(vid: string): Promise<{ url: string; meta: VidMeta } | null> {
    const emit = (step: VidStepName, ok: boolean, startedAt: number, extra: { status?: number; detail?: string } = {}) => {
      onStep?.({ vid, step, ok, ms: Math.max(0, now() - startedAt), ...extra });
    };

    // ---- 第 1 步：找「我的创作」这个根节点的 id ----
    let startedAt = now();
    let homepage: unknown;
    try {
      homepage = await postJson(AISPACE_HOMEPAGE, {});
    } catch (error) {
      emit('homepage', false, startedAt, describeVidError(error, timeoutMs));
      return null;
    }
    const cid = findCreationId(homepage);
    if (!cid) {
      emit('homepage', false, startedAt, { detail: `没有「我的创作」条目（${describeVidPayload(homepage, 'children')}）` });
      return null;
    }
    emit('homepage', true, startedAt, { detail: `创作 id=${cid}` });

    // ---- 第 2 步：按 vid 找该视频的 node id ----
    startedAt = now();
    let nodeInfo: unknown;
    try {
      nodeInfo = await postJson(AISPACE_NODE_INFO, AISPACE_NODE_INFO_BODY(cid));
    } catch (error) {
      emit('node_info', false, startedAt, describeVidError(error, timeoutMs));
      return null;
    }
    const nid = findNodeId(nodeInfo, vid);
    if (!nid) {
      emit('node_info', false, startedAt, {
        detail: `没有 key=${vid} 的条目（${describeVidPayload(nodeInfo, 'children')}）`,
      });
      return null;
    }
    emit('node_info', true, startedAt, { detail: `node id=${nid}` });

    // ---- 第 3 步：取无水印原片地址 ----
    startedAt = now();
    let downloadInfo: unknown;
    try {
      downloadInfo = await postJson(AISPACE_GET_DOWNLOAD_INFO, AISPACE_DOWNLOAD_INFO_BODY(nid));
    } catch (error) {
      emit('get_download_info', false, startedAt, describeVidError(error, timeoutMs));
      return null;
    }
    const url = findDownloadUrl(downloadInfo);
    if (!url) {
      emit('get_download_info', false, startedAt, {
        detail: `没有可用的 main_url（${describeVidPayload(downloadInfo, 'download_infos')}）`,
      });
      return null;
    }
    emit('get_download_info', true, startedAt, { detail: describeVidPayload(downloadInfo, 'download_infos') });
    return { url, meta: findDownloadMeta(downloadInfo) };
  }

  async function resolve(vid: string, resolveOptions: VidResolveOptions = {}): Promise<string | null> {
    if (!vid) return null;

    if (resolveOptions.force) cache.delete(vid);
    else {
      const cached = freshCached(vid);
      if (cached) return cached.url;
    }

    // 已有同一 vid 的在飞请求 → 复用它（在飞结果一定是新鲜的，不必重复发）
    const existing = pending.get(vid);
    if (existing) return existing;

    const task = (async () => {
      await acquire();
      try {
        const result = await runThreeSteps(vid);
        if (result) cache.set(vid, { url: result.url, meta: result.meta, at: now() });
        return result?.url ?? null;
      } catch (error) {
        console.debug('[UWD] vid 解析失败', vid, error);
        return null;
      } finally {
        release();
        pending.delete(vid);
      }
    })();

    pending.set(vid, task);
    return task;
  }

  return {
    resolve,
    metaOf: (vid: string) => freshCached(vid)?.meta ?? null,
    has: (vid: string) => freshCached(vid) !== null,
    clear: () => {
      cache.clear();
    },
    get inflight() {
      return pending.size;
    },
  };
}
