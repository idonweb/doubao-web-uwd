/**
 * 卡片副信息行（`itemMetaLine`）—— 「预览体积」文案（2026-10-02 §37；§39 改判据）。
 *
 * 口径（用户拍板 + §39 实机修正）：
 *   ① 体积**入库即测**，所以原片字节数到位之前显示的是**带水印候选流**的大小 → 标「预览」；
 *   ② 判据 = **`meta.sizeFor`（跟着数字走的归属标记）**，缺省一律当「预览」（保守）；
 *      ⛔ **不能**用 `state === 'raw'` 或 `primaryIsRaw()` 现场推断 —— 实机 bug：
 *      `primary` 切到原片是异步的、体积实测要 ~0.7s，赛跑时「候选流的 3.0 MB」被记在
 *      已是原片的条目上，现场推断会把它当原片体积显示（真原片 7.1 MB，`docs/03` §39）；
 *   ③ 宽高本来就是预览规格（`dimsPreview`）时**只出现一个「预览」**（前缀对整个规格串生效）。
 */

import { describe, expect, it } from 'vitest';

import { STATE_TAG, itemMetaLine, stateTagLabel, stateTagOf, stateTagTitle } from '../src/ui/shared/dom';
import type { MediaItem, MediaVariant } from '../src/core/types';

const CANDIDATE: MediaVariant = {
  url: 'https://v11-default.365yg.com/03aaa/6ac89853/video/tos/cn/x/?lr=video_gen_no_watermark&download=true',
  label: '候选地址（参数改写）',
  rank: 60,
  isRaw: false,
};
const RAW: MediaVariant = { url: 'https://v.douyinvod.com/a/raw.mp4?sign=1', label: '无水印原片', rank: 120, isRaw: true };

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'share_5713::vid:v0269cg',
    convId: 'share_5713',
    convKind: 'thread',
    convTitle: '豆包 AI 视频',
    fingerprint: 'vid:v0269cg',
    kind: 'video',
    state: 'pending',
    variants: [CANDIDATE],
    primary: CANDIDATE.url,
    cover: null,
    meta: { ext: 'mp4' },
    firstSeen: 1,
    lastSeen: 1,
    ...overrides,
  };
}

describe('itemMetaLine：预览体积', () => {
  it('分享页（720×1280 + 实测候选流体积 2 432 274 B）→「预览 720×1280 · 2.3 MB」', () => {
    const line = itemMetaLine(
      item({ meta: { ext: 'mp4', width: 720, height: 1280, dimsPreview: true, size: 2_432_274 } }),
    );
    expect(line).toBe('预览 720×1280 · 2.3 MB');
  });

  it('★宽高带预览标记时，「预览」只出现一次（不写成「预览 384×216 · 预览 3.1 MB」）', () => {
    const line = itemMetaLine(item({ meta: { ext: 'mp4', width: 384, height: 216, dimsPreview: true, size: 3_251_548 } }));
    expect(line).toBe('预览 384×216 · 3.1 MB');
    expect(line.match(/预览/g)).toHaveLength(1);
  });

  it('原片体积（sizeFor=raw）→ 纯数字，不带「预览」', () => {
    const line = itemMetaLine(
      item({
        state: 'raw',
        variants: [RAW, CANDIDATE],
        primary: RAW.url,
        meta: { ext: 'mp4', width: 720, height: 1280, dimsPreview: false, size: 6_605_324, sizeFor: 'raw' },
      }),
    );
    expect(line).toBe('720×1280 · 6.3 MB');
  });

  it('★§39 回归锁：原片已就绪但体积仍是候选流的（sizeFor=preview）→ 必须带「预览」', () => {
    // 实机原样：1470×630（原片真实宽高）+ 3.0 MB（候选流实测）→ 不能装作是原片大小
    const line = itemMetaLine(
      item({
        state: 'raw',
        variants: [RAW, CANDIDATE],
        primary: RAW.url,
        meta: { ext: 'mp4', width: 1470, height: 630, dimsPreview: false, size: 3_145_728, sizeFor: 'preview' },
      }),
    );
    expect(line).toBe('1470×630 · 预览 3.0 MB');
  });

  it('★归属标记缺省（升级前的历史条目）→ 保守按「预览」处理', () => {
    const line = itemMetaLine(
      item({
        state: 'raw',
        variants: [RAW],
        primary: RAW.url,
        meta: { ext: 'mp4', width: 1080, height: 1920, dimsPreview: false, size: 9_000_000 },
      }),
    );
    expect(line).toBe('1080×1920 · 预览 8.6 MB');
  });

  it('下载失败（state=fail）不影响判据 —— 体积归属由 sizeFor 说了算', () => {
    const failed = item({
      state: 'fail',
      variants: [RAW],
      primary: RAW.url,
      meta: { ext: 'mp4', width: 1080, height: 1920, dimsPreview: false, size: 9_000_000, sizeFor: 'raw' },
    });
    expect(itemMetaLine(failed)).toBe('1080×1920 · 8.6 MB');
    expect(itemMetaLine({ ...failed, meta: { ...failed.meta, sizeFor: 'preview' } })).toBe('1080×1920 · 预览 8.6 MB');
  });

  it('换了一份签名的原片地址仍算原片（签约化比较，不误贴「预览」）', () => {
    const line = itemMetaLine(
      item({
        state: 'raw',
        variants: [RAW, CANDIDATE],
        primary: 'https://v.douyinvod.com/a/raw.mp4?sign=9999',
        meta: { ext: 'mp4', size: 1_048_576, sizeFor: 'raw' },
      }),
    );
    expect(line).toBe('1.0 MB');
  });

  it('没有体积也没有宽高 → 退回扩展名（旧行为不变）', () => {
    expect(itemMetaLine(item({ meta: { ext: 'mp4' } }))).toBe('MP4');
  });
});

