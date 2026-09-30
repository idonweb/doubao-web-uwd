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
  AISPACE_NODE_HEIGHT_PATH,
  AISPACE_NODE_INFO,
  AISPACE_NODE_INFO_BODY,
  AISPACE_NODE_SIZE_KEY,
  AISPACE_NODE_WIDTH_PATH,
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
    /** 视频节点的原片真实帧宽高（`node_cover.list_view`；站点不给 / 图片节点形态 → null） */
    width: number | null;
    height: number | null;
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
      /*
       * `node_cover.list_view.image_width / image_height` = 视频节点的**原片真实帧宽高**
       * （2026-09-28 第十二轮探针 37 条样本证实，含 1470×630 超宽幅）。
       * 报文里 video 对象的宽高是 384×216 预览规格、download_infos 基本不给 ——
       * 树节点的这个字段是卡片真实宽高与清晰度标签的来源。⚠️ 图片节点上是缩略图尺寸，
       * 不能用于图片；本路径只有视频会走，天然无碍。
       */
      width: asNumber(getPath(node, AISPACE_NODE_WIDTH_PATH)) ?? null,
      height: asNumber(getPath(node, AISPACE_NODE_HEIGHT_PATH)) ?? null,
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
  /**
   * 「新作品入库窗口」（毫秒），默认 `LIMITS.VID_FRESH_RESOURCE_MS`。
   *
   * 资源**自身的生成时间**（调用方通过 `resourceAt` 传入）距今不足这个时长时，
   * 「树里翻到底没有它」**不下超期结论** —— 刚生成的作品缺树只可能是站点入库延迟（§33）。
   * `0` = 关掉闸门（旧行为：只看 `expiredConfirmMs`）。
   */
  freshResourceMs?: number;
  /**
   * 网络层失败后的重试冷却（毫秒），默认 `LIMITS.VID_RETRY_COOLDOWN_MS`。
   * 0 = 不冷却。冷却期内 `resolve()` 直接短路不发请求（`force: true` 不受限）。
   */
  retryCooldownMs?: number;  /** 便于注入时钟（单测用） */
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
  /**
   * 标记本次是「确认窗口的**既定复查**」（2026-09-28 §26 补正）。
   * 复查允许绕过失败冷却 —— 否则新视频会因「创作树提交延迟 + 一次性复查被冷却吞掉」
   * 长时间停在「解析中」。chain 重放**不得**带此标记（否则冷却失效、死循环回潮）。
   */
  confirmation?: boolean;
  /**
   * 该资源**自身的生成时刻**（毫秒 epoch），来自所在消息的 `create_time`（见踩坑 19）。
   *
   * 用来判「这还是一部刚生成的作品吗」：刚生成的作品缺树是**站点入库延迟**，
   * 不下任何结论（§33）；不新了才可能是「超出约三个月保存期」。
   * 不传 = 年龄未知 → 保持旧行为（只看 `expiredConfirmMs`）。
   */
  resourceAt?: number;
}

/**
 * 一次 vid 解析的完整结论。
 *
 * `expired = true` 是**确定性结论**：已翻遍整棵「我的创作」树（`has_more=false`）仍未见到
 * 该 vid —— 站点对创作记录有保存期限，原片永远取不到，重试无意义。
 * `expired = false` 的失败只是「这次没成」（网络 / 超时 / 达翻页上限），仍然可重试。
 *
 * `pendingConfirm = true`：树里未见，但**还没走完二次确认窗口**（或资源仍是「新作品」，见
 * `LIMITS.VID_FRESH_RESOURCE_MS`）—— 不下任何结论，调用方应稍后**再确认一次**。
 * 成因见 `LIMITS.VID_EXPIRED_CONFIRM_MS`：站点创作树对刚生成的视频有提交延迟，
 * 「一次未见」不等于「已超期」（实测 50 秒后即可见，§33 样本 >100 秒）。
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
  /**
   * 该 vid 的失败冷却剩余毫秒数（2026-09-28 第十二轮）。
   * null = 不在冷却期；> 0 = 冷却中（`resolve()` 会短路不发请求，直到冷却结束）。
   * 供诊断层区分「网络失败退避中」与「真的什么都没发生」。
   */
  cooldownOf(vid: string): number | null;
}

