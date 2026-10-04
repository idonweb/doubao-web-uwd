import { describe, expect, it } from 'vitest';

import {
  collectChainCreations,
  decodeChainUrls,
  extractChainRaw,
  matchChainMainUrls,
  walkChainAll,
  walkChainCreations,
} from '../src/core/extract/chain';
import { toDrafts } from '../src/core/extract/common';
import { IMG_PATCH_LABEL } from '../src/core/constants';
import { IMG_PATCH_RECT } from '../src/core/site-contract';
import {
  CHAIN_DURATION,
  CHAIN_FALLBACK_API,
  CHAIN_IMAGE_LIST_RESPONSE,
  CHAIN_IMAGE_LIST_RESPONSE_NO_DLD,
  CHAIN_MESSAGE_CREATE_TIME,
  CHAIN_RESPONSE,
  CHAIN_RESPONSE_NOT_JSON,
  CHAIN_RESPONSE_URL_ONLY,
  CHAIN_VID,
  IMG_LIST_CREATE_TIME,
  IMG_LIST_DLD_URL,
  IMG_LIST_HEIGHT,
  IMG_LIST_PRE_URL,
  IMG_LIST_THUMB_URL,
  IMG_LIST_WIDTH,
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

  it('封面字段是 video.cover.image_thumb.url（2026-09-28 实测；旧路径 video_thumb 不存在）', () => {
    // 回归锁：若有人把字段路径改回 `video_thumb`，这条会失败
    expect(raws[0].thumb).toBe(VIDEO_THUMB);
    expect(toDrafts(raws, CTX)[0].cover).toBe(VIDEO_THUMB);
  });

  it('video_model 的多层转义能被解开，main_url 不含 unwatermarked 也照样保留', () => {
    expect(raws[0].videoModel).toContain('video_list');
    const urls = raws[0].videoModel ?? '';
    // 断言它确实是被转义的形态（引号前带反斜杠），而不是普通 JSON
    expect(urls).toContain('\\"main_url\\"');
  });

  it('消息自带的 create_time 向下继承给 creation（秒级原样），并换算成毫秒写进 meta', () => {
    // 实测量级：`data.downlink_body.pull_singe_chain_downlink_body.messages[i].create_time`
    expect(raws[0].createdAt).toBe(CHAIN_MESSAGE_CREATE_TIME);

    const drafts = toDrafts(raws, CTX);
    expect(drafts[0].meta.createdAt).toBe(CHAIN_MESSAGE_CREATE_TIME * 1000);
    // 图片 / 视频都靠这条链路拿时间，不受「创作树只留约三个月」的限制
    expect(walkChainCreations(CHAIN_RESPONSE)[0].createdAt).toBe(CHAIN_MESSAGE_CREATE_TIME);
  });

  it('消息没有 create_time 时不编造（createdAt 缺省）', () => {
    const noTime = JSON.stringify({
      data: { downlink_body: { pull_singe_chain_downlink_body: { messages: [{ content_block: [] }] } } },
    });
    expect(extractChainRaw(noTime)).toEqual([]);
    // 有 creation 但没有时间 → raw 里不写 createdAt，draft.meta 里也不写
    const stripped = CHAIN_RESPONSE.replace(/"create_time":\d+,?/g, '');
    const drafts = toDrafts(extractChainRaw(stripped), CTX);
    expect(drafts[0].meta.createdAt).toBeUndefined();
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

describe('老链路「修改生成」的 image_list（2026-10-03 §43）', () => {
  const raws = extractChainRaw(CHAIN_IMAGE_LIST_RESPONSE);

  it('能钻过 `content` 那层转义 JSON 字符串认出条目', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].kind).toBe('image');
    expect(raws[0].origin).toBe('chain');
  });

  it('底板取**预览档**（`image_raw`）—— 不把它当「无水印原片」（字段名有误导性）', () => {
    expect(raws[0].raw).toBe(IMG_LIST_PRE_URL);
  });

  it('带上补角配方：像素来源 = **下载档**（`image_ori`）+ 宽松矩形', () => {
    expect(raws[0].patch).toEqual({ url: IMG_LIST_DLD_URL, rect: { ...IMG_PATCH_RECT } });
  });

  it('宽高取两档子对象（实测 1536×2730）；thumb 取缩略档当卡片封面', () => {
    expect(raws[0].width).toBe(IMG_LIST_WIDTH);
    expect(raws[0].height).toBe(IMG_LIST_HEIGHT);
    expect(raws[0].thumb).toBe(IMG_LIST_THUMB_URL);
  });

  it('toDrafts：state=raw（不被 skipThumbOnly 丢）、变体标「无水印（补角重建）」、配方进 meta、时间继承消息 create_time', () => {
    const drafts = toDrafts(raws, CTX);
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft.state).toBe('raw');
    const patchVariant = draft.variants.find((v) => v.label === IMG_PATCH_LABEL);
    expect(patchVariant?.isRaw).toBe(true);
    expect(draft.meta.patch).toEqual({ url: IMG_LIST_DLD_URL, rect: { ...IMG_PATCH_RECT } });
    expect(draft.meta.createdAt).toBe(IMG_LIST_CREATE_TIME * 1000);
  });

  it('缺下载档（`image_ori`）时不给配方 ⇒ 落 state=thumb（宁缺勿假，不冒充无水印）', () => {
    const rawsNoDld = extractChainRaw(CHAIN_IMAGE_LIST_RESPONSE_NO_DLD);
    expect(rawsNoDld).toHaveLength(1);
    expect(rawsNoDld[0].patch).toBeUndefined();
    const draft = toDrafts(rawsNoDld, CTX)[0];
    expect(draft.state).toBe('thumb');
    expect(draft.meta.patch).toBeUndefined();
  });

  it('walkChainAll 一次遍历同时给出 creations 与 image_list', () => {
    const all = walkChainAll(CHAIN_IMAGE_LIST_RESPONSE);
    expect(all.creations).toHaveLength(0);
    expect(all.list).toHaveLength(1);
    expect(all.list[0].createdAt).toBe(IMG_LIST_CREATE_TIME);
  });

  it('旧行为不变：常规 creation 路线仍照旧（creation 与 image_list 互不干扰）', () => {
    const all = walkChainAll(CHAIN_RESPONSE);
    expect(all.creations).toHaveLength(1);
    expect(all.list).toHaveLength(0);
  });
});
