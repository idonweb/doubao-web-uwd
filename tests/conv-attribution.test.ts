/**
 * 响应归属判定 + 占位会话重键（2026-09-27 第七轮）的单测。
 *
 * 背景（诊断 JSON `D:\Beizai\uwd-diag-1790488525983.json` 实测）：
 *   Bug A —— 新建会话的请求发出时 URL 是 `local_*` 占位 ID，携带 creation_block 的
 *            SSE 生成响应到达时页面已是真实 ID，旧逻辑按「请求时刻快照」判异会话整体丢弃；
 *   Bug B —— `/im/chain/single` 是用户级 IM 同步通道，视频生成完成的消息会从**别的会话**
 *            推到当前连接上，旧逻辑把它盖上当前会话的章入库 → 跨会话泄漏。
 *
 * fixture 取自实测报文的**结构等价**片段（与 `fixtures/samples.ts` 同一原则）。
 */

import { describe, expect, it } from 'vitest';
import { classifyResponseConv, collectConversationIds } from '../src/core/extract';
import { isLeaveScope, itemId, rekeyConv, retainConv, type Library } from '../src/core/library-store';
import { isDoubaoHostUrl, isLocalConvId, LOCAL_CONV_ID_PREFIX } from '../src/core/site-contract';
import type { MediaItem } from '../src/core/types';

/** 实测会话 ID：0617 = 当前会话，汉服 = 「生成完成」推送的来源会话 */
const CONV_0617 = '38431056049998850';
const CONV_HANFU = '38444348585732866';
const CONV_LOCAL = 'local_1371803923460589';

/* --------------------------------------------------------------------------- */
/* isLocalConvId                                                               */
/* --------------------------------------------------------------------------- */

describe('isLocalConvId', () => {
  it('认得实测的 local_ 占位前缀', () => {
    expect(LOCAL_CONV_ID_PREFIX).toBe('local_');
    expect(isLocalConvId('local_1371803923460589')).toBe(true);
  });

  it('真实会话 ID / 空 / undefined 都不是占位', () => {
    expect(isLocalConvId(CONV_0617)).toBe(false);
    expect(isLocalConvId('')).toBe(false);
    expect(isLocalConvId(undefined)).toBe(false);
    expect(isLocalConvId(null)).toBe(false);
  });
});

/* --------------------------------------------------------------------------- */
/* collectConversationIds / classifyResponseConv                                */
/* --------------------------------------------------------------------------- */

describe('collectConversationIds', () => {
  it('chain 空轮询响应（实测 len=259）里没有任何 conversation_id', () => {
    const text = String.raw`{"cmd":3100,"sequence_id":"b4a147d0","downlink_body":{"pull_singe_chain_downlink_body":{"messages":[],"has_more":false,"regen_messages":{},"msg_cursor":"1"}},"version":"1","status_code":0,"status_desc":"OK"}`;
    expect(collectConversationIds(text)).toEqual([]);
  });

  it('chain 消息体里的 conversation_id（未转义）', () => {
    const text = String.raw`{"downlink_body":{"pull_singe_chain_downlink_body":{"messages":[{"conversation_id":"38444348585732866","message_id":"56813596572618498","content_block":[]}]}}}`;
    expect(collectConversationIds(text)).toEqual([CONV_HANFU]);
  });

  it('SSE 的 ack_client_meta.conversation_id（未转义）', () => {
    const text = String.raw`event: SSE_ACK
data: {"query_list":[],"ack_client_meta":{"conversation_id":"38444348585732866","conversation_type":3,"section_id":"38444348585733122"}}`;
    expect(collectConversationIds(text)).toEqual([CONV_HANFU]);
  });

  it('被包在多层转义 JSON 字符串里的 conversation_id 也能收集（1~3 级转义）', () => {
    const oneLevel = String.raw`{"content":"[{\"conversation_id\":\"38444348585732866\"}]"}`;
    const threeLevels = String.raw`{"content":"[{\\\"conversation_id\\\":\\\"38444348585732866\\\"}]"}`;
    expect(collectConversationIds(oneLevel)).toEqual([CONV_HANFU]);
    expect(collectConversationIds(threeLevels)).toEqual([CONV_HANFU]);
  });

  it('去重保序；空文本返回空数组', () => {
    const text = String.raw`{"a":{"conversation_id":"38431056049998850"},"b":{"conversation_id":"38431056049998850"}}`;
    expect(collectConversationIds(text)).toEqual([CONV_0617]);
    expect(collectConversationIds('')).toEqual([]);
  });
});

