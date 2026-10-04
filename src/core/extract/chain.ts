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
  IMG_LIST_KEY,
  MESSAGE_CREATE_TIME_KEY,
} from '../site-contract';
import { asNumber, decodeBase64, isObject, parseLooseJson, rawFromCreation, rawFromImageListEntry } from './common';
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
  /**
   * 与 `out` **一一对应**的「所在消息的生成时间」（秒级 Unix；读不到为 null）。
   *
   * 2026-09-28 第十轮：实测消息对象自带 `create_time`
   * （路径 `data.downlink_body.pull_singe_chain_downlink_body.messages[i].create_time`，
   * 与网页上显示的时间一致）。遍历时把它**向下继承**给该消息里的 creation，
   * 于是图片 / 视频 / 旧作品都能拿到真实生成时间。
   */
  times: Array<number | null>;
  /**
   * **老链路「修改生成」**的结果条目（`msg.content.image_list[*]`，2026-10-03 §43）。
   *
   * 它们**不带 `image` 子对象**（字段直接挂在条目上：`image_raw` / `image_ori` / …），
   * 所以 `CREATION_MEDIA_KEYS` 那条判据永远命中不了 —— 这正是「老会话里编辑图嗅探不到」
   * 的根因（`docs/03` §43.2）。
   */
  list: Array<{ entry: Record<string, unknown>; createdAt: number | null }>;
  seen: Set<unknown>;
  budget: number;
}

function walkForCreations(value: unknown, depth: number, state: WalkState, inheritedTime: number | null = null): void {
  if (state.budget <= 0 || depth > CREATION_WALK_MAX_DEPTH) return;
  if (!value || typeof value !== 'object') return;
  state.budget -= 1;

  if (Array.isArray(value)) {
    for (const item of value) walkForCreations(item, depth + 1, state, inheritedTime);
    return;
  }

  if (state.seen.has(value)) return;
  state.seen.add(value);
  const obj = value as Record<string, unknown>;

  // 对象自己带 `create_time`（消息对象）→ 成为下面所有子节点的时间来源
  const ownTime = asNumber(obj[MESSAGE_CREATE_TIME_KEY]);
  const time = ownTime ?? inheritedTime;

  /*
   * 老链路「修改生成」的结果容器（§43）：**必须在 creation 判据之前收** ——
   * 它们是「叶子」，但既没有 `image` 子对象也没有 `video` 子对象，走不到下面的 push 分支。
   */
  const listValue = obj[IMG_LIST_KEY];
  if (listValue !== undefined) {
    const entries = Array.isArray(listValue) ? listValue : parseLooseJson(listValue);
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (isObject(entry)) state.list.push({ entry, createdAt: time });
      }
    }
  }

  if (CREATION_MEDIA_KEYS.some((key) => isObject(obj[key]))) {
    // creation 是叶子：不再往下钻，避免把同一条消息里的封面图当成第二条
    state.out.push(obj);
    state.times.push(time);
    return;
  }

  for (const child of Object.values(obj)) {
    // 响应里存在被多层转义的 JSON 字符串（实测：video_model），
    // 顺手解开再看一眼，避免 creation 藏在转义层里被漏掉。
    if (typeof child === 'string') {
      if (child.length > 2 && (child[0] === '{' || child[0] === '[')) {
        walkForCreations(parseLooseJson(child), depth + 1, state, time);
      }
      continue;
    }
    walkForCreations(child, depth + 1, state, time);
  }
}

/**
 * **一次遍历**同时取出两类目标（2026-10-03 §43）：
 *   · `creations` —— 常规 creation（`creation_block.creations[]`，含 `image` / `video` 子对象）；
 *   · `list` —— 老链路「修改生成」的结果（`msg.content.image_list[*]`，字段直接挂在条目上）。
 * 合并成一次遍历是为了不重复解析这份几十~几百 KB 的报文。
 */
export function walkChainAll(text: string): {
  creations: Array<{ creation: Record<string, unknown>; createdAt: number | null }>;
  list: Array<{ entry: Record<string, unknown>; createdAt: number | null }>;
} {
  if (!text) return { creations: [], list: [] };
  const parsed = parseLooseJson(text);
  if (!parsed) return { creations: [], list: [] };
  const state: WalkState = { out: [], times: [], list: [], seen: new Set(), budget: WALK_BUDGET };
  walkForCreations(parsed, 0, state);
  return {
    creations: state.out.map((creation, i) => ({ creation, createdAt: state.times[i] ?? null })),
    list: state.list,
  };
}

/** 遍历收集 creation **及其所在消息的生成时间（秒级）**；`collectChainCreations` 的详细版 */
export function walkChainCreations(text: string): { creation: Record<string, unknown>; createdAt: number | null }[] {
  return walkChainAll(text).creations;
}

/** 从报文文本里收集所有 creation 对象（结构化路线；解析不了就返回空） */
export function collectChainCreations(text: string): Record<string, unknown>[] {
  return walkChainCreations(text).map((item) => item.creation);
}

/**
 * 抽取媒体素材。
 *
 * 优先走结构化路线（能顺带拿到 vid / 时长 / video_model / fallback_api / **生成时间**）；
 * 结构化拿不到时才退回正则路线，且只产出**候选地址**（供页面预览与末位下载兜底），
 * 不会伪装成无水印原片。
 */
export function extractChainRaw(text: string): RawMedia[] {
  if (!text) return [];

  const { creations, list } = walkChainAll(text);
  const out: RawMedia[] = [];
  for (const { creation, createdAt } of creations) {
    const media = rawFromCreation(creation, 'chain');
    if (!media) continue;
    if (media.createdAt === undefined && createdAt !== null) media.createdAt = createdAt;
    out.push(media);
  }
  /*
   * 老链路「修改生成」（2026-10-03 §43）：结果**不在** `creation_block.creations` 里，
   * 而在 `msg.content.image_list[*]`。站点没给 `image_ori_raw`，只给两档带水印的同源底图 ——
   * 抽取层存「预览档 + 补角配方」，下载时由内容脚本补齐（`docs/03` §43.9 方案 A+B）。
   */
  for (const { entry, createdAt } of list) {
    const media = rawFromImageListEntry(entry, 'chain');
    if (!media) continue;
    if (media.createdAt === undefined && createdAt !== null) media.createdAt = createdAt;
    out.push(media);
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
