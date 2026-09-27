import { describe, expect, it } from 'vitest';

import {
  displayConvTitle,
  filterDraftsByConv,
  isFallbackTitle,
  isWeakTitle,
  itemId,
  markFailed,
  queryLibrary,
  retainConv,
  retitleConv,
  statsOf,
  upsertDrafts,
  type Library,
} from '../src/core/library-store';
import { RANK } from '../src/core/extract/common';
import type { MediaDraft, MediaVariant } from '../src/core/types';

const CONV = '7f3a92c1-08b4';

function draft(overrides: Partial<MediaDraft> = {}): MediaDraft {
  const variants: MediaVariant[] = overrides.variants ?? [
    { url: 'https://v.douyinvod.com/a/raw.mp4', label: '无水印原片', rank: 100, isRaw: true },
    { url: 'https://p3-ibyteimg.com/cover.jpeg', label: '封面', rank: 10, isRaw: false },
  ];
  return {
    convId: CONV,
    convKind: 'chat',
    convTitle: '海底城市夜景',
    kind: 'video',
    fingerprint: 'vid:v0abc',
    variants,
    cover: 'https://p3-ibyteimg.com/cover.jpeg',
    meta: { ext: 'mp4' },
    state: 'raw',
    ...overrides,
  };
}

describe('主键与指纹', () => {
  it('主键 = convId::fingerprint（去重作用域 = 单个会话）', () => {
    expect(itemId(CONV, 'vid:v0abc')).toBe(`${CONV}::vid:v0abc`);
  });
});

describe('upsert：上游「重复条目」四重成因的对策', () => {
  it('同一指纹重复上报只产生一条记录，变体被归并', () => {
    let library: Library = {};
    const first = upsertDrafts(library, [draft()], { now: 1_000 });
    expect(first.added).toBe(1);
    library = first.library;

    const second = upsertDrafts(
      library,
      [
        draft({
          variants: [
            { url: 'https://v.douyinvod.com/a/raw.mp4', label: '无水印原片', rank: 100, isRaw: true },
            { url: 'https://v.douyinvod.com/a/1080.mp4', label: '1080p', rank: 40, isRaw: true },
            { url: 'https://v.douyinvod.com/a/720.mp4', label: '720p', rank: 40, isRaw: true },
          ],
          meta: { ext: 'mp4', label: '1080p', size: 39_200_000 },
        }),
      ],
      { now: 2_000 },
    );

    expect(second.added).toBe(0);
    expect(second.merged).toBe(1);
    expect(Object.keys(second.library)).toHaveLength(1);

    const item = second.library[itemId(CONV, 'vid:v0abc')];
    expect(item.variants).toHaveLength(4); // raw + 1080 + 720 + 封面
    expect(item.lastSeen).toBe(2_000);
    expect(item.firstSeen).toBe(1_000);
    expect(item.primary).toBe('https://v.douyinvod.com/a/raw.mp4');
    expect(item.meta.size).toBe(39_200_000);
  });

  it('SSE 增量反复推送同一资源不会新增条目', () => {
    let library: Library = {};
    for (let i = 0; i < 8; i++) {
      library = upsertDrafts(library, [draft()], { now: 1_000 + i }).library;
    }
    expect(Object.keys(library)).toHaveLength(1);
  });

  it('state 只会向更好的方向升级（thumb → raw）', () => {
    let library = upsertDrafts({}, [draft({ state: 'thumb', variants: [{ url: 'https://a.com/t.png', label: '缩略图', rank: 10, isRaw: false }] })], {
      now: 1,
    }).library;
    expect(library[itemId(CONV, 'vid:v0abc')].state).toBe('thumb');

    library = upsertDrafts(library, [draft({ state: 'raw' })], { now: 2 }).library;
    expect(library[itemId(CONV, 'vid:v0abc')].state).toBe('raw');

    // 反向不降级
    library = upsertDrafts(library, [draft({ state: 'thumb' })], { now: 3 }).library;
    expect(library[itemId(CONV, 'vid:v0abc')].state).toBe('raw');
  });

  it('不同会话的同一资源各留一条（去重作用域 = 会话内）', () => {
    const library = upsertDrafts({}, [draft(), draft({ convId: 'other-conv' })], { now: 1 }).library;
    expect(Object.keys(library)).toHaveLength(2);
  });
});