describe('classifyResponseConv', () => {
  it('自报会话 = 当前会话 → match（chain 历史拉取的正常形态）', () => {
    const text = String.raw`{"messages":[{"conversation_id":"38431056049998850","content_block":[]}]}`;
    expect(classifyResponseConv(text, CONV_0617)).toBe('match');
  });

  it('自报会话 ≠ 当前会话 → foreign（实测 Bug B：0617 页面收到汉服的生成完成推送）', () => {
    const text = String.raw`{"downlink_body":{"pull_singe_chain_downlink_body":{"messages":[{"conversation_id":"38444348585732866","content_block":[{"content":{"creation_block":{"creations":[{"video":{"video_id":"v0369cg10004dasauaa7dld8vovgkjtg"}}]}}]}}]}}}`;
    expect(classifyResponseConv(text, CONV_0617)).toBe('foreign');
  });

  it('读不到 conversation_id → unknown（调用方退回请求快照判定）', () => {
    const text = String.raw`{"cmd":3100,"downlink_body":{"pull_singe_chain_downlink_body":{"messages":[]}}}`;
    expect(classifyResponseConv(text, CONV_0617)).toBe('unknown');
  });

  it('混合自报（含当前会话）→ match：整体放行，宁可有痕也不误杀当前会话的资源', () => {
    const text = String.raw`{"messages":[{"conversation_id":"38431056049998850"},{"conversation_id":"38444348585732866"}]}`;
    expect(classifyResponseConv(text, CONV_0617)).toBe('match');
  });
});

/* --------------------------------------------------------------------------- */
/* isDoubaoHostUrl（第八轮：弹窗徽标按「是否在豆包域内」细分）                       */
/* --------------------------------------------------------------------------- */

describe('isDoubaoHostUrl', () => {
  it('豆包 / dola 主域与子域 → true', () => {
    expect(isDoubaoHostUrl('https://www.doubao.com/chat?channel=itab2')).toBe(true);
    expect(isDoubaoHostUrl('https://doubao.com/')).toBe(true);
    expect(isDoubaoHostUrl('https://abc.doubao.com/chat/123')).toBe(true);
    expect(isDoubaoHostUrl('https://dola.com/thread/123')).toBe(true);
  });

  it('非豆包域 / 伪装域 / 空值 → false', () => {
    expect(isDoubaoHostUrl('https://example.com/')).toBe(false);
    // 「doubao.com.evil.io」这类以子串冒充的域名不算
    expect(isDoubaoHostUrl('https://doubao.com.evil.io/')).toBe(false);
    expect(isDoubaoHostUrl('not-a-url')).toBe(false);
    expect(isDoubaoHostUrl('')).toBe(false);
    expect(isDoubaoHostUrl(undefined)).toBe(false);
  });
});

/* --------------------------------------------------------------------------- */
/* isLeaveScope（第八轮：离开会话 = 豆包域内非会话页）                              */
/* --------------------------------------------------------------------------- */

describe('isLeaveScope', () => {
  it('kind=none → 离开会话（豆包首页弹窗残留的根因分支）', () => {
    expect(isLeaveScope({ convId: '', kind: 'none' })).toBe(true);
  });

  it('会话 ID 为空 → 离开会话（无论 kind）', () => {
    expect(isLeaveScope({ convId: '', kind: 'chat' })).toBe(true);
    expect(isLeaveScope({ convId: '   ', kind: 'thread' })).toBe(true);
    expect(isLeaveScope({})).toBe(true);
  });

  it('真实会话 → 不是离开', () => {
    expect(isLeaveScope({ convId: CONV_HANFU, kind: 'chat' })).toBe(false);
  });

  it('local_ 占位会话 → 不是离开（占位仍是会话，由 rekeyConv 接手）', () => {
    expect(isLeaveScope({ convId: CONV_LOCAL, kind: 'chat' })).toBe(false);
    expect(isLocalConvId(CONV_LOCAL)).toBe(true);
  });
});

