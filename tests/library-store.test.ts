import { describe, expect, it } from 'vitest';

import {
  displayConvTitle,
  filterDraftsByConv,
  hasCopyableDirectLink,
  isFallbackTitle,
  isWeakTitle,
  itemId,
  markExpired,
  markFailed,
  primaryIsRaw,
  queryLibrary,
  rawReady,
  sizeForNow,
  retainConv,
  retitleConv,
  statsOf,
  upsertDrafts,
  type Library,
} from '../src/core/library-store';
import { RANK } from '../src/core/extract/common';
import type { MediaDraft, MediaItem, MediaVariant } from '../src/core/types';

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
  it('markFailed 把状态改为 fail，且不刷新 lastSeen（失败不是「资源出现」）', () => {
    const library = upsertDrafts({}, [draft()], { now: 1 }).library;
    const next = markFailed(library, itemId(CONV, 'vid:v0abc'));
    expect(next[itemId(CONV, 'vid:v0abc')].state).toBe('fail');
    expect(next[itemId(CONV, 'vid:v0abc')].lastSeen).toBe(1);
  });
});

describe('原片已超期（2026-09-27 Finding C；2026-09-28 第十轮：改为可撤销）', () => {
  it('markExpired：state → fail + meta.expired，不存在的条目原样返回（且不刷新 lastSeen）', () => {
    const library = upsertDrafts({}, [draft({ state: 'pending' })], { now: 1 }).library;
    const next = markExpired(library, CONV, 'vid:v0abc');
    const item = next[itemId(CONV, 'vid:v0abc')];
    expect(item.state).toBe('fail');
    expect(item.meta.expired).toBe(true);
    expect(item.lastSeen).toBe(1);
    expect(markExpired(library, CONV, 'vid:不存在')).toBe(library);
  });

  it('超期条目不被后续 pending 草稿升回「解析中」（chain 重放每轮都会带来同一 vid）', () => {
    const library = upsertDrafts({}, [draft({ state: 'pending' })], { now: 1 }).library;
    const expired = markExpired(library, CONV, 'vid:v0abc');
    const again = upsertDrafts(expired, [draft({ state: 'pending' })], { now: 3 });
    const item = again.library[itemId(CONV, 'vid:v0abc')];
    expect(item.state).toBe('fail');
    expect(item.meta.expired).toBe(true);
  });

  it('拿到原片（raw）的草稿可以给超期条目翻案：清掉 meta.expired 并升回 raw', () => {
    const id = itemId(CONV, 'vid:v0abc');
    const library = upsertDrafts({}, [draft({ state: 'pending' })], { now: 1 }).library;
    const expired = markExpired(library, CONV, 'vid:v0abc');

    const revived = upsertDrafts(expired, [draft({ state: 'raw' })], { now: 3 });
    expect(revived.library[id].state).toBe('raw');
    expect(revived.library[id].meta.expired).toBeUndefined();
  });

  it('markExpired 不覆盖已经拿到原片的条目（迟到的失败通知不得压过正证据）', () => {
    const library = upsertDrafts({}, [draft({ state: 'raw' })], { now: 1 }).library;
    expect(markExpired(library, CONV, 'vid:v0abc')).toBe(library);
  });
});