describe('「过滤掉纯缩略图项」开关', () => {
  const thumbDraft = draft({
    state: 'thumb',
    variants: [{ url: 'https://a.com/thumb.png', label: '缩略图', rank: 10, isRaw: false }],
  });

  it('开关开启时不收录纯缩略图项', () => {
    const result = upsertDrafts({}, [thumbDraft], { skipThumbOnly: true, now: 1 });
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(Object.keys(result.library)).toHaveLength(0);
  });

  it('开关关闭时照常收录', () => {
    const result = upsertDrafts({}, [thumbDraft], { skipThumbOnly: false, now: 1 });
    expect(result.added).toBe(1);
  });

  it('先只解析到缩略图（被跳过），后拿到原片时能正常入库', () => {
    let library = upsertDrafts({}, [thumbDraft], { skipThumbOnly: true, now: 1 }).library;
    expect(Object.keys(library)).toHaveLength(0);
    library = upsertDrafts(library, [draft()], { skipThumbOnly: true, now: 2 }).library;
    expect(Object.keys(library)).toHaveLength(1);
  });
});

describe('99 条上限 FIFO', () => {
  it('超出上限时淘汰 lastSeen 最旧的条目', () => {
    const drafts: MediaDraft[] = Array.from({ length: 105 }, (_, i) =>
      draft({ fingerprint: `vid:v${i}`, variants: [{ url: `https://a.com/${i}.mp4`, label: '无水印原片', rank: 100, isRaw: true }], meta: { ext: 'mp4' } }),
    );

    const result = upsertDrafts({}, drafts, { max: 99, now: 5_000 });
    expect(Object.keys(result.library)).toHaveLength(99);
    expect(result.evicted).toBe(6);
    // 最旧的 6 条（v0~v5）被淘汰
    expect(result.library[itemId(CONV, 'vid:v0')]).toBeUndefined();
    expect(result.library[itemId(CONV, 'vid:v104')]).toBeTruthy();
  });

  it('默认上限取自 LIMITS.LIBRARY_MAX = 99', () => {
    const drafts: MediaDraft[] = Array.from({ length: 100 }, (_, i) =>
      draft({ fingerprint: `vid:d${i}`, variants: [{ url: `https://a.com/d${i}.mp4`, label: '无水印原片', rank: 100, isRaw: true }] }),
    );
    const result = upsertDrafts({}, drafts, { now: 1 });
    expect(Object.keys(result.library)).toHaveLength(99);
  });
});

describe('失败标记', () => {
  it('markFailed 把状态改为 fail', () => {
    const library = upsertDrafts({}, [draft()], { now: 1 }).library;
    const next = markFailed(library, itemId(CONV, 'vid:v0abc'), 9_999);
    expect(next[itemId(CONV, 'vid:v0abc')].state).toBe('fail');
    expect(next[itemId(CONV, 'vid:v0abc')].lastSeen).toBe(9_999);
  });
});

