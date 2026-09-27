/**
 * SSE（`/chat/completion`）响应解析 —— **纯函数**，用真实响应样本做 fixture 单测。
 *
 * 数据路径（site-contract §2）：
 *   data.patch_op[].patch_value.content_block[].content.creation_block.creations[]
 *
 * `creation → RawMedia` 的字段映射与 chain / thread 完全同构，
 * 已统一收敛到 `common.ts::rawFromCreation()`，本文件只负责「怎么找到 creations」。
 */

import {
  PATH_CONTENT,
  PATH_CREATIONS,
  PATH_PATCH_OP,
  PATH_PATCH_VALUE,
  SSE_CREATION_BLOCK,
} from '../site-contract';
import { getPath, rawFromCreation } from './common';
import type { RawMedia } from '../types';

/** patch_op[].patch_value.content_block[] */
const PATH_BLOCKS = [...PATH_PATCH_VALUE, 'content_block'];
/** content_block[].content.creation_block.creations[] */
const PATH_CREATIONS_FULL = [...PATH_CONTENT, SSE_CREATION_BLOCK, PATH_CREATIONS[0]];

/** 按 `\n\n` 切分 SSE 事件（与上游一致的切分方式） */
export function splitSseEvents(text: string): string[] {
  return text.split('\n\n');
}

/** 从单个 SSE 事件里取出 `data:` 载荷并 JSON.parse */
export function parseSseEventData(event: string): unknown | null {
  const chunks: string[] = [];
  for (const line of event.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('data:')) chunks.push(trimmed.slice(5).trimStart());
  }
  if (!chunks.length) return null;
  const payload = chunks.join('\n').trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** 从一次 SSE 响应文本里抽取所有原始媒体素材 */
export function extractSseRaw(text: string): RawMedia[] {
  if (!text || !text.includes(SSE_CREATION_BLOCK)) return [];
  const out: RawMedia[] = [];

  for (const event of splitSseEvents(text)) {
    if (!event.includes(SSE_CREATION_BLOCK)) continue;
    const data = parseSseEventData(event);
    if (!data) continue;

    const patchOps = getPath(data, PATH_PATCH_OP);
    if (!Array.isArray(patchOps)) continue;

    for (const op of patchOps) {
      const blocks = getPath(op, PATH_BLOCKS);
      if (!Array.isArray(blocks)) continue;

      for (const block of blocks) {
        const creations = getPath(block, PATH_CREATIONS_FULL);
        if (!Array.isArray(creations)) continue;
        for (const creation of creations) {
          const media = rawFromCreation(creation, 'sse');
          if (media) out.push(media);
        }
      }
    }
  }

  return out;
}