/* --------------------------------------------------------------------------- */
/* rekeyConv（占位会话 → 真实会话）                                               */
/* --------------------------------------------------------------------------- */

function makeItem(convId: string, fingerprint: string, overrides: Partial<MediaItem> = {}): MediaItem {
  const url = `https://cdn.example/${fingerprint}`;
  return {
    id: itemId(convId, fingerprint),
    convId,
    convKind: 'chat',
    convTitle: '',
    fingerprint,
    kind: 'video',
    state: 'raw',
    variants: [{ url, label: '无水印原片', rank: 100, isRaw: true }],
    primary: url,
    cover: null,
    meta: { ext: 'mp4' },
    firstSeen: 1,
    lastSeen: 1,
    ...overrides,
  };
}

describe('rekeyConv', () => {
  it('把占位会话的条目重键到真实会话（id 与 convId 同步更新）', () => {
    const source = makeItem(CONV_LOCAL, 'vid:abc');
    const library: Library = { [source.id]: source };
    const next = rekeyConv(library, CONV_LOCAL, CONV_HANFU);

    const targetId = itemId(CONV_HANFU, 'vid:abc');
    expect(next[targetId]).toBeDefined();
    expect(next[targetId].convId).toBe(CONV_HANFU);
    expect(next[targetId].id).toBe(targetId);
    expect(next[source.id]).toBeUndefined();
  });

  it('真实会话下已有同指纹条目 → 合并 variants，不产生重复', () => {
    const local = makeItem(CONV_LOCAL, 'vid:abc', { lastSeen: 5 });
    const real = makeItem(CONV_HANFU, 'vid:abc', {
      variants: [
        { url: 'https://cdn.example/candidate', label: '候选地址', rank: 60, isRaw: false },
        { url: 'https://cdn.example/vid:abc', label: '无水印原片', rank: 100, isRaw: true },
      ],
      lastSeen: 2,
    });
    const library: Library = { [local.id]: local, [real.id]: real };
    const next = rekeyConv(library, CONV_LOCAL, CONV_HANFU);

    expect(Object.keys(next)).toEqual([itemId(CONV_HANFU, 'vid:abc')]);
    const merged = next[itemId(CONV_HANFU, 'vid:abc')];
    expect(merged.variants).toHaveLength(2);
    expect(merged.lastSeen).toBe(5);
  });

  it('没有占位条目时原样返回（同一引用，便于调用方判断是否落盘）', () => {
    const source = makeItem(CONV_0617, 'vid:abc');
    const library: Library = { [source.id]: source };
    expect(rekeyConv(library, CONV_LOCAL, CONV_HANFU)).toBe(library);
  });

  it('from === to / 空值 → 原样返回', () => {
    const library: Library = {};
    expect(rekeyConv(library, CONV_0617, CONV_0617)).toBe(library);
    expect(rekeyConv(library, '', CONV_0617)).toBe(library);
  });

  it('与 retainConv 配合：先重键再裁剪，占位期素材在真实会话下保留', () => {
    // 场景还原：占位期入库 1 条 + 更早会话残留 1 条 → 真实 ID scope 到达
    const localItem = makeItem(CONV_LOCAL, 'vid:new');
    const staleItem = makeItem('38429025539452674', 'vid:old');
    const library: Library = { [localItem.id]: localItem, [staleItem.id]: staleItem };

    let next = rekeyConv(library, CONV_LOCAL, CONV_HANFU);
    next = retainConv(next, CONV_HANFU);

    expect(Object.keys(next)).toEqual([itemId(CONV_HANFU, 'vid:new')]);
  });
});
