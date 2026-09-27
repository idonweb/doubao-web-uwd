import { describe, expect, it } from 'vitest';

import { collectChainCreations, decodeChainUrls, extractChainRaw, matchChainMainUrls } from '../src/core/extract/chain';
import { toDrafts } from '../src/core/extract/common';
import {
  CHAIN_DURATION,
  CHAIN_FALLBACK_API,
  CHAIN_RESPONSE,
  CHAIN_RESPONSE_NOT_JSON,
  CHAIN_RESPONSE_URL_ONLY,
  CHAIN_VID,
  VIDEO_THUMB,
  chainWatermarkedUrl,
} from './fixtures/samples';

const CTX = { convId: 'hist-1', convKind: 'chat' as const, convTitle: '历史会话' };

describe('chain/single 的 base64 main_url（正则路线）', () => {
  it('能命中被二次转义的 base64（长度 >= 100）', () => {
    const urls = matchChainMainUrls(CHAIN_RESPONSE);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(chainWatermarkedUrl);
  });

  it('全局正则不残留 lastIndex（连续调用结果一致）', () => {
    expect(matchChainMainUrls(CHAIN_RESPONSE)).toEqual(matchChainMainUrls(CHAIN_RESPONSE));
  });

  it('标记出解出来的地址带不带 unwatermarked（仅作参考，不再用于过滤）', () => {
    const decoded = decodeChainUrls(CHAIN_RESPONSE);
    expect(decoded.map((item) => item.unwatermarked)).toEqual([false]);
  });
});

describe('chain/single 结构化解析（P0-1 修复）', () => {
  const raws = extractChainRaw(CHAIN_RESPONSE);

  it('能从报文里收集到 creation', () => {
    expect(collectChainCreations(CHAIN_RESPONSE)).toHaveLength(1);
  });

  it('取出 video_id → vid（旧实现把这条丢掉了）', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].kind).toBe('video');
    expect(raws[0].vid).toBe(CHAIN_VID);
    expect(raws[0].origin).toBe('chain');
  });

  it('取出 video_duration / video_thumb / fallback_api（旧实现全部浪费）', () => {
    expect(raws[0].duration).toBe(CHAIN_DURATION);
    expect(raws[0].thumb).toBe(VIDEO_THUMB);
    expect(raws[0].fallbackApi).toBe(CHAIN_FALLBACK_API);
  });

  it('video_model 的多层转义能被解开，main_url 不含 unwatermarked 也照样保留', () => {
    expect(raws[0].videoModel).toContain('video_list');
    const urls = raws[0].videoModel ?? '';
    // 断言它确实是被转义的形态（引号前带反斜杠），而不是普通 JSON
    expect(urls).toContain('\\"main_url\\"');
  });

  it('链式响应里没有 ori_raw，因此不伪装成原片（raw 为空，等三步 API）', () => {
    expect(raws[0].raw).toBeUndefined();
    const drafts = toDrafts(raws, CTX);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].state).toBe('pending');
    expect(drafts[0].fingerprint).toBe(`vid:${CHAIN_VID}`);
    expect(drafts[0].vid).toBe(CHAIN_VID);
    expect(drafts[0].meta.duration).toBe(CHAIN_DURATION);
    // 变体里应包含 video_model 的清晰度与 fallback_api
    const labels = drafts[0].variants.map((variant) => variant.label);
    expect(labels).toContain('720p');
    expect(labels).toContain('备选播放源（带水印）');
    // 没有任何变体被标成无水印原片
    expect(drafts[0].variants.every((variant) => !variant.isRaw)).toBe(true);
  });
});

describe('chain/single 的正则兜底（JSON 结构走不通时）', () => {
  it('结构化拿不到 creation 时，只产出候选地址（downloadUrl），并打上 origin=chain', () => {
    const raws = extractChainRaw(CHAIN_RESPONSE_URL_ONLY);
    expect(raws).toHaveLength(1);
    expect(raws[0].downloadUrl).toBe(chainWatermarkedUrl);
    expect(raws[0].vid).toBeUndefined();
    expect(raws[0].raw).toBeUndefined();
  });

  it('非 JSON 报文同样走兜底', () => {
    const raws = extractChainRaw(CHAIN_RESPONSE_NOT_JSON);
    expect(raws).toHaveLength(1);
    expect(raws[0].downloadUrl).toBe(chainWatermarkedUrl);
  });

  it('只有候选地址、没有 vid 的视频按 J3 不入库（宁缺勿假）', () => {
    expect(toDrafts(extractChainRaw(CHAIN_RESPONSE_URL_ONLY), CTX)).toEqual([]);
    expect(toDrafts(extractChainRaw(CHAIN_RESPONSE_NOT_JSON), CTX)).toEqual([]);
  });
});

describe('chain/single 坏输入', () => {
  it('空文本与无关 JSON 返回空', () => {
    expect(extractChainRaw('')).toEqual([]);
    expect(extractChainRaw('{"a":1}')).toEqual([]);
    expect(collectChainCreations('')).toEqual([]);
    expect(collectChainCreations('{"a":1}')).toEqual([]);
  });
});
