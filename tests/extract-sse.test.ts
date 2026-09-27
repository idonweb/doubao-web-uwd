import { describe, expect, it } from 'vitest';

import { pickPrimary } from '../src/core/media-url';
import { parseLooseJson, parseVideoModel, rawFromCreation, toDraft, toDrafts } from '../src/core/extract/common';
import { extractSseRaw, parseSseEventData, splitSseEvents } from '../src/core/extract/sse';
import type { DraftContext } from '../src/core/extract/common';
import {
  IMAGE_PREVIEW,
  IMAGE_RAW,
  IMAGE_THUMB,
  SSE_RESPONSE,
  SSE_RESPONSE_REPEATED,
  VIDEO_ORI_RAW,
  VIDEO_THUMB,
} from './fixtures/samples';

const CTX: DraftContext = { convId: '7f3a92c1-08b4', convKind: 'chat', convTitle: '海底城市夜景' };

describe('SSE 事件切分与解析', () => {
  it('按 \\n\\n 切分事件', () => {
    expect(splitSseEvents('a\n\nb\n\nc')).toEqual(['a', 'b', 'c']);
  });

  it('只解析 data: 行，丢弃 [DONE]', () => {
    expect(parseSseEventData('event: message\ndata: {"a":1}')).toEqual({ a: 1 });
    expect(parseSseEventData('data: [DONE]')).toBeNull();
    expect(parseSseEventData('data: not-json')).toBeNull();
    expect(parseSseEventData('event: ping')).toBeNull();
  });
});

describe('extractSseRaw', () => {
  const raws = extractSseRaw(SSE_RESPONSE);

  it('从真实结构的响应里抽出视频与图片素材', () => {
    expect(raws).toHaveLength(3);
    const video = raws.find((raw) => raw.kind === 'video');
    const image = raws.find((raw) => raw.kind === 'image');
    expect(video).toBeTruthy();
    expect(image).toBeTruthy();
    expect(video?.vid).toBe('v0abc123def456');
    expect(video?.raw).toBe(VIDEO_ORI_RAW);
    expect(video?.thumb).toBe(VIDEO_THUMB);
    expect(video?.duration).toBe(15);
    expect(image?.raw).toBe(IMAGE_RAW);
    expect(image?.preview).toBe(IMAGE_PREVIEW);
    expect(image?.thumb).toBe(IMAGE_THUMB);
  });

  it('宽高：图片取自子对象（image_ori_raw 等），视频兼容数字字符串（2026-09-27 实测，docs/03 §12）', () => {
    const video = raws.find((raw) => raw.kind === 'video');
    const image = raws.find((raw) => raw.kind === 'image');
    // fixture 里 image 顶层没有宽高，只能从子对象取到
    expect(image?.width).toBe(2720);
    expect(image?.height).toBe(1520);
    // fixture 里 video.width 是字符串 '1080'（实测站点类型不稳定），asNumber 要放行
    expect(video?.width).toBe(1080);
    expect(video?.height).toBe(1920);
    // 实测站点不给 size —— 宁缺勿假，让它缺省
    expect(image?.size).toBeUndefined();
    expect(video?.size).toBeUndefined();
  });

  it('无关事件与坏 JSON 不影响解析', () => {
    expect(extractSseRaw('')).toEqual([]);
    expect(extractSseRaw('garbage without creation_block')).toEqual([]);
    expect(extractSseRaw('data: {bad json}\n\n')).toEqual([]);
  });

  it('rawFromCreation 对空对象返回 null', () => {
    expect(rawFromCreation({}, 'sse')).toBeNull();
    expect(rawFromCreation(null, 'sse')).toBeNull();
  });

  it('兼容 vid / video_id 两种字段名，并读取 video_duration 与 fallback_api', () => {
    const raw = rawFromCreation(
      {
        video: {
          video_id: 'v0fromVideoId',
          video_duration: 24.5,
          fallback_api: 'https://vas-lf-x.snssdk.com/video/fplay/x?logo_type=video_gen_watermark_dyn',
        },
      },
      'chain',
    );
    expect(raw?.vid).toBe('v0fromVideoId');
    expect(raw?.duration).toBe(24.5);
    expect(raw?.fallbackApi).toContain('vas-lf-x.snssdk.com');
  });
});

