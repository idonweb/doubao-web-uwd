/**
 * 诊断记录（真机联调用）—— 纯函数，配单测。
 *
 * 存在意义：站点改版时，「解析不到资源」可能出在四个环节中的任何一个 ——
 * hook 没装上 / 接口路径变了 / 字段结构变了 / 落库被过滤了。
 * 只靠肉眼翻 DevTools 无法区分，于是把每个环节的关键事实**结构化记录下来**，
 * 由 `ui/debug/` 页面一键导出。
 *
 * 设计约束：
 *   - 有界（条数 + 字节数双上限），超出从最旧的丢 —— 绝不因为诊断把存储撑爆；
 *   - 原始文本只留**采样窗口**（不是全量），够还原结构即可；
 *   - 与业务逻辑完全解耦：任何时候删掉 diagnostics 都不影响插件功能。
 */

import { LIMITS } from './constants';

export type DiagLevel = 'info' | 'warn' | 'error';
export type DiagSource = 'page' | 'content' | 'bg' | 'ui';

export interface DiagRecord {
  /** 时间戳 */
  t: number;
  /** 产生记录的世界 */
  src: DiagSource;
  /** 事件名，点号分层，例如 `parse.sse` */
  event: string;
  level: DiagLevel;
  /** 一行摘要（人读） */
  detail?: string;
  /** 原始文本采样（机读；只在需要还原结构时附带） */
  text?: string;
}

/** 截断文本（保留尾部，因为 SSE 的关键数据常在末尾） */
export function clip(text: string, max: number = LIMITS.DIAG_MAX_TEXT): string {
  if (!text || text.length <= max) return text ?? '';
  const head = Math.floor(max * 0.35);
  const tail = max - head;
  return `${text.slice(0, head)}\n……[中略 ${text.length - max} 字符]……\n${text.slice(-tail)}`;
}

/**
 * 采样：优先给出**关键字附近的窗口**（最有诊断价值），
 * 找不到关键字时退回「头 + 尾」。
 */
export function sample(text: string, keyword: string, max: number = LIMITS.DIAG_MAX_TEXT): string {
  if (!text) return '';
  if (text.length <= max) return text;
  const index = keyword ? text.indexOf(keyword) : -1;
  if (index >= 0) {
    const start = Math.max(0, index - Math.floor(max * 0.15));
    const window = text.slice(start, start + max);
    return `……[自偏移 ${start} 起 ${window.length} 字符，围绕 "${keyword}"]……\n${window}`;
  }
  return clip(text, max);
}

