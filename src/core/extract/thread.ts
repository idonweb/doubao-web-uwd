/**
 * 分享链接页（`/thread/`）解析 —— **纯函数**。
 *
 * 定位 `script[data-fn-args]`，兼容两种 JSON 结构（上游实测）：
 *   ① ["thread_xxx/page", "shareInfo", { data: { message_snapshot: { message_list: [...] } } }]
 *   ② ["thread_xxx/page", [{ key: "shareInfo", routerDataFnArgs: ["<JSON 字符串>"] }]]
 * 数据路径：shareInfo.data.message_snapshot.message_list[].content_block[].content.creation_block.creations[]
 */

import {
  FN_ARGS_SELECTOR,
  MESSAGE_CONTENT_BLOCK,
  ROUTER_DATA_FN_ARGS_KEY,
  SHARE_DATA_PATH,
  SHARE_DESCRIBE_MAX_DEPTH,
  SHARE_DESCRIBE_MAX_FIELDS,
  SHARE_INFO_INDEX,
  SHARE_INFO_KEY,
  SHARE_TITLE_KEYS,
  SHARE_TITLE_MAX_LEN,
  SHARE_TITLE_PATHS,
  SHARE_TITLE_WALK_MAX_DEPTH,
} from '../site-contract';
import { asString, getPath, isObject, rawFromCreation } from './common';
import type { RawMedia } from '../types';

export { FN_ARGS_SELECTOR };

/** 判断一个候选对象是不是 shareInfo（必须有 message_list） */
export function isShareInfo(value: unknown): boolean {
  return Array.isArray(getPath(value, SHARE_DATA_PATH));
}

/** 解析单个 `data-fn-args` 属性的值 */
export function parseFnArgs(raw: string | null | undefined): unknown | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从解析结果里取出 shareInfo（兼容两种结构） */
export function findShareInfo(parsed: unknown): Record<string, unknown> | null {
  if (!Array.isArray(parsed)) return null;

  // 结构 ①
  const direct = parsed[SHARE_INFO_INDEX];
  if (parsed.length > SHARE_INFO_INDEX + 1 && parsed[SHARE_INFO_INDEX] === SHARE_INFO_KEY) {
    const candidate = parsed[SHARE_INFO_INDEX + 1];
    if (isShareInfo(candidate)) return candidate as Record<string, unknown>;
  }

  // 结构 ②
  const routerData = parsed[1];
  if (Array.isArray(routerData)) {
    for (const entry of routerData) {
      if (!isObject(entry) || entry.key !== SHARE_INFO_KEY) continue;
      const fnArgs = entry[ROUTER_DATA_FN_ARGS_KEY];
      if (!Array.isArray(fnArgs) || !fnArgs.length) continue;
      const rawArg = fnArgs[0];
      if (typeof rawArg !== 'string') continue;
      try {
        const candidate: unknown = JSON.parse(rawArg);
        if (isShareInfo(candidate)) return candidate as Record<string, unknown>;
      } catch {
        /* 继续找下一个 */
      }
    }
  }

  // 兜底：直接给的就是 shareInfo
  if (isShareInfo(direct)) return direct as Record<string, unknown>;
  if (isShareInfo(parsed[SHARE_INFO_INDEX])) return parsed[SHARE_INFO_INDEX] as Record<string, unknown>;

  return null;
}

/** 遍历 shareInfo 里的全部 creation（视频与图片） */
export function eachCreation(shareInfo: unknown, visit: (creation: Record<string, unknown>) => void): void {
  const messages = getPath(shareInfo, SHARE_DATA_PATH);
  if (!Array.isArray(messages)) return;

  for (const message of messages) {
    if (!isObject(message)) continue;
    const blocks = message[MESSAGE_CONTENT_BLOCK];
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      const creations = getPath(block, ['content', 'creation_block', 'creations']);
      if (!Array.isArray(creations)) continue;
      for (const creation of creations) {
        if (isObject(creation)) visit(creation);
      }
    }
  }
}

/** 抽取分享页里的全部媒体素材（一条 creation 只产出一条 RawMedia） */
export function extractThreadRaw(shareInfo: unknown): RawMedia[] {
  const out: RawMedia[] = [];

  eachCreation(shareInfo, (creation) => {
    // 字段映射与 SSE / chain 同构，统一收敛到 common::rawFromCreation
    const media = rawFromCreation(creation, 'thread');
    if (media) out.push(media);
  });

  return out;
}

/**
 * 分享页标题。
 *
 * ⚠️ [第四轮修正 `docs/03` §9.9] 上游只写了 `data.share_info.title` 一路，**实测未命中**，
 * 结果分享页挂上了站点的通用标题（`豆包 - 字节跳动旗下 AI 智能助手`）。
 * 现在：① 按 `SHARE_TITLE_PATHS` 的多条候选路径取；② 都取不到时用 `findTitleByKey()`
 * 在结构里按 key 名兜底扫一遍；③ 仍然没有才用调用方给的 fallback。
 */
export function shareTitle(shareInfo: unknown, fallback = ''): string {
  for (const path of SHARE_TITLE_PATHS) {
    const hit = asString(getPath(shareInfo, path));
    if (hit) return hit;
  }
  const scanned = findTitleByKey(shareInfo);
  if (scanned) return scanned;
  return fallback;
}

/** 像标题的字符串：非空、不太长、不是 URL、不是 JSON */
function looksLikeTitle(text: string): boolean {
  if (!text || text.length > SHARE_TITLE_MAX_LEN) return false;
  if (/^(https?:)?\/\//i.test(text)) return false;
  if (text[0] === '{' || text[0] === '[') return false;
  return true;
}

/**
 * 兜底：在结构里**按 key 名**找第一个像标题的字符串（广度优先，优先浅层）。
 * 纯函数，可单测；深度与 key 名都来自 site-contract。
 */
export function findTitleByKey(
  root: unknown,
  keys: readonly string[] = SHARE_TITLE_KEYS,
  maxDepth: number = SHARE_TITLE_WALK_MAX_DEPTH,
): string {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (queue.length) {
    const item = queue.shift();
    if (!item || item.depth > maxDepth) continue;
    const { value, depth } = item;

    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
      }
      continue;
    }
    if (!isObject(value)) continue;

    for (const key of keys) {
      const hit = asString(value[key]);
      if (hit && looksLikeTitle(hit)) return hit;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
  }
  return '';
}

/**
 * 校准用结构摘要：列出结构里**所有 key 名含 title / name 的字段路径与值**。
 * 分享页标题取不到时由 `page/hook.ts` 打进 `parse.thread` 诊断（操作见 `docs/03` §9.8）。
 */
export function describeTitleFields(
  root: unknown,
  maxDepth: number = SHARE_DESCRIBE_MAX_DEPTH,
  limit: number = SHARE_DESCRIBE_MAX_FIELDS,
): string[] {
  const out: string[] = [];

  const walk = (value: unknown, path: string, depth: number): void => {
    if (out.length >= limit || depth > maxDepth) return;
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isObject(value)) return;

    for (const [key, child] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      if (/title|name/i.test(key)) {
        const text = asString(child);
        out.push(`${next} = ${text ? text.slice(0, 60) : `(${typeof child})`}`);
        if (out.length >= limit) return;
      }
      if (child && typeof child === 'object') walk(child, next, depth + 1);
    }
  };

  walk(root, '', 0);
  return out;
}