describe('排序：用站点真实生成时间 meta.createdAt（2026-09-28 第十轮）', () => {
  const T = (iso: string) => new Date(iso).getTime();

  /** 三条视频：新（9-27 22:54） / 旧（6-24） / 未知（已超期，树里没有 → 无 createdAt） */
  function build(): Library {
    return upsertDrafts(
      {},
      [
        draft({ fingerprint: 'vid:old', meta: { ext: 'mp4', createdAt: T('2026-06-24T12:00:00+08:00') } }),
        draft({ fingerprint: 'vid:new', meta: { ext: 'mp4', createdAt: T('2026-09-27T22:54:00+08:00') } }),
        draft({ fingerprint: 'vid:none', meta: { ext: 'mp4' } }),
      ],
      { now: T('2026-09-28T08:10:00+08:00') },
    ).library;
  }

  const ids = (sort: 'newest' | 'oldest') =>
    queryLibrary(build(), { filter: 'all', query: '', sort, groupBy: 'conv' }).groups[0].items.map((i) => i.fingerprint);

  it('最新：真实生成时间倒序；拿不到时间的排末尾（不编造）', () => {
    expect(ids('newest')).toEqual(['vid:new', 'vid:old', 'vid:none']);
  });

  it('最早：真实生成时间正序（拿不到的同样排末尾，不会冒充「最旧」）', () => {
    expect(ids('oldest')).toEqual(['vid:old', 'vid:new', 'vid:none']);
  });

  it('「判定超期 / 下载失败」不再把老条目顶到最前（lastSeen 不再参与主排序）', () => {
    const lib = build();
    const id = itemId(CONV, 'vid:old');
    // 给「最旧」的条目打上超期 + 失败：旧实现会把它顶到第一位
    const after = markFailed(markExpired(lib, CONV, 'vid:old'), id);
    const order = queryLibrary(after, { filter: 'all', query: '', sort: 'newest', groupBy: 'conv' }).groups[0].items;
    expect(order.map((i) => i.fingerprint)).toEqual(['vid:new', 'vid:old', 'vid:none']);
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

describe('体积与主地址的一致性（2026-09-28 实机踩坑的回归锁）', () => {
  const rawVariant = (url: string): MediaVariant => ({ url, label: '无水印原片', rank: 100, isRaw: true });

  it('primary 换地址（候选流 → 真原片）→ 旧的 size 作废，等兜底重新实测', () => {
    const id = itemId(CONV, 'vid:v0abc');
    // 第一次入库：只有候选地址（rank 60，非原片），体积量的是**候选那个文件**
    const candidate: MediaVariant = {
      url: 'https://v26-vdl.doubao.com/candidate.mp4',
      label: '原始下载地址',
      rank: 60,
      isRaw: false,
    };
    const first = upsertDrafts(
      {},
      [draft({ state: 'pending', variants: [candidate], meta: { ext: 'mp4', size: 1_204_451 } })],
      { now: 1 },
    ).library;
    expect(first[id].primary).toBe('https://v26-vdl.doubao.com/candidate.mp4');
    expect(first[id].meta.size).toBe(1_204_451);

    // 第二次：同一个指纹，解析出了真原片（rank 100）→ 主地址换成它，而本次**没带** size
    const second = upsertDrafts(
      first,
      [draft({ variants: [rawVariant('https://v.douyinvod.com/a/raw.mp4')], meta: { ext: 'mp4' } })],
      { now: 2 },
    ).library;
    expect(second[id].primary).toBe('https://v.douyinvod.com/a/raw.mp4');
    expect(second[id].meta.size).toBeUndefined(); // 旧数字不再属于新文件 → 清掉，§37 起由 bg 对新地址自动重测
  });

  it('primary 换地址但本次草稿自带 size（视频解析结果同批到达）→ 保留新 size', () => {
    const first = upsertDrafts({}, [draft({ meta: { ext: 'mp4', size: 1_000 } })], { now: 1 }).library;
    const id = itemId(CONV, 'vid:v0abc');
    const second = upsertDrafts(
      first,
      [
        draft({
          variants: [rawVariant('https://v.douyinvod.com/a/resolved.mp4')],
          meta: { ext: 'mp4', size: 8_698_069 },
        }),
      ],
      { now: 2 },
    ).library;
    expect(second[id].meta.size).toBe(8_698_069);
  });

  it('地址没变 → 已量到的 size 一直保留（兜底实测结果不会被后续合并抹掉）', () => {
    const first = upsertDrafts({}, [draft({ meta: { ext: 'png', size: 3_996_293 } })], { now: 1 }).library;
    const id = itemId(CONV, 'vid:v0abc');
    const second = upsertDrafts(first, [draft({ meta: { ext: 'png' }, cover: 'https://x/c.jpeg' })], { now: 2 }).library;
    expect(second[id].meta.size).toBe(3_996_293);
  });

  it('★§39：旧体积作废时，归属标记 `sizeFor` 一并清掉（不留「有归属、没数字」的残影）', () => {
    const id = itemId(CONV, 'vid:v0abc');
    const candidate: MediaVariant = {
      url: 'https://v26-vdl.doubao.com/candidate.mp4',
      label: '原始下载地址',
      rank: 60,
      isRaw: false,
    };
    const first = upsertDrafts(
      {},
      [draft({ state: 'pending', variants: [candidate], meta: { ext: 'mp4', size: 3_145_728, sizeFor: 'preview' } })],
      { now: 1 },
    ).library;
    const second = upsertDrafts(
      first,
      [draft({ variants: [rawVariant('https://v.douyinvod.com/a/raw.mp4')], meta: { ext: 'mp4' } })],
      { now: 2 },
    ).library;
    expect(second[id].primary).toBe('https://v.douyinvod.com/a/raw.mp4');
    expect(second[id].meta.size).toBeUndefined();
    expect(second[id].meta.sizeFor).toBeUndefined();
  });

  it('★§39：原片真值（size + sizeFor=raw）同批到达 → 覆盖掉旧的「预览体积」标注', () => {
    const id = itemId(CONV, 'vid:v0abc');
    const first = upsertDrafts({}, [draft({ meta: { ext: 'mp4', size: 3_145_728, sizeFor: 'preview' } })], {
      now: 1,
    }).library;
    const second = upsertDrafts(
      first,
      [draft({ meta: { ext: 'mp4', size: 7_444_480, sizeFor: 'raw' } })],
      { now: 2 },
    ).library;
    expect(second[id].meta.size).toBe(7_444_480);
    expect(second[id].meta.sizeFor).toBe('raw');
  });
});

describe('primaryIsRaw：当前下载地址是不是无水印原片（2026-10-02 §37 的「预览体积」判据）', () => {
  const candidate: MediaVariant = {
    url: 'https://v26-vdl.doubao.com/candidate.mp4?sign=1',
    label: '候选地址（参数改写）',
    rank: 60,
    isRaw: false,
  };
  const raw: MediaVariant = { url: 'https://v.douyinvod.com/a/raw.mp4?sign=1', label: '无水印原片', rank: 120, isRaw: true };

  const built = (variants: MediaVariant[], state: MediaItem['state'] = 'pending'): MediaItem => {
    const library = upsertDrafts({}, [draft({ variants, state })], { now: 1 }).library;
    return library[itemId(CONV, 'vid:v0abc')];
  };

  it('只有候选流 → false（卡片要标「预览体积」）', () => {
    expect(primaryIsRaw(built([candidate]))).toBe(false);
  });

  it('原片变体就位并被选为 primary → true', () => {
    expect(primaryIsRaw(built([raw, candidate], 'raw'))).toBe(true);
  });

  it('原片地址换了一份签名仍然算原片（按 normalizeUrl 比较）', () => {
    const staleOwner = upsertDrafts({}, [draft({ variants: [raw, candidate], state: 'raw' })], { now: 1 }).library;
    const id = itemId(CONV, 'vid:v0abc');
    const resigned = { ...staleOwner[id], primary: 'https://v.douyinvod.com/a/raw.mp4?sign=99999&l=2026' };
    expect(primaryIsRaw(resigned)).toBe(true);
  });

  it('下载失败（state=fail）不改判据 —— 原片体积不该被贴上「预览」', () => {
    expect(primaryIsRaw(built([raw, candidate], 'raw'))).toBe(true);
    expect(primaryIsRaw(built([candidate]))).toBe(false);
  });

  it('空 primary → false（不抛异常）', () => {
    expect(primaryIsRaw({ ...built([candidate]), primary: '' })).toBe(false);
  });

  it('★rawReady / sizeForNow：`state=raw` 与「primary 是 isRaw」两个证据任一成立即算原片就绪', () => {
    // 证据①：state=raw（变体关系可能还没稳定，实机 §39.6 就是这种情况）
    const byState = { ...built([candidate]), state: 'raw' as const, meta: { ext: 'mp4', size: 1 } };
    expect(primaryIsRaw(byState)).toBe(false); // 单看变体判不出来
    expect(rawReady(byState)).toBe(true); // 但 state 已声明原片就绪
    expect(sizeForNow(byState)).toBe('raw');

    // 证据②：pending 但 primary 已是 isRaw 变体（例如 chain 直接给了 ori_raw）
    const byVariant = built([raw, candidate]);
    expect(byVariant.state).toBe('pending');
    expect(rawReady(byVariant)).toBe(true);
    expect(sizeForNow(byVariant)).toBe('raw');

    // 都没有：pending + 只有候选流 → 体积属于「预览」
    expect(rawReady(built([candidate]))).toBe(false);
    expect(sizeForNow(built([candidate]))).toBe('preview');
  });
});

describe('hasCopyableDirectLink：有没有可直接复制的无水印直链（2026-10-04 §52）', () => {
  const built = (overrides: Partial<MediaDraft> = {}): MediaItem => {
    const library = upsertDrafts({}, [draft(overrides)], { now: 1 }).library;
    return library[itemId(CONV, 'vid:v0abc')];
  };

  it('对话页条目：有直链（图片 / 视频都算）', () => {
    expect(hasCopyableDirectLink(built())).toBe(true);
    expect(hasCopyableDirectLink(built({ kind: 'image' }))).toBe(true);
  });

  it('对话页视频还在解析中（state=pending）也照旧可复制 —— 本次刻意不动这一档', () => {
    expect(hasCopyableDirectLink(built({ state: 'pending' }))).toBe(true);
  });

  it('补角重建的图 → 没有直链（无水印只存在于下载时的合成结果里）', () => {
    const item = built({
      kind: 'image',
      meta: { ext: 'png', patch: { url: 'https://p3.douyinpic.com/ori.png', rect: { x: 0, y: 0, w: 518, h: 116 } } },
    });
    expect(item.meta.patch).toBeDefined();
    expect(hasCopyableDirectLink(item)).toBe(false);
  });

  it('分享页视频：原片没到手（state≠raw）→ 没有直链；已解析回原片 → 有', () => {
    expect(hasCopyableDirectLink(built({ convKind: 'thread', state: 'pending' }))).toBe(false);
    expect(hasCopyableDirectLink(built({ convKind: 'thread', state: 'fail' }))).toBe(false);
    expect(hasCopyableDirectLink(built({ convKind: 'thread', state: 'raw' }))).toBe(true);
  });

  it('★对话页视频 + 原片已超期 → 没有直链（2026-10-04 §53：primary 是带水印播放档）', () => {
    expect(hasCopyableDirectLink(built({ state: 'fail', meta: { ext: 'mp4', expired: true } }))).toBe(false);
  });

  it('★对话页视频「未超期」不适用这条路（解析中照旧可复制，沿用 §52 原口径）', () => {
    expect(hasCopyableDirectLink(built({ state: 'pending' }))).toBe(true);
    expect(hasCopyableDirectLink(built({ state: 'fail' }))).toBe(true);
  });

  it('★对话页超期视频若已解析回原片（state=raw）→ 有直链（正证据优先）', () => {
    expect(hasCopyableDirectLink(built({ state: 'raw', meta: { ext: 'mp4', expired: true } }))).toBe(true);
  });

  it('分享页的图片不受影响（「档位」只对视频有意义）', () => {
    expect(hasCopyableDirectLink(built({ convKind: 'thread', kind: 'image', state: 'pending' }))).toBe(true);
  });

  it('判据只看条目自己 —— 同一批里混装时逐条各判各的', () => {
    const items = [built(), built({ convKind: 'thread', state: 'pending' }), built({ kind: 'image' })];
    expect(items.map(hasCopyableDirectLink)).toEqual([true, false, true]);
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