/**
 * 状态标签（`stateTagLabel` / `stateTagOf` / `stateTagTitle`）—— 「要靠播放源换无水印」的视频例外。
 *
 * 口径（2026-10-03 §48.7 分享页；2026-10-04 §53 扩到**对话页超期视频**）：
 *   ① **分享页视频** / **对话页超期视频**被判「原片取不到」（`meta.expired`）**不等于**拿不到无水印 ——
 *      站点播放源仍能换出无水印档，旧文案「原片不可得 / 原片已超期」与「下载却拿到无水印」自相矛盾。
 *      按补角先例「落地即标能力、失败才降级」：默认绿（t-raw + check），文案按来源分
 *      （分享页 = 「无水印（分享页）」；对话页 = 「无水印（超期补救）」）；
 *   ② bg 回写 `meta.shareDlFail`（这次没解出）→ 如实降级「仅带水印档」+ fail 红；
 *   ③ **图片**条目（含分享页图片）不受影响（原口径仍准确）；
 *   ④ 正证据优先不变：拿到原片（state=raw）一律压过 expired；
 *   ⑤ **2026-10-04 §55**：分享页视频的**标签判据 = 行为判据**（`needsShareWatermark`）——
 *      未确认 expired 也当场标「无水印（分享页）」（旧口径要等三步链路翻树 + 20s 确认窗口，
 *      实机体感「下载已生效、标签还在解析中」）；**悬停说明**仍等 `meta.expired`（不提前下断言）。
 */
