import { describe, expect, it } from 'vitest';

import { toDrafts } from '../src/core/extract/common';
import { pickPrimary } from '../src/core/media-url';
import {
  describeTitleFields,
  extractThreadRaw,
  findShareInfo,
  findTitleByKey,
  isShareInfo,
  parseFnArgs,
  shareTitle,
} from '../src/core/extract/thread';
import {
  FN_ARGS_DIRECT,
  FN_ARGS_ROUTER,
  FN_ARGS_UNRELATED,
  IMAGE_RAW,
  SHARE_INFO,
  THREAD_MESSAGE_CREATE_TIME,
} from './fixtures/samples';

const CTX = { convId: 'w8kD2mQv7p', convKind: 'thread' as const, convTitle: '分享 · 赛博朋克街道' };

describe('data-fn-args 的两种结构', () => {
  it('结构 ①：["thread_x/page","shareInfo",{...}]', () => {
    const info = findShareInfo(parseFnArgs(FN_ARGS_DIRECT));
    expect(info).toBeTruthy();
    expect(isShareInfo(info)).toBe(true);
    expect(shareTitle(info, '')).toBe('分享 · 赛博朋克街道');
  });

  it('结构 ②：routerDataFnArgs 里再套一层 JSON 字符串', () => {
    const info = findShareInfo(parseFnArgs(FN_ARGS_ROUTER));
    expect(info).toBeTruthy();
    expect(isShareInfo(info)).toBe(true);
  });

  it('无关脚本 / 坏 JSON 返回 null', () => {
    expect(findShareInfo(parseFnArgs(FN_ARGS_UNRELATED))).toBeNull();
    expect(findShareInfo(parseFnArgs('{not json'))).toBeNull();
    expect(findShareInfo(parseFnArgs(null))).toBeNull();
    expect(findShareInfo(undefined)).toBeNull();
    expect(parseFnArgs('{"not":"array"}')).toBeNull();
  });

  it('标题取不到时回退到传入的默认值', () => {
    expect(shareTitle({ data: {} }, 'Document Title')).toBe('Document Title');
  });
});

describe('分享页标题的路径扩容（第四轮修正 docs/03 §9.9）', () => {
  it('按候选路径顺序取：share_info.title 优先', () => {
    const info = { data: { share_info: { title: '超写实武侠CG打斗视频生成与呈现' } } };
    expect(shareTitle(info, 'doc')).toBe('超写实武侠CG打斗视频生成与呈现');
  });

  it('补上的候选路径也能命中（share_title / name / message_snapshot.title / data.title）', () => {
    expect(shareTitle({ data: { share_info: { share_title: 'A' } } }, '')).toBe('A');
    expect(shareTitle({ data: { share_info: { name: 'B' } } }, '')).toBe('B');
    expect(shareTitle({ data: { message_snapshot: { title: 'C' } } }, '')).toBe('C');
    expect(shareTitle({ data: { message_snapshot: { share_info: { title: 'D' } } } }, '')).toBe('D');
    expect(shareTitle({ data: { title: 'E' } }, '')).toBe('E');
  });

  it('显式路径都空时，靠 findTitleByKey 在结构里按 key 名兜底', () => {
    const info = { data: { share_info: { meta: { share_title: '兜底找到的标题' } } } };
    expect(shareTitle(info, 'doc')).toBe('兜底找到的标题');
    expect(findTitleByKey(info)).toBe('兜底找到的标题');
  });

  it('findTitleByKey 不把 URL / JSON / 超长文本当标题', () => {
    expect(findTitleByKey({ data: { title: 'https://www.doubao.com/thread/x' } })).toBe('');
    expect(findTitleByKey({ data: { title: '{"a":1}' } })).toBe('');
    expect(findTitleByKey({ data: { title: 'x'.repeat(300) } })).toBe('');
    expect(findTitleByKey(null)).toBe('');
    expect(findTitleByKey({ data: {} })).toBe('');
  });

  it('findTitleByKey 广度优先：浅层的 title 先于深层命中', () => {
    const info = { data: { title: '浅层', deep: { nested: { title: '深层' } } } };
    expect(findTitleByKey(info)).toBe('浅层');
  });

  it('describeTitleFields 列出结构里所有含 title / name 的字段路径（校准用）', () => {
    const info = {
      data: {
        share_info: { title: '真标题', cover: { name: 'cover.png' } },
        message_snapshot: { message_list: [{ content_block: [{ name: 'block' }] }] },
      },
    };
    const lines = describeTitleFields(info);
    expect(lines).toContain('data.share_info.title = 真标题');
    expect(lines.some((line) => line.startsWith('data.share_info.cover.name'))).toBe(true);
    expect(lines.some((line) => line.includes('message_list[0]'))).toBe(true);
  });

  it('describeTitleFields 在没有任何 title / name 字段时返回空数组', () => {
    expect(describeTitleFields({ data: { message_snapshot: { message_list: [] } } })).toEqual([]);
  });
});

describe('extractThreadRaw', () => {
  const raws = extractThreadRaw(SHARE_INFO);

  it('一条 creation 只产出一条素材（视频优先，不再把封面拆成独立条目）', () => {
    expect(raws).toHaveLength(2);
    expect(raws.map((raw) => raw.kind).sort()).toEqual(['image', 'video']);
  });

  it('视频没有 video_ori_raw 时靠 vid + 多清晰度兜底', () => {
    const video = raws.find((raw) => raw.kind === 'video');
    expect(video?.vid).toBe('v0threadabc12345');
    expect(video?.raw).toBeUndefined();
    expect(video?.videoModel).toBeTruthy();
  });

  it('图片素材带上原片与缩略图', () => {
    const image = raws.find((raw) => raw.kind === 'image');
    expect(image?.raw).toBe(IMAGE_RAW);
    expect(image?.thumb).toBeTruthy();
  });

  it('转成草稿：视频靠 vid + 站点自带的无水印清晰度、图片为 raw', () => {
    const drafts = toDrafts(raws, CTX);
    expect(drafts).toHaveLength(2);
    const video = drafts.find((item) => item.kind === 'video');
    const image = drafts.find((item) => item.kind === 'image');
    expect(video?.fingerprint).toBe('vid:v0threadabc12345');
    expect(video?.state).toBe('raw');
    expect(video?.convKind).toBe('thread');
    // 「无水印原片」只能来自站点自己声明无水印的地址（video_model 里的 lr=unwatermarked）
    expect(pickPrimary(video?.variants ?? [])).toContain('lr=unwatermarked');
    expect(video?.variants[0].isRaw).toBe(true);
    // 而 download_url 那条是「我们自己改写出来的候选」，不得被标成原片
    const candidate = video?.variants.find((variant) => variant.label === '候选地址（参数改写）');
    expect(candidate?.url).toContain('lr=video_gen_no_watermark');
    expect(candidate?.isRaw).toBe(false);
    expect(image?.state).toBe('raw');
  });

  it('分享页消息的 create_time 也会写进草稿（视频与图片都有，毫秒）', () => {
    const drafts = toDrafts(raws, CTX);
    expect(drafts.map((draft) => draft.meta.createdAt)).toEqual([
      THREAD_MESSAGE_CREATE_TIME * 1000,
      THREAD_MESSAGE_CREATE_TIME * 1000,
    ]);
  });

  it('数据缺失时返回空数组，不抛异常', () => {
    expect(extractThreadRaw({})).toEqual([]);
    expect(extractThreadRaw({ data: { message_snapshot: { message_list: [] } } })).toEqual([]);
    expect(extractThreadRaw(null)).toEqual([]);
  });
});