/** 安全地把任意值转成一行摘要（不抛异常、不产生循环引用） */
export function describe(value: unknown, max: number = 240): string {
  try {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…(+${value.length - max})` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    return json.length > max ? `${json.slice(0, max)}…(+${json.length - max})` : json;
  } catch {
    return '[unserializable]';
  }
}

export interface MakeOptions {
  level?: DiagLevel;
  text?: string;
  now?: number;
}

export function makeRecord(src: DiagSource, event: string, detail?: string, options: MakeOptions = {}): DiagRecord {
  const record: DiagRecord = {
    t: options.now ?? Date.now(),
    src,
    event,
    level: options.level ?? 'info',
  };
  if (detail !== undefined) record.detail = detail;
  if (options.text) record.text = clip(options.text);
  return record;
}

function sizeOf(record: DiagRecord): number {
  return JSON.stringify(record).length + 2;
}

/**
 * 「关键记录」的事件前缀 —— 这几类是排查链路的骨架：
 * 没有 `hook.ready` 就不知道 hook 装没装上，没有 `net.*` 就不知道截没截到接口，
 * 没有 `parse.*` 就不知道字段路径有没有变。它们**最后才被淘汰**。
 *
 * 判定按事件名在**淘汰时**推导（而不是写进记录里），这样从别的上下文
 * 通过消息传进来的记录也能享受同样的保留策略，且不会污染导出的 JSON 形状。
 */
const KEEP_EVENT_PREFIXES = ['hook.', 'net.', 'parse.'] as const;

export function isKeepEvent(event: string): boolean {
  return KEEP_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix));
}

/* --------------------------------------------------------------------------- */
/* 重复记录抑制（2026-10-02 §40）                                                 */
/* --------------------------------------------------------------------------- */

/**
 * **纯查询回执**类事件：内容不变时是纯噪声，应抑制重复。
 *
 * 实测（用户两份诊断 JSON）：一次 500 条的导出里约**四成**是 `page.query` /
 * `content.query` / `bg.state` —— 每次开弹窗、每次诊断页取状态都会留下两三条；
 * 它们既不是证据、又会把 `vid.*` / `bg.size` / `draft.emit` 这些真证据冲淡
 * （§26 那次是「关键记录挤满缓冲」，这次是「噪声稀释缓冲」，同一个病根的另一面）。
 *
 * ⚠️ **只允许**给这三类用。`vid.recheck` / `bg.size` / `net.*` 等事件**重复本身就是证据**
 * （重试轮次、失败重试、站点重复推送），抑制它们等于隐藏问题。
 */
export const REPEAT_SUPPRESS_EVENTS: readonly string[] = ['page.query', 'content.query', 'bg.state'];

/**
 * 造一个「同一事件 + 同一 detail 只记一次」的抑制器（每个上下文各持一个）。
 *
 * 语义：**只与前一条同事件记录比较** —— 内容变了就记（会话切换 / 槽条数变化都能看到），
 * 没变就丢。因此「同一条信息重复出现」仍会被完整保留（它前面必然夹着别的事件）。
 */
export function createRepeatSuppressor(): (event: string, detail: string) => boolean {
  const last = new Map<string, string>();
  return (event, detail) => {
    if (!REPEAT_SUPPRESS_EVENTS.includes(event)) return true;
    if (last.get(event) === detail) return false;
    last.set(event, detail);
    return true;
  };
}

/**
 * 追加一条记录并保持有界：
 *   ① 条数超过上限 → 丢最旧的
 *   ② 总字节超过上限 → 继续丢最旧的
 *
 * 淘汰分三轮（`docs/03` §3 缺陷 3；2026-09-28 §26 补正「关键记录填满缓冲 → 非关键事件失明」）：
 *   - **第〇轮：关键记录（`hook.*` / `net.*` / `parse.*`）超过配额（75%）的最旧者先让位**。
 *     没有配额时，缓冲会被 chain 每 30~60s 一条的报文记录填满，第一轮「丢旧非关键」永远
 *     找不到可丢对象，只好把刚进来的非关键记录自己吞掉 —— `vid.*` / `bg.*` / `draft.emit`
 *     从此一条都进不了缓冲，诊断永久失明（§26 实测事故，两份诊断 JSON 全程零非关键记录）。
 *   - **第一轮丢最旧的非关键记录**（不含本次刚追加的最后一条 —— 防自噬）。
 *   - 第二轮才从最旧的关键记录开始丢（含新记录 —— 绝对兜底）。
 * 至少保留一条（无论多超限），避免刚写入的当前记录被自己挤掉。
 */
export function pushBounded(
  list: DiagRecord[],
  record: DiagRecord,
  maxRecords: number = LIMITS.DIAG_MAX_RECORDS,
  maxBytes: number = LIMITS.DIAG_MAX_BYTES,
): DiagRecord[] {
  const next = [...list, record];
  if (next.length <= 1) return next;

  const sizes = next.map(sizeOf);
  const dropped = next.map(() => false);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let count = next.length;

  const over = () => count > maxRecords || (total > maxBytes && count > 1);
  const keepQuota = Math.max(1, Math.floor(maxRecords * 0.75));
  const reserved = Math.max(1, maxRecords - keepQuota);
  let keptCritical = next.filter((r) => isKeepEvent(r.event)).length;
  let keptNonCritical = next.length - keptCritical;
  // 只有缓冲里已有（或即将有）非关键记录时才让位 —— 全关键记录的缓冲保留满容量
  const needRoom = keptNonCritical > 0 || !isKeepEvent(record.event);

  // 第〇轮：关键记录超配额 → 最旧的让位（为非关键事件留常驻空间，与是否 over 无关）
  for (let i = 0; i < next.length && needRoom && keptCritical > keepQuota; i++) {
    if (!isKeepEvent(next[i].event)) continue;
    dropped[i] = true;
    count--;
    total -= sizes[i];
    keptCritical--;
  }

  // 第一轮：丢最旧的非关键记录（最后一条 = 本次刚追加的，不参与 —— 防自噬），
  // 但非关键记录在保留水位（reserved）之上才开始丢 —— 让它们能攒出完整的证据序列
  for (let i = 0; i < next.length - 1 && over(); i++) {
    if (isKeepEvent(next[i].event) || dropped[i]) continue;
    if (keptNonCritical <= reserved) break;
    dropped[i] = true;
    count--;
    total -= sizes[i];
    keptNonCritical--;
  }

  // 第二轮：才允许动关键记录与最后一条（绝对兜底）
  for (let i = 0; i < next.length && over(); i++) {
    if (dropped[i]) continue;
    dropped[i] = true;
    count--;
    total -= sizes[i];
  }

  return dropped.some(Boolean) ? next.filter((_, i) => !dropped[i]) : next;
}

/** 事件的严重级别判定（让 debug 页能一眼看出问题记录） */
export function isProblem(record: DiagRecord): boolean {
  return record.level !== 'info';
}
