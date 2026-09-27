/**
 * `/im/chain/single`（历史会话 REST 响应）解析 —— **纯函数**。
 *
 * 首轮实机联调结论（`docs/03` §2 P0-1）：
 *   旧实现「正则捞 base64 → 只留含 `unwatermarked` 的地址」在本站点**全部落空**。
 *   实测 `main_url` 解码出来的是 `lr=video_gen_watermark_dyn`（带水印转码流），
 *   被关键词过滤器全量丢掉，于是 `hasMainUrl=true` 却 `raws=0`。
 *
 * 现在的做法（三条路并存，靠指纹 upsert 归并）：
 *   ① **结构化**：解析响应 JSON，在解析树上收集 creation（`video` / `image` 子对象），
 *      交给与 SSE / thread 共用的 `rawFromCreation()` —— 于是 chain 里那些
 *      以前被白白扔掉的 `video_id`(=vid) / `video_duration` / `video_model` / `fallback_api`
 *      全部被利用起来；
 *   ② **真原片**由 ① 里取到的 `video_id` 走三步 API 换取（页面层负责，异步补一条变体）；
 *   ③ **正则兜底**：JSON 结构走不通时，仍从报文里捞 base64 的 `main_url`，
 *      但**降级为候选地址**（`downloadUrl`，rank 60），绝不当成无水印原片。
 */

import {
  CHAIN_MAIN_URL_RE,
  CHAIN_UNWATERMARK_TAG,
  CREATION_MEDIA_KEYS,
  CREATION_WALK_MAX_DEPTH,
} from '../site-contract';
import { decodeBase64, isObject, parseLooseJson, rawFromCreation } from './common';
import type { RawMedia } from '../types';

/** 解析树遍历的节点预算，防止异常响应上打转 */
const WALK_BUDGET = 20_000;

/** 取正则时重置 lastIndex，避免全局正则的状态残留（上游用 while + exec，容易漏掉） */
export function matchChainMainUrls(text: string): string[] {
  if (!text) return [];
  const re = new RegExp(CHAIN_MAIN_URL_RE.source, CHAIN_MAIN_URL_RE.flags);
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const decoded = decodeBase64(match[1]);
    if (decoded) out.push(decoded);
  }
  return out;
}

/** 解码出所有 base64 媒体地址（含是否带 `unwatermarked` 标记 —— **只作参考，不再用于过滤**） */
export interface ChainUrl {
  url: string;
  unwatermarked: boolean;
}

export function decodeChainUrls(text: string): ChainUrl[] {
  return matchChainMainUrls(text).map((url) => ({
    url,
    unwatermarked: url.includes(CHAIN_UNWATERMARK_TAG),
  }));
}

/* --------------------------------------------------------------------------- */
/* 结构化解析                                                                    */
/* --------------------------------------------------------------------------- */

interface WalkState {
  out: Record<string, unknown>[];
  seen: Set<unknown>;
  budget: number;
}

function walkForCreations(value: unknown, depth: number, state: WalkState): void {
  if (state.budget <= 0 || depth > CREATION_WALK_MAX_DEPTH) return;
  if (!value || typeof value !== 'object') return;
  state.budget -= 1;

  if (Array.isArray(value)) {
    for (const item of value) walkForCreations(item, depth + 1, state);
    return;
  }

  if (state.seen.has(value)) return;
  state.seen.add(value);
  const obj = value as Record<string, unknown>;

  if (CREATION_MEDIA_KEYS.some((key) => isObject(obj[key]))) {
    // creation 是叶子：不再往下钻，避免把同一条消息里的封面图当成第二条
    state.out.push(obj);
    return;
  }

  for (const child of Object.values(obj)) {
    // 响应里存在被多层转义的 JSON 字符串（实测：video_model），
    // 顺手解开再看一眼，避免 creation 藏在转义层里被漏掉。
    if (typeof child === 'string') {
      if (child.length > 2 && (child[0] === '{' || child[0] === '[')) {
        walkForCreations(parseLooseJson(child), depth + 1, state);
      }
      continue;
    }
    walkForCreations(child, depth + 1, state);
  }
}

/** 从报文文本里收集所有 creation 对象（结构化路线；解析不了就返回空） */
export function collectChainCreations(text: string): Record<string, unknown>[] {
  if (!text) return [];
  const parsed = parseLooseJson(text);
  if (!parsed) return [];
  const state: WalkState = { out: [], seen: new Set(), budget: WALK_BUDGET };
  walkForCreations(parsed, 0, state);
  return state.out;
}

/**
 * 抽取媒体素材。
 *
 * 优先走结构化路线（能顺带拿到 vid / 时长 / video_model / fallback_api）；
 * 结构化拿不到时才退回正则路线，且只产出**候选地址**（供页面预览与末位下载兜底），
 * 不会伪装成无水印原片。
 */
export function extractChainRaw(text: string): RawMedia[] {
  if (!text) return [];

  const creations = collectChainCreations(text);
  const out: RawMedia[] = [];
  for (const creation of creations) {
    const media = rawFromCreation(creation, 'chain');
    if (media) out.push(media);
  }
  if (out.length) return out;

  // 兜底：响应结构变了（或不是 JSON）时，仍尝试从报文里捞 base64 候选地址
  const urls = decodeChainUrls(text);
  if (!urls.length) return [];
  return urls.map((item) => ({
    kind: 'video',
    origin: 'chain',
    // ⚠️ 是候选而非原片：实测解出来就是 `lr=video_gen_watermark_dyn`
    downloadUrl: item.url,
  }));
}
