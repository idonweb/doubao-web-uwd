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
import { asNumber, asString, getPath, isObject, siteTimeToMs } from './extract/common';
import {
  AISPACE_DOWNLOAD_INFO_BODY,
  AISPACE_GET_DOWNLOAD_INFO,
  AISPACE_HAS_MORE_KEY,
  AISPACE_HOMEPAGE,
  AISPACE_NEXT_CURSOR_KEY,
  AISPACE_NODE_COVER_PATH,
  AISPACE_NODE_CREATE_TIME_KEY,
  AISPACE_NODE_INFO,
  AISPACE_NODE_INFO_BODY,
  AISPACE_NODE_SIZE_KEY,
  AISPACE_QUERY,
  AISPACE_WALK_MAX_PAGES,
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

/**
 * 第 2 步翻页（2026-09-27 Finding C 修复）：读出**单页** node_info 响应里的关键事实。
 *
 * 实测响应形状：`data.children[]`（图文混排、最新在前，`key` = vid 或图片路径、
 * `id` = node id）+ `data.has_more` + `data.next_cursor`。请求体用 `cursor` 字段翻页。
 * children 不是数组（结构变了 / 错误响应）返回 null，由调用方记「children=缺失」。
 */
export interface NodeInfoPage {
  /** 本页条目（key / id 都转成字符串；站点的大整型 id 在 JSON 里本就是字符串） */
  children: Array<{
    key: string;
    id: string;
    createTime: number | null;
    size: number | null;
    cover: string | null;
  }>;
  /** 是否还有下一页 */
  hasMore: boolean;
  /** 下一页游标（仅 hasMore 时有值） */
  nextCursor: string | null;
}

export function readNodeInfoPage(nodeInfo: unknown): NodeInfoPage | null {
  const children = getPath(nodeInfo, ['data', 'children']);
  if (!Array.isArray(children)) return null;
  const list: NodeInfoPage['children'] = [];
  for (const child of children) {
    if (!isObject(child)) continue;
    if (child.key == null || child.id == null) continue;
    const node = child as Record<string, unknown>;
    list.push({
      key: String(child.key),
      id: String(child.id),
      /*
       * `create_time` = 作品真实生成时间（**秒级** Unix，2026-09-28 探针实测）。
       * 站点不给 / 结构变了就记 null（不编造）—— 排序时该条目排在末尾。
       */
      createTime: asNumber(node[AISPACE_NODE_CREATE_TIME_KEY]) ?? null,
      /*
       * `size` = 作品文件字节数（实测与下载到的原片**完全一致**）—— 视频的体积列就靠它，
       * 因为报文里 creation 的 video 对象与 download_infos 基本都不给 size（`docs/03` §12）。
       */
      size: asNumber(node[AISPACE_NODE_SIZE_KEY]) ?? null,
      /*
       * `node_cover.list_view.cover_url` = 站点自己的封面图（带签名）。
       * 链式报文的 `video_thumb` 缺失/过期时用它兜底当卡片缩略图（视频节点上是整帧封面）。
       */
      cover: asString(getPath(node, AISPACE_NODE_COVER_PATH)) ?? null,
    });
  }
  const rawHasMore = getPath(nodeInfo, ['data', AISPACE_HAS_MORE_KEY]);
  const hasMore = rawHasMore === true || rawHasMore === 'true';
  const nextCursor = asString(getPath(nodeInfo, ['data', AISPACE_NEXT_CURSOR_KEY]));
  return { children: list, hasMore, nextCursor: hasMore ? (nextCursor ?? null) : null };
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
  /**
   * 作品真实生成时间（**毫秒** epoch；2026-09-28 第十轮新增）。
   * 来源是创作树节点的 `create_time`（秒级）→ ×1000。资源库「最新/最早」按它排序。
   */
  createdAt?: number;
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

/** 步骤回调的封装签名（编排层内部使用） */
type StepEmit = (
  step: VidStepName,
  ok: boolean,
  startedAt: number,
  extra?: { status?: number; detail?: string },
) => void;

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
   * 同时也是「确定性负缓存」（原片已超期）的有效期。
   */
  ttlMs?: number;
  /**
   * 「我的创作」树索引的缓存有效期（毫秒），默认 `LIMITS.VID_INDEX_TTL_MS`。
   * 0 = 永久。索引只加速第 2 步，与原片地址的时效无关。
   */
  indexTtlMs?: number;
  /**
   * 「原片已超期」的二次确认窗口（毫秒），默认 `LIMITS.VID_EXPIRED_CONFIRM_MS`。
   * 首次「树里未见」只记录；窗口到点后重新全量扫描仍未见才判定超期。
   */
  expiredConfirmMs?: number;
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

/**
 * 一次 vid 解析的完整结论。
 *
 * `expired = true` 是**确定性结论**：已翻遍整棵「我的创作」树（`has_more=false`）仍未见到
 * 该 vid —— 站点对创作记录有保存期限，原片永远取不到，重试无意义。
 * `expired = false` 的失败只是「这次没成」（网络 / 超时 / 达翻页上限），仍然可重试。
 *
 * `pendingConfirm = true`：树里未见，但**还没走完二次确认窗口** —— 不下任何结论，
 * 调用方应在窗口后**再确认一次**。成因见 `LIMITS.VID_EXPIRED_CONFIRM_MS`：
 * 站点创作树对刚生成的视频有提交延迟，「一次未见」不等于「已超期」（实测 50 秒后即可见）。
 */
export interface VidResolveOutcome {
  url: string | null;
  expired: boolean;
  /** 树里未见且未到确认窗口 —— 保持「解析中」，稍后复查（不落任何确定性结论） */
  pendingConfirm: boolean;
}

export interface VidResolver {
  /** 解析 vid；成功返回原片 URL，失败返回 null（不缓存失败，允许重试） */
  resolve(vid: string, options?: VidResolveOptions): Promise<string | null>;
  /** 同 `resolve()`，但把「原片已超期」的确定性结论带给调用方 */
  resolveDetailed(vid: string, options?: VidResolveOptions): Promise<VidResolveOutcome>;
  /** 最近一次成功解析时第 3 步带出的元数据（未命中缓存返回 null） */
  metaOf(vid: string): VidMeta | null;
  /** 最近一次成功解析时顺带带回的**站点封面图**（未命中缓存／站点不给返回 null） */
  coverOf(vid: string): string | null;
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
  const indexTtlMs = options.indexTtlMs ?? LIMITS.VID_INDEX_TTL_MS;
  const expiredConfirmMs = options.expiredConfirmMs ?? LIMITS.VID_EXPIRED_CONFIRM_MS;
  const now = options.now ?? (() => Date.now());
  const onStep = options.onStep;

  /** vid → { url, meta, cover, at }；`at` 用于 TTL 判定 */
  const cache = new Map<string, { url: string; meta: VidMeta; cover: string | null; at: number }>();
  const pending = new Map<string, Promise<VidResolveOutcome>>();
  let running = 0;
  const waiting: Array<() => void> = [];

  /** 命中且未过期的缓存；过期的顺手删掉 */
  function freshCached(vid: string): { url: string; meta: VidMeta; cover: string | null } | null {
    const hit = cache.get(vid);
    if (!hit) return null;
    if (ttlMs > 0 && now() - hit.at >= ttlMs) {
      cache.delete(vid);
      return null;
    }
    return { url: hit.url, meta: hit.meta, cover: hit.cover };
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

  /* ----------------------------------------------------------------------- */
  /* 第 2 步：在「我的创作」树里找 vid（2026-09-27 Finding C 修复）              */
  /*                                                                         */
  /* 实测背景：创作树是**图文混排、最新在前**的分页列表，且站点对创作记录有       */
  /* 保存期限（2026-09-27 实测约三个月：6.23 可解析、5 月已清除）—— 过期 vid 已被清除，      */
  /* （确定性结论）；而树里**有的** vid 也可能排在第 1 页之外（上游与旧版都只     */
  /* 拉 size=50 的一页 → 大量误杀）。                                           */
  /* 对策：size=200 + cursor 有界翻页 + 索引短缓存 + head 校验；                 */
  /* 翻到底仍未见 → 负缓存 +「原片已超期」。                                     */
  /* ----------------------------------------------------------------------- */

  /** 一次翻页扫描的产物 */
  interface CreationIndex {
    /**
     * key(=vid) → { node id, 作品真实生成时间（秒级 Unix），文件体积（字节） }
     *
     * 顺带记这两项是 2026-09-28 第十轮加的：时间供排序与卡片标签（此前用 `lastSeen`，
     * 会把「刚被判超期」这种本地事件误当「最新」）；体积供「文件大小」显示
     * （报文里 creation 的 video 对象与 download_infos 都基本不给 size）。
     */
    map: Map<string, { id: string; createTime: number | null; size: number | null; cover: string | null }>;
    /** 去重后的条目数 / 页数（诊断用） */
    total: number;
    pages: number;
    /** 是否翻到了树底（has_more=false）。只有到底，「未见」才是确定性结论 */
    complete: boolean;
    /** 扫描时第 1 页首条的 key：新创作插在树的最前面，head 不变 = 树自扫描后未变 */
    headKey: string | null;
    at: number;
  }

  const indexes = new Map<string, CreationIndex>();
  /** 确定性负缓存：vid → 判定时间。TTL 与正缓存一致（到期后允许再确认一次） */
  const negatives = new Map<string, number>();
  /**
   * 「树里首次未见」的时刻：vid → at（2026-09-28 第十轮）。
   *
   * 首次未见**不下结论**，只在这里留一条记录；窗口（`expiredConfirmMs`）到点后
   * 重新全量扫描仍未见，才落负缓存 +「原片已超期」。
   * 任何一次命中 / 解析成功都会把它删掉（`forgetMiss`）。
   */
  const misses = new Map<string, number>();

  /** 该 vid 已有正证据（命中缓存 / 解析成功）→ 清掉「未见」记录与负缓存 */
  function forgetMiss(vid: string): void {
    misses.delete(vid);
    negatives.delete(vid);
  }

  function freshIndex(cid: string): CreationIndex | null {
    const hit = indexes.get(cid);
    if (!hit) return null;
    if (indexTtlMs > 0 && now() - hit.at >= indexTtlMs) {
      indexes.delete(cid);
      return null;
    }
    return hit;
  }

  function freshNegative(vid: string): boolean {
    const at = negatives.get(vid);
    if (at === undefined) return false;
    if (ttlMs > 0 && now() - at >= ttlMs) {
      negatives.delete(vid);
      return false;
    }
    return true;
  }

  /** 翻页扫描整棵创作树，建 key→{node_id, create_time} 索引。网络错误原样抛出（由调用方翻译成人话）。 */
  async function walkCreationTree(
    cid: string,
  ): Promise<{ index: CreationIndex; lastPage: unknown; structureError: boolean }> {
    const map: CreationIndex['map'] = new Map();
    let cursor: string | undefined;
    let pages = 0;
    let complete = false;
    let headKey: string | null = null;
    let lastPage: unknown;
    let structureError = false;

    while (pages < AISPACE_WALK_MAX_PAGES) {
      lastPage = await postJson(AISPACE_NODE_INFO, AISPACE_NODE_INFO_BODY(cid, cursor));
      const page = readNodeInfoPage(lastPage);
      if (!page) {
        // children 不是数组（结构变了 / 错误响应）：按已有内容收场，不下确定性结论
        structureError = pages === 0;
        break;
      }
      if (pages === 0) headKey = page.children[0]?.key ?? null;
      for (const entry of page.children) {
        if (!map.has(entry.key)) {
          map.set(entry.key, {
            id: entry.id,
            createTime: entry.createTime,
            size: entry.size,
            cover: entry.cover,
          });
        }
      }
      pages++;
      if (!page.hasMore || page.nextCursor == null) {
        complete = true;
        break;
      }
      cursor = page.nextCursor;
    }

    return { index: { map, total: map.size, pages, complete, headKey, at: now() }, lastPage, structureError };
  }

  function emitDefinitiveMiss(
    emit: StepEmit,
    vid: string,
    startedAt: number,
    info: { total: number; pages: number; lastPage: unknown },
  ): void {
    emit('node_info', false, startedAt, {
      detail:
        `没有 key=${vid} 的条目（${describeVidPayload(info.lastPage, 'children')}；` +
        `全树 ${info.total} 条/${info.pages} 页已到底，二次确认仍未见 → 原片已超期）`,
    });
  }

  /** 第 2 步的查找结论 */
  type NodeLookup = {
    nodeId: string | null;
    /** 命中时顺带带回的作品真实生成时间（秒级 Unix，站点不给则 null） */
    createTime: number | null;
    /** 命中时顺带带回的文件体积（字节，站点不给则 null） */
    size: number | null;
    /** 命中时顺带带回的站点封面图（带签名；站点不给则 null） */
    cover: string | null;
    /** 确定性超期（已走完二次确认窗口，重扫仍未见） */
    expired: boolean;
    /** 树里未见但未到确认窗口 —— 不下结论，调用方稍后复查 */
    pendingConfirm: boolean;
  };

  /** 不发任何确定性结论（网络失败 / 结构变化 / 未到底 / 未到确认窗口） */
  const NO_VERDICT: NodeLookup = {
    nodeId: null,
    createTime: null,
    size: null,
    cover: null,
    expired: false,
    pendingConfirm: false,
  };

  /**
   * 「树里未见」的统一处置（2026-09-28 第十轮：二次确认窗口）。
   *
   * 站点创作树对**刚生成的视频有提交延迟**：实测生成完成消息到达后 0.5s 查树「翻到底未见」，
   * 50s 后同一个查询就能查到（树 148 → 149 条）。所以「一次未见」不足以判定超期：
   *   · 窗口内的首次未见 → 只记录，返回 `pendingConfirm`（界面保持「解析中」，稍后复查）；
   *   · 窗口到点后（调用方会重新扫一棵新鲜的树）仍未见 → 才落负缓存 +「原片已超期」。
   */
  function concludeMiss(
    vid: string,
    startedAt: number,
    emit: StepEmit,
    info: { total: number; pages: number; lastPage: unknown },
  ): NodeLookup {
    const waitSec = Math.round(expiredConfirmMs / 1000);
    const head = `没有 key=${vid} 的条目（${describeVidPayload(info.lastPage, 'children')}；全树 ${info.total} 条/${info.pages} 页已到底）`;
    const firstAt = misses.get(vid);
    if (firstAt === undefined) {
      misses.set(vid, now());
      emit('node_info', false, startedAt, { detail: `${head} —— 首次未见，${waitSec}s 后复查仍未见才判定超期` });
      return { nodeId: null, createTime: null, size: null, cover: null, expired: false, pendingConfirm: true };
    }
    const elapsed = now() - firstAt;
    if (elapsed < expiredConfirmMs) {
      emit('node_info', false, startedAt, {
        detail: `${head} —— 距首次未见 ${(elapsed / 1000).toFixed(1)}s < ${waitSec}s，暂不定论`,
      });
      return { nodeId: null, createTime: null, size: null, cover: null, expired: false, pendingConfirm: true };
    }
    misses.delete(vid);
    negatives.set(vid, now());
    emitDefinitiveMiss(emit, vid, startedAt, info);
    return { nodeId: null, createTime: null, size: null, cover: null, expired: true, pendingConfirm: false };
  }

  /**
   * 第 2 步本体。所有 node_info 事件都从这里发出；网络错误被翻译成 `node_info` 失败事件，
   * 不向上抛（与旧行为一致：解析失败返回 null，不让调用方接异常）。
   */
  async function findNodeForVid(
    cid: string,
    vid: string,
    force: boolean,
    startedAt: number,
    emit: StepEmit,
  ): Promise<NodeLookup> {
    /*
     * 本次是不是「窗口到点后的复查」？复查一律重新扫一棵新鲜的树（不吃索引缓存）——
     * 因为要确认的正是「树长出来了吗」，拿旧索引回答等于没复查。
     */
    const firstAt = misses.get(vid);
    const confirming = firstAt !== undefined && now() - firstAt >= expiredConfirmMs;

    // 命中新鲜索引 → 直接查（一次扫描服务多个 vid，不重复翻树）
    const cached = force || confirming ? null : freshIndex(cid);
    if (cached) {
      const hit = cached.map.get(vid);
      if (hit) {
        forgetMiss(vid);
        emit('node_info', true, startedAt, {
          detail: `node id=${hit.id}（命中索引 ${cached.total} 条/${cached.pages} 页）`,
        });
        return { nodeId: hit.id, createTime: hit.createTime, size: hit.size, cover: hit.cover, expired: false, pendingConfirm: false };
      }
      if (cached.complete) {
        /*
         * 索引新鲜且已翻到底但仍未见 —— 先做 **head 校验**：新创作会插到树的最前面，
         * 第 1 页首条 key 没变 = 树自扫描后没变过 → 可以立刻按「未见」处置（首次只记录）；
         * head 变了 → 树有更新，落到下面的全量扫描拿一棵新鲜的树。
         */
        let headRaw: unknown;
        try {
          headRaw = await postJson(AISPACE_NODE_INFO, AISPACE_NODE_INFO_BODY(cid));
        } catch (error) {
          emit('node_info', false, startedAt, {
            detail: `head 校验未完成（${describeVidError(error, timeoutMs).detail}），暂不定论`,
          });
          return NO_VERDICT;
        }
        const head = readNodeInfoPage(headRaw);
        if (head && (head.children[0]?.key ?? null) === cached.headKey) {
          return concludeMiss(vid, startedAt, emit, {
            total: cached.total,
            pages: cached.pages,
            lastPage: headRaw,
          });
        }
        // head 变了 → 树有更新，走下面的全量扫描
      } else {
        // 上次扫描没到底（达页上限）→ 不能下确定性结论
        emit('node_info', false, startedAt, {
          detail: `没有 key=${vid} 的条目（索引 ${cached.total} 条/${cached.pages} 页未到底，暂不定论）`,
        });
        return NO_VERDICT;
      }
    }

    let walk: Awaited<ReturnType<typeof walkCreationTree>>;
    try {
      walk = await walkCreationTree(cid);
    } catch (error) {
      emit('node_info', false, startedAt, describeVidError(error, timeoutMs));
      return NO_VERDICT;
    }
    if (!walk.structureError) indexes.set(cid, walk.index);

    const hit = walk.index.map.get(vid);
    if (hit) {
      forgetMiss(vid);
      emit('node_info', true, startedAt, {
        detail: `node id=${hit.id}（${walk.index.total} 条/${walk.index.pages} 页${walk.index.complete ? '' : '，未到底'}）`,
      });
      return { nodeId: hit.id, createTime: hit.createTime, size: hit.size, cover: hit.cover, expired: false, pendingConfirm: false };
    }
    if (walk.structureError) {
      emit('node_info', false, startedAt, {
        detail: `没有 key=${vid} 的条目（${describeVidPayload(walk.lastPage, 'children')}）`,
      });
      return NO_VERDICT;
    }
    if (walk.index.complete) {
      return concludeMiss(vid, startedAt, emit, {
        total: walk.index.total,
        pages: walk.index.pages,
        lastPage: walk.lastPage,
      });
    }
    emit('node_info', false, startedAt, {
      detail: `没有 key=${vid} 的条目（${walk.index.total} 条/${walk.index.pages} 页达翻页上限，暂不定论）`,
    });
    return NO_VERDICT;
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
  async function runThreeSteps(
    vid: string,
    force: boolean,
  ): Promise<VidResolveOutcome & { meta: VidMeta; cover?: string | null }> {
    const emit: StepEmit = (step, ok, startedAt, extra = {}) => {
      onStep?.({ vid, step, ok, ms: Math.max(0, now() - startedAt), ...extra });
    };

    // ---- 第 1 步：找「我的创作」这个根节点的 id ----
    let startedAt = now();
    let homepage: unknown;
    try {
      homepage = await postJson(AISPACE_HOMEPAGE, {});
    } catch (error) {
      emit('homepage', false, startedAt, describeVidError(error, timeoutMs));
      return { url: null, expired: false, pendingConfirm: false, meta: {} };
    }
    const cid = findCreationId(homepage);
    if (!cid) {
      emit('homepage', false, startedAt, { detail: `没有「我的创作」条目（${describeVidPayload(homepage, 'children')}）` });
      return { url: null, expired: false, pendingConfirm: false, meta: {} };
    }
    emit('homepage', true, startedAt, { detail: `创作 id=${cid}` });

    // ---- 第 2 步：按 vid 找该视频的 node id（有界翻页 + 索引缓存 + 二次确认，2026-09-27/28） ----
    startedAt = now();
    const lookup = await findNodeForVid(cid, vid, force, startedAt, emit);
    if (!lookup.nodeId) {
      return {
        url: null,
        expired: lookup.expired,
        pendingConfirm: lookup.pendingConfirm,
        meta: {},
      };
    }
    // ---- 第 3 步：取无水印原片地址 ----
    startedAt = now();
    let downloadInfo: unknown;
    try {
      downloadInfo = await postJson(AISPACE_GET_DOWNLOAD_INFO, AISPACE_DOWNLOAD_INFO_BODY(lookup.nodeId));
    } catch (error) {
      emit('get_download_info', false, startedAt, describeVidError(error, timeoutMs));
      return { url: null, expired: false, pendingConfirm: false, meta: {} };
    }
    const url = findDownloadUrl(downloadInfo);
    if (!url) {
      emit('get_download_info', false, startedAt, {
        detail: `没有可用的 main_url（${describeVidPayload(downloadInfo, 'download_infos')}）`,
      });
      return { url: null, expired: false, pendingConfirm: false, meta: {} };
    }
    emit('get_download_info', true, startedAt, { detail: describeVidPayload(downloadInfo, 'download_infos') });
    /*
     * 元数据随解析一起带回（2026-09-28 第十轮）：
     *   · `size` —— **创作树节点的 `size`**（实测与下载到的原片字节数完全一致）。
     *     报文里 creation 的 video 对象与 `download_infos` 实测基本都不给 size，
     *     所以视频的「文件大小」过去一直显示不出来；这里优先用 download_infos 给的，
     *     没有才用节点值（两者本就指同一个文件）。
     *   · `createdAt` —— 创作树节点的 `create_time`（秒级 → 毫秒）。
     *     ⚠️ 它只是**兜底**：优先用的是消息自带的 `create_time`（`MESSAGE_CREATE_TIME_KEY`），
     *     创作树只保留约三个月，且图片根本不走这条路。
     */
    const meta = findDownloadMeta(downloadInfo);
    if (meta.size === undefined && lookup.size !== null) meta.size = lookup.size;
    const createdMs = siteTimeToMs(lookup.createTime);
    if (createdMs !== undefined) meta.createdAt = createdMs;
    /*
     * `cover` —— 站点自己的封面图（带签名）。只在链式报文没给缩略图时当兜底
     * （`page/hook.ts::enrichWithResolvedVid` 用 `coverOf()` 取）。
     */
    return { url, expired: false, pendingConfirm: false, meta, cover: lookup.cover };
  }

  async function resolveInternal(vid: string, resolveOptions: VidResolveOptions = {}): Promise<VidResolveOutcome> {
    const none: VidResolveOutcome = { url: null, expired: false, pendingConfirm: false };
    if (!vid) return none;

    if (resolveOptions.force) {
      // force = 「换一份新签名」的主动重解析：一并作废负缓存与「首次未见」记录，
      // 让这次结果重新参与二次确认（不把旧的否定结论套在新证据上）
      cache.delete(vid);
      forgetMiss(vid);
    } else {
      const cached = freshCached(vid);
      if (cached) {
        // 拿到过原片 = 正证据 → 旧的「未见/超期」结论一律作废（站点创作树曾延迟的情况）
        forgetMiss(vid);
        return { url: cached.url, expired: false, pendingConfirm: false };
      }
      // 「原片已超期」是二次确认后的确定性结论：TTL 内不再重试（到期后允许再确认一次）
      if (freshNegative(vid)) return { url: null, expired: true, pendingConfirm: false };
    }

    // 已有同一 vid 的在飞请求 → 复用它（在飞结果一定是新鲜的，不必重复发）
    const existing = pending.get(vid);
    if (existing) return existing;

    const force = resolveOptions.force === true;
    const task = (async (): Promise<VidResolveOutcome> => {
      await acquire();
      try {
        const outcome = await runThreeSteps(vid, force);
        if (outcome.url) {
          cache.set(vid, { url: outcome.url, meta: outcome.meta, cover: outcome.cover ?? null, at: now() });
          forgetMiss(vid);
        }
        return { url: outcome.url, expired: outcome.expired, pendingConfirm: outcome.pendingConfirm };
      } catch (error) {
        console.debug('[UWD] vid 解析失败', vid, error);
        return none;
      } finally {
        release();
        pending.delete(vid);
      }
    })();

    pending.set(vid, task);
    return task;
  }

  return {
    resolve: async (vid, options) => (await resolveInternal(vid, options)).url,
    resolveDetailed: resolveInternal,
    metaOf: (vid: string) => freshCached(vid)?.meta ?? null,
    coverOf: (vid: string) => freshCached(vid)?.cover ?? null,
    has: (vid: string) => freshCached(vid) !== null,
    clear: () => {
      cache.clear();
      indexes.clear();
      negatives.clear();
      misses.clear();
    },
    get inflight() {
      return pending.size;
    },
  };
}
