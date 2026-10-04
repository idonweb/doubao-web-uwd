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

import { itemMetaLine, stateTagLabel, stateTagOf, stateTagTitle } from '../src/ui/shared/dom';
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
 * 状态标签（`stateTagLabel` / `stateTagTitle`）—— 分享页视频例外（2026-10-03 第三十轮 §48.7）。
 *
 * 口径：分享页视频被判「原片不可得」（`meta.expired`）**不等于**拿不到无水印 ——
 * §47/§48 之后分享直链两档可下，旧文案「原片不可得」与「下载却拿到无水印文件」自相矛盾
 * （实机截图 2026-10-3 19-2-4.png）。故：
 *   ① thread + video + expired → 「无水印（分享页）」（按补角先例：落地即标能力、失败才降级）；
 *   ② bg 回写 `meta.shareDlFail`（这次直链没解出）→ 如实降级「仅带水印档」；
 *   ③ 对话页「原片已超期」与分享页**图片**条目不受影响（原口径仍准确）；
 *   ④ 正证据优先不变：拿到原片（state=raw）一律压过 expired。
 */
describe('stateTagLabel / stateTagTitle：分享页视频例外（§48.7）', () => {
  const expiredShareVideo = {
    state: 'fail' as const,
    meta: { ext: 'mp4', expired: true },
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

  it('对话页视频 + 原片不可得 → 仍是「原片已超期」（原口径不动）', () => {
    const entry = item({ convKind: 'chat', convId: 'c1', id: 'c1::vid:x', ...expiredShareVideo });
    expect(stateTagLabel(entry)).toBe('原片已超期');
    expect(stateTagTitle(entry)).toContain('只对作品所属账号开放');
  });

  it('★判据按条目本身（kind） gate：分享页图片条目（若出现 expired）仍走「原片不可得」', () => {
    const entry = item({ ...expiredShareVideo, kind: 'image', fingerprint: 'img:x', id: 'share_5713::img:x' });
    expect(stateTagLabel(entry)).toBe('原片不可得');
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
  });
});
