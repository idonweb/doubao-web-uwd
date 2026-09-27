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

/**
 * 追加一条记录并保持有界：
 *   ① 条数超过上限 → 丢最旧的
 *   ② 总字节超过上限 → 继续丢最旧的
 *
 * 淘汰分两轮（`docs/03` §3 缺陷 3）：
 *   - **第一轮只丢非关键记录**，保住 `hook.*` / `net.*` / `parse.*` 这条证据链；
 *   - 第一轮丢完仍超限，才从最旧的关键记录开始丢。
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

  for (let i = 0; i < next.length && over(); i++) {
    if (isKeepEvent(next[i].event)) continue;
    dropped[i] = true;
    count--;
    total -= sizes[i];
  }

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