export function createVidResolver(options: VidResolverOptions = {}): VidResolver {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? LIMITS.VID_RESOLVE_TIMEOUT_MS;
  const maxConcurrency = Math.max(1, options.concurrency ?? 2);
  const ttlMs = options.ttlMs ?? LIMITS.VID_RESOLVE_TTL_MS;
  const indexTtlMs = options.indexTtlMs ?? LIMITS.VID_INDEX_TTL_MS;
  const expiredConfirmMs = options.expiredConfirmMs ?? LIMITS.VID_EXPIRED_CONFIRM_MS;
  const freshResourceMs = options.freshResourceMs ?? LIMITS.VID_FRESH_RESOURCE_MS;
  const retryCooldownMs = options.retryCooldownMs ?? LIMITS.VID_RETRY_COOLDOWN_MS;
  const now = options.now ?? (() => Date.now());
  const onStep = options.onStep;

  /*
   * 资源是否仍在「新作品入库窗口」内（§33）—— 见 `LIMITS.VID_FRESH_RESOURCE_MS`：
   * 刚生成的作品缺树 = 站点入库延迟，既不下超期结论，也不做昂贵的轮次翻树。
   * 生成时间未知（`resourceAt` 缺省 / 站点没给消息 `create_time`）→ 闸门不生效，保持旧行为。
   */
  function isFreshResource(resourceAt?: number): boolean {
    if (freshResourceMs <= 0 || resourceAt === undefined) return false;
    return now() - resourceAt < freshResourceMs;
  }

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
     * key(=vid) → { node id, 作品真实生成时间（秒级 Unix），文件体积（字节），真实帧宽高 }
     *
     * 顺带记这三项：时间是 2026-09-28 第十轮加的（供排序与卡片标签，此前用 `lastSeen`，
     * 会把「刚被判超期」这种本地事件误当「最新」）；体积供「文件大小」显示；
     * 宽高是第十二轮加的（供卡片真实宽高与清晰度标签，取代 384×216 预览规格）——
     * 报文里 creation 的 video 对象与 download_infos 都基本不给 size / 真实宽高。
     */
    map: Map<
      string,
      {
        id: string;
        createTime: number | null;
        size: number | null;
        cover: string | null;
        width: number | null;
        height: number | null;
      }
    >;
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
  /**
   * 翻树的**在飞共享**（2026-09-28 第十二轮 §23.5）：cid → 正在进行的翻树 Promise。
   *
   * 一次翻树 = 8 页请求；并发解析多个 vid 时（同一棵账号级树），不共享就会把 8 页 × N
   * 同时打出去 —— 实测这正是触发站点软限流（200 + 空响应体）的请求来源。
   * 单飞后 N 个 vid 共享同一次翻树；结束（成功或失败）即从表里移除，
   * 成功的结果落在 `indexes`，失败则允许下一个调用方重新发起。
   */
  const walks = new Map<string, Promise<Awaited<ReturnType<typeof walkCreationTree>>>>();
  /** 失败冷却：vid → 冷却到期时刻（§23.5，见 `LIMITS.VID_RETRY_COOLDOWN_MS`） */
  const cooldowns = new Map<string, number>();
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

  /**
   * 新鲜索引（TTL 内）。⚠️ 过期的索引**不从表里删除**（只返回 null）——
   * 它还是「翻树失败后的降级数据源」（§23.5：旧索引也比重新翻 8 页强）；
   * 真正的清理由下一次成功的翻树覆盖或 `clear()` 完成。
   */
  function freshIndex(cid: string): CreationIndex | null {
    const hit = indexes.get(cid);
    if (!hit) return null;
    if (indexTtlMs > 0 && now() - hit.at >= indexTtlMs) return null;
    return hit;
  }

  /**
   * 翻树的单飞入口：同一 cid 已有在飞翻树就直接共享它的结果（§23.5）。
   * 成功 → 结果进 `indexes`（由 `walkCreationTree` 的调用方写入，见 `findNodeForVid`）；
   * 失败 → 从表里移除，让下一个调用方可以重新发起（不把失败缓存住）。
   */
  function walkCreationTreeShared(
    cid: string,
  ): Promise<Awaited<ReturnType<typeof walkCreationTree>>> {
    const existing = walks.get(cid);
    if (existing) return existing;
    const task = walkCreationTree(cid).finally(() => {
      walks.delete(cid);
    });
    walks.set(cid, task);
    return task;
  }

  /** 该 vid 是否在失败冷却期内（返回剩余毫秒；不在则 null） */
  function coolingDown(vid: string): number | null {
    const until = cooldowns.get(vid);
    if (until === undefined) return null;
    const remaining = until - now();
    if (remaining <= 0) {
      cooldowns.delete(vid);
      return null;
    }
    return remaining;
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
            width: entry.width,
            height: entry.height,
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
    ageMs?: number,
  ): void {
    emit('node_info', false, startedAt, {
      detail:
        `没有 key=${vid} 的条目（${describeVidPayload(info.lastPage, 'children')}；` +
        `全树 ${info.total} 条/${info.pages} 页已到底，二次确认仍未见 → 原片已超期` +
        `${ageMs === undefined ? '；作品生成时间未知' : `；该作品生成于 ${(ageMs / 60_000).toFixed(1)}min 前，已过入库窗口`}）`,
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
    /** 命中时顺带带回的原片真实帧宽高（`node_cover.list_view`；站点不给则 null） */
    width: number | null;
    height: number | null;
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
    width: null,
    height: null,
    expired: false,
    pendingConfirm: false,
  };

  /**
   * 「树里未见」的统一处置（2026-09-28 第十轮：二次确认窗口；2026-09-29 §33：年龄闸门）。
   *
   * 站点创作树对**刚生成的视频有提交延迟**：实测生成完成消息到达后 0.5s 查树「翻到底未见」，
   * 50s 后同一个查询就能查到（树 148 → 149 条）；§33 的实机样本更极端 —— 21:38:27 生成、
   * 21:38:51 就「翻到底未见」满两次，而到 21:40:07 树条目数仍纹丝不动（还是 152 条）。
   * 所以「一次未见」不足以判定超期，「等够时间再未见」也不够 —— 延迟本身没有上界，
   * 唯一可靠的区分信号是**这部作品还新不新**：
   *   · 窗口（`expiredConfirmMs`）内的首次未见 → 只记录，返回 `pendingConfirm`（界面保持「解析中」）；
   *   · 窗口到点后仍未见，但**资源本身还在「新作品入库窗口」内**（`VID_FRESH_RESOURCE_MS`，
   *     依据消息 `create_time`）→ 仍不下结论：刚生成的作品缺树 = 站点入库延迟，返回 `pendingConfirm`；
   *   · 窗口到点后仍未见**且资源已经不新** → 才落负缓存 +「原片已超期」。
   */
  function concludeMiss(
    vid: string,
    startedAt: number,
    emit: StepEmit,
    info: { total: number; pages: number; lastPage: unknown },
    resourceAt?: number,
  ): NodeLookup {
    const waitSec = Math.round(expiredConfirmMs / 1000);
    const head = `没有 key=${vid} 的条目（${describeVidPayload(info.lastPage, 'children')}；全树 ${info.total} 条/${info.pages} 页已到底）`;
    const firstAt = misses.get(vid);
    if (firstAt === undefined) {
      misses.set(vid, now());
      emit('node_info', false, startedAt, { detail: `${head} —— 首次未见（新作品等待站点入库），将轮次式重扫；${waitSec}s 仍未见才判定超期` });
      return { nodeId: null, createTime: null, size: null, cover: null, width: null, height: null, expired: false, pendingConfirm: true };
    }
    const elapsed = now() - firstAt;
    if (elapsed < expiredConfirmMs) {
      emit('node_info', false, startedAt, {
        detail: `${head} —— 距首次未见 ${(elapsed / 1000).toFixed(1)}s < ${waitSec}s，暂不定论`,
      });
      return { nodeId: null, createTime: null, size: null, cover: null, width: null, height: null, expired: false, pendingConfirm: true };
    }
    /*
     * 年龄闸门（2026-09-29 §33）：窗口到了，但这部作品**刚生成**（消息 create_time 在
     * `VID_FRESH_RESOURCE_MS` 内）—— 此刻缺树只说明站点还没把它登记进「我的创作」，
     * 不是「超出保存期」。此时既不下超期结论、也不落负缓存，继续保持「解析中」等待，
     * 由调用方的轮次重扫 / chain 重放自然接续（树一长出来立刻转 raw）。
     */
    const ageMs = resourceAt === undefined ? undefined : now() - resourceAt;
    if (ageMs !== undefined && freshResourceMs > 0 && ageMs < freshResourceMs) {
      emit('node_info', false, startedAt, {
        detail:
          `${head} —— 距首次未见 ${(elapsed / 1000).toFixed(1)}s，但该作品生成于 ${(ageMs / 60_000).toFixed(1)}min 前` +
          `（< ${(freshResourceMs / 60_000).toFixed(0)}min 入库窗口）→ 判定为**站点登记延迟**，不下超期结论`,
      });
      return { nodeId: null, createTime: null, size: null, cover: null, width: null, height: null, expired: false, pendingConfirm: true };
    }
    misses.delete(vid);
    negatives.set(vid, now());
    emitDefinitiveMiss(emit, vid, startedAt, info, ageMs);
    return { nodeId: null, createTime: null, size: null, cover: null, width: null, height: null, expired: true, pendingConfirm: false };
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
    resourceAt?: number,
  ): Promise<NodeLookup> {
    /*
     * 本次是不是「窗口到点后的复查」？复查一律重新扫一棵新鲜的树（不吃索引缓存）——
     * 因为要确认的正是「树长出来了吗」，拿旧索引回答等于没复查。
     *
     * ⚠️ 例外（2026-09-29 §33）：资源本身还在「新作品入库窗口」内时**不**做这件事 ——
     * 那种情况下我们已经知道结论必然是「继续等」（见 `concludeMiss` 的年龄闸门），
     * 若还每轮完整翻树，就会把等待期（可达分钟级）变成持续的翻页请求。
     * 此时退回**廉价路径**：吃索引 + 一次 head 校验（1 个请求）；head 变了（树长高了）
     * 才会落到下面的全量扫描 —— 而索引本身 5min 过期，兜底也不会漏掉中间插入的新条目。
     */
    const firstAt = misses.get(vid);
    const confirming =
      firstAt !== undefined && now() - firstAt >= expiredConfirmMs && !isFreshResource(resourceAt);

    // 命中新鲜索引 → 直接查（一次扫描服务多个 vid，不重复翻树）
    const cached = force || confirming ? null : freshIndex(cid);
    if (cached) {
      const hit = cached.map.get(vid);
      if (hit) {
        forgetMiss(vid);
        emit('node_info', true, startedAt, {
          detail: `node id=${hit.id}（命中索引 ${cached.total} 条/${cached.pages} 页）`,
        });
        return { nodeId: hit.id, createTime: hit.createTime, size: hit.size, cover: hit.cover, width: hit.width, height: hit.height, expired: false, pendingConfirm: false };
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
          }, resourceAt);
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
      walk = await walkCreationTreeShared(cid);
    } catch (error) {
      emit('node_info', false, startedAt, describeVidError(error, timeoutMs));
      /*
       * 降级（2026-09-28 第十二轮 §23.5）：翻树失败时，先看手里有没有**过期索引** ——
       * 站点此刻多半在软限流，重新翻 8 页大概率还是失败，还会把限流喂得更久。
       * 旧索引只用于**正命中**（vid 在里面就接着走第 3 步）；索引里没有则不下任何结论
       * （树可能早已长出新条目，过期索引的「未见」不可信），保持可重试的 pending。
       */
      const stale = indexes.get(cid);
      if (stale) {
        const hit = stale.map.get(vid);
        if (hit) {
          forgetMiss(vid);
          emit('node_info', true, startedAt, {
            detail: `node id=${hit.id}（翻树失败，降级命中过期索引 ${stale.total} 条/${stale.pages} 页）`,
          });
          return { nodeId: hit.id, createTime: hit.createTime, size: hit.size, cover: hit.cover, width: hit.width, height: hit.height, expired: false, pendingConfirm: false };
        }
      }
      return NO_VERDICT;
    }
    if (!walk.structureError) indexes.set(cid, walk.index);

    const hit = walk.index.map.get(vid);
    if (hit) {
      forgetMiss(vid);
      emit('node_info', true, startedAt, {
        detail: `node id=${hit.id}（${walk.index.total} 条/${walk.index.pages} 页${walk.index.complete ? '' : '，未到底'}）`,
      });
      return { nodeId: hit.id, createTime: hit.createTime, size: hit.size, cover: hit.cover, width: hit.width, height: hit.height, expired: false, pendingConfirm: false };
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
      }, resourceAt);
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
    resourceAt?: number,
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
    const lookup = await findNodeForVid(cid, vid, force, startedAt, emit, resourceAt);
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
     * 元数据随解析一起带回（2026-09-28 第十/十二轮）：
     *   · `size` —— **创作树节点的 `size`**（实测与下载到的原片字节数完全一致）。
     *     报文里 creation 的 video 对象与 `download_infos` 实测基本都不给 size，
     *     所以视频的「文件大小」过去一直显示不出来；这里优先用 download_infos 给的，
     *     没有才用节点值（两者本就指同一个文件）。
     *   · `width` / `height` —— **创作树节点的 `node_cover.list_view` 宽高**
     *     （第十二轮探针 37 条样本证实 = 原片真实帧尺寸，含 1470×630 超宽幅）。
     *     报文里 video 对象的 384×216 是预览规格、download_infos 基本不给 —— 这里同样
     *     「download_infos 优先、节点兜底」；两处都没有就不写（卡片维持预览规格，不编造）。
     *   · `createdAt` —— 创作树节点的 `create_time`（秒级 → 毫秒）。
     *     ⚠️ 它只是**兜底**：优先用的是消息自带的 `create_time`（`MESSAGE_CREATE_TIME_KEY`），
     *     创作树只保留约三个月，且图片根本不走这条路。
     */
    const meta = findDownloadMeta(downloadInfo);
    if (meta.size === undefined && lookup.size !== null) meta.size = lookup.size;
    if (meta.width === undefined && lookup.width !== null) {
      meta.width = lookup.width;
      meta.height = lookup.height ?? undefined;
    }
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
      // force = 「换一份新签名」的主动重解析：一并作废负缓存、「首次未见」记录与失败冷却，
      // 让这次结果重新参与判定（不把旧的否定结论套在新证据上）
      cache.delete(vid);
      forgetMiss(vid);
      cooldowns.delete(vid);
    } else {
      const cached = freshCached(vid);
      if (cached) {
        // 拿到过原片 = 正证据 → 旧的「未见/超期/失败冷却」结论一律作废
        forgetMiss(vid);
        cooldowns.delete(vid);
        return { url: cached.url, expired: false, pendingConfirm: false };
      }
      // 「原片已超期」是二次确认后的确定性结论：TTL 内不再重试（到期后允许再确认一次）
      if (freshNegative(vid)) return { url: null, expired: true, pendingConfirm: false };
      /*
       * 失败冷却（2026-09-28 第十二轮 §24）：网络层失败（软限流 / 超时 / 断连）后
       * 冷却期内直接短路 —— chain 每 ~60s 重放都会重新触发解析，若不冷却就会
       * 「重试 → 重翻 8 页树 → 仍被限流」地死循环。冷却结束后的下一次重放自然恢复。
       *
       * ⚠️ 例外（2026-09-28 §26 补正）：`confirmation: true` = 30s 确认窗口的**既定复查**
       * （由 `scheduleExpiredRecheck` 发起），不受冷却限制 —— 否则新视频会因
       * 「创作树提交延迟 + 复查被冷却吞掉」长时间停在「解析中」。
       */
      if (!resolveOptions.confirmation && coolingDown(vid) !== null) return none;
    }

    // 已有同一 vid 的在飞请求 → 复用它（在飞结果一定是新鲜的，不必重复发）
    const existing = pending.get(vid);
    if (existing) return existing;

    const force = resolveOptions.force === true;
    const task = (async (): Promise<VidResolveOutcome> => {
      await acquire();
      try {
        const outcome = await runThreeSteps(vid, force, resolveOptions.resourceAt);
        if (outcome.url) {
          cache.set(vid, { url: outcome.url, meta: outcome.meta, cover: outcome.cover ?? null, at: now() });
          forgetMiss(vid);
          cooldowns.delete(vid);
        } else if (!outcome.expired && !outcome.pendingConfirm) {
          /*
           * 「不下结论」的失败（网络层 / 超时 / 结构变化）→ 进入冷却（§23.5）：
           * 界面保持「解析中」，但冷却期内不再对站点发任何请求，
           * 避免把软限流喂成持续状态。超期 / 待复查路径有自己的结论语义，不走这里。
           */
          if (retryCooldownMs > 0) cooldowns.set(vid, now() + retryCooldownMs);
        }
        return { url: outcome.url, expired: outcome.expired, pendingConfirm: outcome.pendingConfirm };
      } catch (error) {
        console.debug('[UWD] vid 解析失败', vid, error);
        if (retryCooldownMs > 0) cooldowns.set(vid, now() + retryCooldownMs);
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
    cooldownOf: (vid: string) => coolingDown(vid),
    clear: () => {
      cache.clear();
      indexes.clear();
      negatives.clear();
      misses.clear();
      cooldowns.clear();
    },
    get inflight() {
      return pending.size;
    },
  };
}