describe('查询', () => {
  function buildLibrary(): Library {
    return upsertDrafts(
      {},
      [
        draft({ fingerprint: 'vid:v1', convTitle: '海底城市夜景' }),
        draft({
          fingerprint: 'iurl:https://p9-ibyteimg.com/img/ori-1',
          kind: 'image',
          convTitle: '海底城市夜景',
          variants: [{ url: 'https://p9-ibyteimg.com/img/ori-1.jpeg', label: '无水印原片', rank: 100, isRaw: true }],
        }),
        draft({
          fingerprint: 'vid:v2',
          convId: 'other-conv',
          convTitle: '机械蜂鸟特写',
          variants: [
            { url: 'https://v.douyinvod.com/b/raw.mp4', label: '无水印原片', rank: 100, isRaw: true },
            { url: 'https://v.douyinvod.com/b/1080.mp4', label: '1080p', rank: 40, isRaw: true },
          ],
        }),
      ],
      { now: 1_000 },
    ).library;
  }

  it('计数与状态统计', () => {
    const counts = statsOf(buildLibrary());
    expect(counts.total).toBe(3);
    expect(counts.video).toBe(2);
    expect(counts.image).toBe(1);
    expect(counts.raw).toBe(3);
  });

  it('按会话分组（默认）', () => {
    const result = queryLibrary(buildLibrary(), { filter: 'all', query: '', sort: 'newest', groupBy: 'conv' });
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((group) => group.title).sort()).toEqual(['机械蜂鸟特写', '海底城市夜景']);
  });

  it('按类型分组', () => {
    const result = queryLibrary(buildLibrary(), { filter: 'all', query: '', sort: 'newest', groupBy: 'type' });
    expect(result.groups.map((group) => group.key).sort()).toEqual(['image', 'video']);
  });

  it('筛选 + 搜索', () => {
    expect(queryLibrary(buildLibrary(), { filter: 'video', query: '', sort: 'newest', groupBy: 'conv' }).counts.total).toBe(3);
    expect(queryLibrary(buildLibrary(), { filter: 'image', query: '', sort: 'newest', groupBy: 'conv' }).filteredTotal).toBe(1);
    expect(queryLibrary(buildLibrary(), { filter: 'all', query: '蜂鸟', sort: 'newest', groupBy: 'conv' }).filteredTotal).toBe(1);
    expect(queryLibrary(buildLibrary(), { filter: 'all', query: '不存在的关键词', sort: 'newest', groupBy: 'conv' }).groups).toHaveLength(0);
  });

  it('「合并 N 条重复」= 变体归并掉的条数', () => {
    const result = queryLibrary(buildLibrary(), { filter: 'all', query: '', sort: 'newest', groupBy: 'conv' });
    const hummer = result.groups.find((group) => group.title === '机械蜂鸟特写');
    expect(hummer?.deduped).toBe(1);
    const ocean = result.groups.find((group) => group.title === '海底城市夜景');
    expect(ocean?.deduped).toBe(1); // 视频的封面变体
  });

  it('按体积排序', () => {
    const library = upsertDrafts(
      {},
      [
        draft({ fingerprint: 'vid:small', meta: { ext: 'mp4', size: 1_000 } }),
        draft({
          fingerprint: 'vid:big',
          meta: { ext: 'mp4', size: 90_000_000 },
          variants: [{ url: 'https://a.com/big.mp4', label: '无水印原片', rank: 100, isRaw: true }],
        }),
      ],
      { now: 1 },
    ).library;
    const result = queryLibrary(library, { filter: 'all', query: '', sort: 'largest', groupBy: 'conv' });
    const items = result.groups.flatMap((group) => group.items);
    expect(items[0].meta.size).toBe(90_000_000);
  });
});