describe('parseLooseJson（多层转义 JSON）', () => {
  it('普通 JSON 字符串直接解析', () => {
    expect(parseLooseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseLooseJson('[1,2]')).toEqual([1, 2]);
  });

  it('解开被转义一层的 JSON（chain 的 video_model 实测形态）', () => {
    expect(parseLooseJson('{\\"a\\":\\"b\\"}')).toEqual({ a: 'b' });
  });

  it('解开被转义两层的 JSON', () => {
    const plain = '{"a":1}';
    const level1 = plain.replace(/"/g, '\\"'); // {\"a\":1}
    const level2 = level1.replace(/"/g, '\\"'); // {\\"a\\":1}
    expect(plain).not.toBe(level1);
    expect(level1).not.toBe(level2);
    expect(parseLooseJson(plain)).toEqual({ a: 1 });
    expect(parseLooseJson(level1)).toEqual({ a: 1 });
    expect(parseLooseJson(level2)).toEqual({ a: 1 });
  });

  it('非 JSON 字符串与已解析对象', () => {
    expect(parseLooseJson('not json')).toBeUndefined();
    expect(parseLooseJson('https://v.douyinvod.com/x.mp4')).toBeUndefined();
    expect(parseLooseJson({ a: 1 })).toEqual({ a: 1 });
    expect(parseLooseJson(undefined)).toBeUndefined();
  });
});

describe('video_model 解析', () => {
  it('支持对象与数组两种 video_list 形态', () => {
    const entries = parseVideoModel(
      JSON.stringify({
        video_list: {
          hd: { main_url: btoa('https://v.douyinvod.com/hd.mp4'), definition: '1080p' },
        },
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://v.douyinvod.com/hd.mp4');
    expect(entries[0].label).toBe('1080p');
  });

  it('坏 JSON 返回空数组', () => {
    expect(parseVideoModel('not json')).toEqual([]);
    expect(parseVideoModel(undefined)).toEqual([]);
  });
});

describe('toDrafts：上游 6~8 条重复记录 → 1 条', () => {
  const drafts = toDrafts(extractSseRaw(SSE_RESPONSE), CTX);

  it('只有封面图的「视频」被丢弃（成因 3）', () => {
    expect(drafts).toHaveLength(2);
    expect(drafts.every((item) => item.variants.length >= 1)).toBe(true);
  });

  it('视频条目：指纹用 vid，多 URL 变体归并进同一条', () => {
    const video = drafts.find((item) => item.kind === 'video');
    expect(video?.fingerprint).toBe('vid:v0abc123def456');
    expect(video?.state).toBe('raw');
    // 原片 + download_url 改写后的候选 + 1080p + 720p + 封面
    const urls = video?.variants.map((variant) => variant.url) ?? [];
    expect(urls).toContain(VIDEO_ORI_RAW);
    expect(urls).toContain(VIDEO_THUMB);
    expect(urls.some((url) => url.includes('1080'))).toBe(true);
    expect(urls.some((url) => url.includes('720'))).toBe(true);
    expect(video?.variants[0].isRaw).toBe(true);
    expect(video?.variants[0].url).toBe(VIDEO_ORI_RAW);
  });

  it('图片条目：指纹用去掉查询参数的原片 URL', () => {
    const image = drafts.find((item) => item.kind === 'image');
    expect(image?.fingerprint).toBe(`iurl:${IMAGE_RAW.split('?')[0]}`);
    expect(image?.state).toBe('raw');
    expect(pickPrimary(image?.variants ?? [])).toBe(IMAGE_RAW);
    expect(image?.cover).toBe(IMAGE_THUMB);
  });

  it('meta.dimsPreview：视频（预览规格）打标、图片（真实规格）不打', () => {
    const video = drafts.find((item) => item.kind === 'video');
    const image = drafts.find((item) => item.kind === 'image');
    expect(video?.meta.dimsPreview).toBe(true);
    expect(image?.meta.dimsPreview).toBeUndefined();
  });

  it('清晰度标签不来自 video_model 的候选地址（`docs/03` §12.7）', () => {
    const video = drafts.find((item) => item.kind === 'video');
    // 候选变体上仍保留 definition，但它描述的是另一个文件，不能当条目的清晰度
    expect(video?.variants.some((variant) => variant.label === '1080p')).toBe(true);
    expect(video?.meta.label).toBeUndefined();
  });

  it('重复推送同一视频产生完全相同的草稿（交由 upsert 合并）', () => {
    const repeated = toDrafts(extractSseRaw(SSE_RESPONSE_REPEATED), CTX);
    expect(repeated).toHaveLength(2);
    expect(repeated[0].fingerprint).toBe(repeated[1].fingerprint);
  });

  it('无 vid 且无 ori_raw 的视频按 J3 不入库（宁缺勿假）', () => {
    expect(
      toDraft({ kind: 'video', downloadUrl: 'https://v.douyinvod.com/x/video.mp4?lr=video_gen_watermark_dyn' }, CTX),
    ).toBeNull();
    // DOM 兜底那条「改写 lr 猜地址」也一样丢弃
    expect(toDraft({ kind: 'video', origin: 'dom', raw: 'https://v.douyinvod.com/x/video.mp4' }, CTX)).toBeNull();
  });

  it('无 vid 但有站点给的 ori_raw（sse/chain/thread）仍然入库', () => {
    const item = toDraft({ kind: 'video', origin: 'thread', raw: VIDEO_ORI_RAW }, CTX);
    expect(item?.fingerprint).toBe(`vurl:${VIDEO_ORI_RAW.split('?')[0]}`);
    expect(item?.state).toBe('raw');
  });

  it('只有 vid 的视频草稿状态为 pending（等三步 API）', () => {
    const item = toDraft({ kind: 'video', vid: 'v0pending', thumb: VIDEO_THUMB }, CTX);
    expect(item?.state).toBe('pending');
    expect(item?.fingerprint).toBe('vid:v0pending');
  });
});