describe('stateTagLabel / stateTagTitle：播放源换无水印的视频例外（§48.7 / §53 / §55）', () => {
  const expiredShareVideo = {
    state: 'fail' as const,
    meta: { ext: 'mp4', expired: true },
  };
  const expiredChatVideo = {
    convKind: 'chat' as const,
    convId: 'c1',
    id: 'c1::vid:x',
    ...expiredShareVideo,
  };

  it('★分享页视频 + 原片不可得 →「无水印（分享页）」（不再显示旧文案「原片不可得」）', () => {
    const entry = item(expiredShareVideo);
    expect(stateTagLabel(entry)).toBe('无水印（分享页）');
    // ★配色与语义同源（用户 2026-10-03 19:4x 反馈）：语义是「可用」→ 成功绿 + check，不是 fail 红
    const tag = stateTagOf(entry);
    expect(tag.cls).toBe('t-raw');
    expect(tag.icon).toBe('check');
    // 悬停说明讲清能力来源与档位，不再是「取不到无水印原片」的旧说法
    const title = stateTagTitle(entry);
    expect(title).toContain('分享直链');
    expect(title).toContain('原画质');
    expect(title).not.toContain('取不到无水印原片');
  });

  it('★对话页视频 + 原片已超期 →「无水印（超期补救）」（2026-10-04 §53，原口径「原片已超期」作废）', () => {
    const entry = item(expiredChatVideo);
    expect(stateTagLabel(entry)).toBe('无水印（超期补救）');
    const tag = stateTagOf(entry);
    expect(tag.cls).toBe('t-raw');
    expect(tag.icon).toBe('check');
    // 说明里必须讲清「原片已超期 + 站点播放源换无水印原画质档」，且**不得**说成「分享页」
    const title = stateTagTitle(entry);
    expect(title).toContain('已超期');
    expect(title).toContain('原画质');
    expect(title).not.toContain('分享');
  });

  it('★bg 回写 shareDlFail（这次直链没解出）→ 如实降级「仅带水印档」+ fail 红，说明里给恢复路径', () => {
    const entry = item({ ...expiredShareVideo, meta: { ext: 'mp4', expired: true, shareDlFail: true } });
    expect(stateTagLabel(entry)).toBe('仅带水印档');
    const tag = stateTagOf(entry);
    expect(tag.cls).toBe('t-fail');
    expect(tag.icon).toBe('alert');
    const title = stateTagTitle(entry);
    expect(title).toContain('带水印播放档');
    expect(title).toContain('自动恢复');
  });

  it('★对话页超期视频 + shareDlFail → 同样如实降级「仅带水印档」', () => {
    const entry = item({ ...expiredChatVideo, meta: { ext: 'mp4', expired: true, shareDlFail: true } });
    expect(stateTagLabel(entry)).toBe('仅带水印档');
    expect(stateTagOf(entry).cls).toBe('t-fail');
    expect(stateTagTitle(entry)).toContain('带水印档');
  });

  it('§55 分享页视频**未确认原片不可得**（pending、无 expired）→ 当场「无水印（分享页）」；悬停仍等确认', () => {
    const entry = item({ state: 'pending', meta: { ext: 'mp4' } }); // item() 默认 convKind='thread'
    expect(stateTagLabel(entry)).toBe('无水印（分享页）');
    const tag = stateTagOf(entry);
    expect(tag.cls).toBe('t-raw');
    expect(tag.icon).toBe('check');
    // ⚠️ 标签乐观提前翻绿，但「创作树原片不可得」这句结论要确认后才说 → 此刻没有悬停说明
    expect(stateTagTitle(entry)).toBe('');
    // 确认（meta.expired）后 → 悬停说明出现
    expect(stateTagTitle(item(expiredShareVideo))).toContain('分享直链');
  });

  it('§55 分享页视频 shareDlFail 但尚未确认 expired → 仍立即降级「仅带水印档」+ 失败说明', () => {
    const entry = item({ state: 'pending', meta: { ext: 'mp4', shareDlFail: true } });
    expect(stateTagLabel(entry)).toBe('仅带水印档');
    expect(stateTagOf(entry).cls).toBe('t-fail');
    expect(stateTagTitle(entry)).toContain('带水印播放档');
  });

  it('§55 对话页视频未超期（pending、无 expired）仍「解析中」，不提前标「超期补救」', () => {
    const entry = item({ convKind: 'chat', convId: 'c1', id: 'c1::vid:x', state: 'pending', meta: { ext: 'mp4' } });
    expect(stateTagLabel(entry)).toBe('解析中');
    expect(stateTagTitle(entry)).toBe('');
    const tag = stateTagOf(entry);
    expect(tag.cls).toBe(STATE_TAG.pending.cls);
  });

  it('★判据按条目本身（kind）gate：图片条目（对话页 / 分享页）即使 expired 仍走旧口径', () => {
    const chatImage = item({
      ...expiredChatVideo,
      kind: 'image',
      fingerprint: 'img:x',
      id: 'c1::img:x',
    });
    expect(stateTagLabel(chatImage)).toBe('原片已超期');
    expect(stateTagTitle(chatImage)).toContain('只对作品所属账号开放');

    const threadImage = item({ ...expiredShareVideo, kind: 'image', fingerprint: 'img:x', id: 'share_5713::img:x' });
    expect(stateTagLabel(threadImage)).toBe('原片不可得');
  });

  it('★正证据优先不变：拿到原片（state=raw）压过 expired →「无水印原片」', () => {
    const entry = item({
      state: 'raw',
      variants: [RAW],
      primary: RAW.url,
      meta: { ext: 'mp4', expired: true },
    });
    expect(stateTagLabel(entry)).toBe('无水印原片');
    expect(stateTagTitle(entry)).toBe('');

    // 对话页同一条（已拿到原片的老视频不该被标成「超期补救」）
    const chatRaw = item({
      convKind: 'chat',
      convId: 'c1',
      id: 'c1::vid:x',
      state: 'raw',
      variants: [RAW],
      primary: RAW.url,
      meta: { ext: 'mp4', expired: true },
    });
    expect(stateTagLabel(chatRaw)).toBe('无水印原片');
  });
});