describe('会话作用域（第四轮：资源库只针对当前激活的对话）', () => {
  it('isFallbackTitle 只把「豆包对话 / 豆包对话 <id>」判为兜底', () => {
    expect(isFallbackTitle('')).toBe(true);
    expect(isFallbackTitle('豆包对话')).toBe(true);
    expect(isFallbackTitle('豆包对话 38443981')).toBe(true);
    expect(isFallbackTitle('0924_古装战争史诗视频生成')).toBe(false);
    expect(isFallbackTitle('海底城市夜景')).toBe(false);
    // 带「豆包对话」前缀但不是纯兜底形态的，视为真实标题
    expect(isFallbackTitle('豆包对话记录整理')).toBe(false);
  });

  it('retainConv 只留下指定会话；无变化时原样返回', () => {
    const library = upsertDrafts(
      {},
      [draft({ convId: 'a', fingerprint: 'vid:a1' }), draft({ convId: 'b', fingerprint: 'vid:b1' })],
      { now: 1 },
    ).library;
    const scoped = retainConv(library, 'a');
    expect(Object.keys(scoped)).toEqual([itemId('a', 'vid:a1')]);
    // 已经只有该会话 → 不需要产生新对象（调用方据此避免多余落盘）
    expect(retainConv(scoped, 'a')).toBe(scoped);
  });

  it('retainConv 收到空会话 ID 时不做裁剪（拿不到会话不该销毁数据）', () => {
    const library = upsertDrafts({}, [draft({ convId: 'a' })], { now: 1 }).library;
    expect(retainConv(library, '')).toBe(library);
  });

  it('displayConvTitle 只把弱标题降级显示，真实标题原样返回', () => {
    expect(displayConvTitle('0925_AI视频提示词运镜分析与修改')).toBe('0925_AI视频提示词运镜分析与修改');
    // 兜底文案统一为「豆包-AI 智能助手」（第四轮用户拍板，不再带会话 ID）
    expect(displayConvTitle('')).toBe('豆包-AI 智能助手');
    expect(displayConvTitle(undefined)).toBe('豆包-AI 智能助手');
    expect(displayConvTitle('豆包对话 38443981')).toBe('豆包-AI 智能助手');
    // 站点通用标题也是「弱标题」——不许原样显示（实测分享页就挂上了它）
    expect(displayConvTitle('豆包 - 字节跳动旗下 AI 智能助手')).toBe('豆包-AI 智能助手');
  });

  it('isWeakTitle：兜底值与站点通用名都算弱标题', () => {
    expect(isWeakTitle('')).toBe(true);
    expect(isWeakTitle('豆包对话 38443981')).toBe(true);
    expect(isWeakTitle('豆包 - 字节跳动旗下 AI 智能助手')).toBe(true);
    expect(isWeakTitle('豆包')).toBe(true);
    expect(isWeakTitle('超写实武侠CG打斗视频生成与呈现')).toBe(false);
  });

  it('retitleConv 拒绝弱标题（不把通用标题写进资源库），但接受真实标题', () => {
    const library = upsertDrafts({}, [draft({ convTitle: '海底城市夜景' })], { now: 1 }).library;
    expect(retitleConv(library, CONV, '豆包 - 字节跳动旗下 AI 智能助手')).toBe(library);
    expect(retitleConv(library, CONV, '豆包对话 38443981')).toBe(library);

    const renamed = retitleConv(library, CONV, '超写实武侠CG打斗视频生成与呈现');
    expect(renamed[itemId(CONV, 'vid:v0abc')].convTitle).toBe('超写实武侠CG打斗视频生成与呈现');
  });

  it('upsertDrafts：真实标题能覆盖已写入的站点通用标题', () => {
    let library = upsertDrafts({}, [draft({ convTitle: '豆包 - 字节跳动旗下 AI 智能助手' })], { now: 1 }).library;
    library = upsertDrafts(library, [draft({ convTitle: '超写实武侠CG打斗视频生成与呈现' })], { now: 2 }).library;
    expect(library[itemId(CONV, 'vid:v0abc')].convTitle).toBe('超写实武侠CG打斗视频生成与呈现');

    // 反向：通用标题不能把真实标题顶掉
    library = upsertDrafts(library, [draft({ convTitle: '豆包 · 你的 AI 智能助手' })], { now: 3 }).library;
    expect(library[itemId(CONV, 'vid:v0abc')].convTitle).toBe('超写实武侠CG打斗视频生成与呈现');
  });

  it('retitleConv 批量刷新该会话所有条目的标题，不动别的会话', () => {
    const library = upsertDrafts(
      {},
      [
        draft({ convId: 'a', convTitle: '豆包对话 38443981', fingerprint: 'vid:a1' }),
        draft({ convId: 'a', convTitle: '豆包对话 38443981', fingerprint: 'vid:a2', variants: [{ url: 'https://a.com/a2.mp4', label: '无水印原片', rank: 100, isRaw: true }] }),
        draft({ convId: 'b', convTitle: '机械蜂鸟特写', fingerprint: 'vid:b1' }),
      ],
      { now: 1 },
    ).library;

    const next = retitleConv(library, 'a', '0925_AI视频提示词运镜分析与修改');
    expect(next[itemId('a', 'vid:a1')].convTitle).toBe('0925_AI视频提示词运镜分析与修改');
    expect(next[itemId('a', 'vid:a2')].convTitle).toBe('0925_AI视频提示词运镜分析与修改');
    expect(next[itemId('b', 'vid:b1')].convTitle).toBe('机械蜂鸟特写');
    // 标题已一致 → 原样返回
    expect(retitleConv(next, 'a', '0925_AI视频提示词运镜分析与修改')).toBe(next);
  });

  it('filterDraftsByConv 丢弃异会话草稿（切走后才到达的响应）', () => {
    const drafts = [draft({ convId: 'a' }), draft({ convId: 'b', fingerprint: 'vid:b1' })];
    expect(filterDraftsByConv(drafts, 'a').map((d) => d.convId)).toEqual(['a']);
    // 会话未知时不臆断
    expect(filterDraftsByConv(drafts, '')).toHaveLength(2);
  });

  it('upsertDrafts：真实标题能覆盖已写入的兜底标题（反过来的永不发生）', () => {
    let library = upsertDrafts({}, [draft({ convTitle: '豆包对话 38443981' })], { now: 1 }).library;
    expect(library[itemId(CONV, 'vid:v0abc')].convTitle).toBe('豆包对话 38443981');

    library = upsertDrafts(library, [draft({ convTitle: '0925_AI视频提示词运镜分析与修改' })], { now: 2 }).library;
    expect(library[itemId(CONV, 'vid:v0abc')].convTitle).toBe('0925_AI视频提示词运镜分析与修改');

    // 兜底标题不能把真实标题顶掉
    library = upsertDrafts(library, [draft({ convTitle: '豆包对话 38443981' })], { now: 3 }).library;
    expect(library[itemId(CONV, 'vid:v0abc')].convTitle).toBe('0925_AI视频提示词运镜分析与修改');

    // 已有真实标题时，另一个真实标题也不覆盖（以首次解析到的为准，保持稳定）
    library = upsertDrafts(library, [draft({ convTitle: '另一个真实标题' })], { now: 4 }).library;
    expect(library[itemId(CONV, 'vid:v0abc')].convTitle).toBe('0925_AI视频提示词运镜分析与修改');
  });
});

describe('历史会话（chain）修复路径的端到端合并（docs/03 P0-1 / P0-2）', () => {
  // ① chain 响应只给出候选地址 + vid → 草稿为 pending（rank 直接取自契约，避免测试与实现漂移）
  const pending: MediaDraft = {
    convId: CONV,
    convKind: 'chat',
    convTitle: '海底城市夜景',
    kind: 'video',
    fingerprint: 'vid:v0d69cg10004daqj77i7dld84jf8qsjg',
    vid: 'v0d69cg10004daqj77i7dld84jf8qsjg',
    state: 'pending',
    cover: null,
    variants: [
      {
        url: 'https://v26-vdl.doubao.com/be51948a/video.mp4?lr=video_gen_no_watermark',
        label: '720p',
        rank: RANK.quality,
        isRaw: false,
      },
      {
        url: 'https://vas-lf-x.snssdk.com/video/fplay/x',
        label: '备选播放源（带水印）',
        rank: RANK.fallback,
        isRaw: false,
      },
    ],
    meta: { ext: 'mp4', duration: 24.065 },
  };

  // ② vid 三步 API 成功后补一条高清原片变体（page/hook.ts::enrichWithResolvedVid 的同构产物）
  const resolvedUrl = 'https://v26-vdl.doubao.com/samantha/original.mp4?lr=unwatermarked';
  const enriched: MediaDraft = {
    ...pending,
    state: 'raw',
    variants: [{ url: resolvedUrl, label: '无水印原片（高清）', rank: RANK.resolved, isRaw: true }, ...pending.variants],
  };

  it('pending 先入库，拿到原片后合并为 raw 且 primary 升级为原片', () => {
    const first = upsertDrafts({}, [pending], { now: 1 });
    expect(first.added).toBe(1);
    expect(first.library[itemId(CONV, pending.fingerprint)].state).toBe('pending');
    // 没有 isRaw 变体时 primary 只能落在候选地址上（豆包清晰度地址优先于 fallback_api）
    // —— 但 state 是 pending，UI 不会把它标成「无水印原片」
    expect(first.library[itemId(CONV, pending.fingerprint)].primary).toContain('v26-vdl.doubao.com');

    const second = upsertDrafts(first.library, [enriched], { now: 2 });
    expect(second.added).toBe(0);
    expect(second.merged).toBe(1);

    const item = second.library[itemId(CONV, pending.fingerprint)];
    expect(item.state).toBe('raw');
    expect(item.primary).toBe(resolvedUrl);
    // 候选地址仍然保留为变体（可作末位兜底），但不影响 primary
    expect(item.variants.some((v) => v.url.includes('vas-lf-x.snssdk.com'))).toBe(true);
    expect(item.meta.duration).toBe(24.065);
  });

  it('重复推送同一 vid 不会产生第二条记录', () => {
    const once = upsertDrafts({}, [pending, enriched], { now: 1 });
    expect(Object.keys(once.library)).toHaveLength(1);
    expect(once.added).toBe(1);
    expect(once.merged).toBe(1);
  });

  it('「过滤掉纯缩略图项」不会误伤 pending（否则历史会话永远进不来）', () => {
    const result = upsertDrafts({}, [pending], { now: 1, skipThumbOnly: true });
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
  });
});
