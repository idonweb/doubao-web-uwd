/**
 * 体积实测的**调度规则**（2026-10-02 第十七轮 §37）。
 *
 * 回归锁对准两处实机缺陷：
 *   ① **「解析中」不测体积** —— 用户实测「分享页卡片体积时有时无」的一半原因；
 *      现在入库即测（`state=pending` 也测），界面用「预览体积」如实标注。
 *   ② **一个条目只测一次、失败也算测过** —— 一次网络不顺就永久空白；
 *      现在按「条目 + 归一化地址」记账，失败留有重试额度（`LIMITS.SIZE_PROBE_RETRY` = 1）。
 */

import { describe, expect, it } from 'vitest';

import { LIMITS } from '../src/core/constants';
import {
  canRetryProbe,
  maxProbeAttempts,
  needsRawSizeUpgrade,
  needsSizeProbe,
  probeWriteBlocked,
  recordProbeAttempt,
  sizeProbeKey,
} from '../src/core/size-probe';
import type { MediaItem } from '../src/core/types';

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'share_5713::vid:v0269cg',
    convId: 'share_5713',
    convKind: 'thread',
    convTitle: '豆包 AI 视频',
    fingerprint: 'vid:v0269cg',
    kind: 'video',
    state: 'pending',
    variants: [
      {
        url: 'https://v11-default.365yg.com/03aaa/6ac89853/video/tos/cn/x/?lr=video_gen_no_watermark&download=true',
        label: '候选地址（参数改写）',
        rank: 60,
        isRaw: false,
      },
    ],
    primary: 'https://v11-default.365yg.com/03aaa/6ac89853/video/tos/cn/x/?lr=video_gen_no_watermark&download=true',
    cover: null,
    meta: { ext: 'mp4', width: 720, height: 1280, dimsPreview: true },
    firstSeen: 1,
    lastSeen: 1,
    ...overrides,
  };
}

describe('探测记账键：按「条目 + 归一化地址」', () => {
  it('同一文件换一份签名（查询段变化）→ 同一个键（不重复测）', () => {
    const a = item({ primary: 'https://v11-default.365yg.com/03aaa/video.mp4?l=AAA&dy_q=1' });
    const b = item({ primary: 'https://v11-default.365yg.com/03aaa/video.mp4?l=BBB&dy_q=2' });
    expect(sizeProbeKey(a)).toBe(sizeProbeKey(b));
  });

  it('变成另一个文件（路径不同）→ 换键（允许重测）', () => {
    const candidate = item();
    const raw = item({ primary: 'https://v.douyinvod.com/aaa/raw.mp4?sign=1' });
    expect(sizeProbeKey(candidate)).not.toBe(sizeProbeKey(raw));
  });
});

describe('needsSizeProbe：什么时候值得测', () => {
  it('★「解析中」也测（回归锁：旧实现在这里返回 false，实机表现为解析中必然没有体积）', () => {
    expect(needsSizeProbe(item({ state: 'pending' }), new Map())).toBe(true);
  });

  it('已有体积 → 不测（成功不需要额外标记：写进 meta.size 即自动跳过）', () => {
    expect(needsSizeProbe(item({ meta: { ext: 'mp4', size: 2_432_274 } }), new Map())).toBe(false);
  });

  it('★已有体积但归属是「预览」、且原片已就绪 → 仍要测一次（§39 升级测量）', () => {
    const settled = {
      state: 'raw' as const,
      variants: [
        { url: 'https://v.douyinvod.com/a/raw.mp4?sign=1', label: '无水印原片', rank: 120, isRaw: true },
      ],
      primary: 'https://v.douyinvod.com/a/raw.mp4?sign=1',
      meta: { ext: 'mp4', size: 3_000_000, sizeFor: 'preview' as const },
    };
    expect(needsRawSizeUpgrade(item(settled))).toBe(true);
    expect(needsSizeProbe(item(settled), new Map())).toBe(true);

    // 归属已是原片 → 不必再测
    expect(needsSizeProbe(item({ ...settled, meta: { ...settled.meta, sizeFor: 'raw' } }), new Map())).toBe(false);
  });

  it('★「原片不可得 / 已超期」的条目不会反复测（primary 永远是候选流 → 无升级需求）', () => {
    const expired = {
      state: 'fail' as const,
      meta: { ext: 'mp4', size: 2_432_274, sizeFor: 'preview' as const, expired: true },
    };
    expect(needsRawSizeUpgrade(item(expired))).toBe(false);
    expect(needsSizeProbe(item(expired), new Map())).toBe(false);
  });

  it('升级测量同样受额度约束（用完额度就不再测）', () => {
    const settled = {
      state: 'raw' as const,
      variants: [
        { url: 'https://v.douyinvod.com/a/raw.mp4?sign=1', label: '无水印原片', rank: 120, isRaw: true },
      ],
      primary: 'https://v.douyinvod.com/a/raw.mp4?sign=1',
      meta: { ext: 'mp4', size: 3_000_000, sizeFor: 'preview' as const },
    };
    const attempts = new Map<string, number>([[sizeProbeKey(item(settled)), maxProbeAttempts()]]);
    expect(needsSizeProbe(item(settled), attempts)).toBe(false);
  });

  it('★§39.6 回归锁：`state=raw` 但 primary 指向「查不到 isRaw 变体」的地址时，仍必须触发升级测量', () => {
    /*
     * 实机 bug：诊断 `bg.size` 打出「成功 3 条（原片 1 / 预览体积 2）」，此后**再无测量记录** ——
     * 两条视频的升级测量被跳过（判据只看 `primaryIsRaw`，而那一刻变体关系尚未稳定），
     * 卡片一直停在「预览 1.7 MB」。现在 `rawReady` 两个证据任一成立即算原片就绪。
     */
    const odd = {
      state: 'raw' as const,
      // 注意：variants 里**没有**与 primary 匹配的 isRaw 变体（模拟窗口期）
      variants: [
        {
          url: 'https://v11-vdl.doubao.com/candidate.mp4?sign=1',
          label: '候选地址（参数改写）',
          rank: 60,
          isRaw: false,
        },
      ],
      primary: 'https://v11-videoweb-download.doubao.com/raw.mp4?sign=2',
      meta: { ext: 'mp4', size: 1_782_579, sizeFor: 'preview' as const },
    };
    expect(needsRawSizeUpgrade(item(odd))).toBe(true);
    expect(needsSizeProbe(item(odd), new Map())).toBe(true);
  });

  it('地址不是可取的 http(s) → 不测（宁缺勿假）', () => {
    expect(needsSizeProbe(item({ primary: 'vid:v0abc' }), new Map())).toBe(false);
    expect(needsSizeProbe(item({ primary: '' }), new Map())).toBe(false);
  });

  it('额度用完（首次 + 1 次重试）→ 不再测，等 F5 重解析', () => {
    const attempts = new Map<string, number>();
    const target = item();
    const key = sizeProbeKey(target);
    attempts.set(key, maxProbeAttempts());
    expect(needsSizeProbe(target, attempts)).toBe(false);
    // 差一次额度时仍然测
    attempts.set(key, maxProbeAttempts() - 1);
    expect(needsSizeProbe(target, attempts)).toBe(true);
  });

  it('★地址换成另一个文件 → 即使旧地址额度用完，也允许对新地址重测', () => {
    const attempts = new Map<string, number>();
    const oldItem = item();
    attempts.set(sizeProbeKey(oldItem), maxProbeAttempts());
    expect(needsSizeProbe(oldItem, attempts)).toBe(false);

    // 原片解析成功：primary 换成真原片（体积已在 primaryChanged 时被清掉）→ 新账本
    const resolved = item({ primary: 'https://v.douyinvod.com/a/raw.mp4?sign=9', state: 'raw' });
    expect(needsSizeProbe(resolved, attempts)).toBe(true);
  });

  it('★「解析中」两次都失败后，定局那一刻仍然会补测一次（阶段是新账本）', () => {
    const attempts = new Map<string, number>();
    const pending = item({ state: 'pending' });
    attempts.set(sizeProbeKey(pending), maxProbeAttempts());
    expect(needsSizeProbe(pending, attempts)).toBe(false); // 解析中：额度用完，不再测

    // LibraryExpire 把条目落成「原片不可得」→ 定局是**新信息**，另开一轮
    const settled = item({ state: 'fail', meta: { ext: 'mp4', width: 720, height: 1280, dimsPreview: true, expired: true } });
    expect(needsSizeProbe(settled, attempts)).toBe(true);
    // 地址没变的情况下，定局后的这一轮也照样只有 1 次重试
    const settledKey = sizeProbeKey(settled);
    expect(recordProbeAttempt(attempts, settled)).toBe(1);
    expect(canRetryProbe(1)).toBe(true);
    expect(canRetryProbe(recordProbeAttempt(attempts, settled))).toBe(false);
    expect(needsSizeProbe(settled, attempts)).toBe(false);
    expect(settledKey).not.toBe(sizeProbeKey(pending));
  });
});

describe('attempts：记账与重试额度', () => {
  it('recordProbeAttempt 逐次递增，且同一文件换签名不另开户头', () => {
    const attempts = new Map<string, number>();
    const a = item({ primary: 'https://v11-default.365yg.com/03aaa/video.mp4?l=AAA' });
    const same = item({ primary: 'https://v11-default.365yg.com/03aaa/video.mp4?l=ZZZ' });
    expect(recordProbeAttempt(attempts, a)).toBe(1);
    expect(recordProbeAttempt(attempts, same)).toBe(2);
    expect(attempts.size).toBe(1);
  });

  it('失败重试次数 = LIMITS.SIZE_PROBE_RETRY（用户拍板：只重试 1 次）', () => {
    expect(LIMITS.SIZE_PROBE_RETRY).toBe(1);
    expect(maxProbeAttempts()).toBe(2);
    expect(canRetryProbe(1)).toBe(true); // 第 1 次失败 → 还有 1 次重试
    expect(canRetryProbe(2)).toBe(false); // 第 2 次（= 重试）仍失败 → 就此打住，等 F5
  });
});

describe('probeWriteBlocked：预览实测值不得降级创作树真值（§41）', () => {
  /*
   * 实机场景（2026-10-02 17:21~17:22）：入库即测带着 pending 快照起飞；探测在飞的 ~1s 里
   * vid 三步解析完成、携带创作树 size（真值）的 raw 草稿先落库；迟到的预览实测按旧快照
   * 写回 `{ size: 预览字节, sizeFor: 'preview' }`，把真值降级覆盖 —— 而升级测量只挂在
   * 「下一次 upsert」上，卡片停了 ~39s 才翻正（诊断：`mjq0a8qg→5.1MB(预览)`，此后无 bg.size）。
   */

  /** 创作树真值已落库的条目（raw + 原片归属体积） */
  const settledWithTreeSize = {
    state: 'raw' as const,
    variants: [
      { url: 'https://v.douyinvod.com/a/raw.mp4?sign=1', label: '无水印原片', rank: 120, isRaw: true },
    ],
    primary: 'https://v.douyinvod.com/a/raw.mp4?sign=1',
    meta: { ext: 'mp4', size: 37_643_469, sizeFor: 'raw' as const },
  };

  it('★回归锁：探测快照仍是预览、条目已拿原片真值 → 拦截（本条实机 bug）', () => {
    const snapshot = item(); // pending + 预览 primary（探测起飞时的快照）
    expect(probeWriteBlocked(snapshot, item(settledWithTreeSize))).toBe(true);
  });

  it('实测归属是原片（快照 primary 已是原片地址）→ 放行（这正是升级测量本身）', () => {
    const upgraded = item({
      state: 'raw',
      variants: [{ url: 'https://v.douyinvod.com/a/raw.mp4?sign=2', label: '无水印原片', rank: 120, isRaw: true }],
      primary: 'https://v.douyinvod.com/a/raw.mp4?sign=2',
    });
    expect(probeWriteBlocked(upgraded, item(settledWithTreeSize))).toBe(false);
  });

  it('条目只有预览体积（树里没给 size）→ 放行（写回后靠自触发升级补测翻正）', () => {
    const current = item({
      ...settledWithTreeSize,
      meta: { ext: 'mp4', size: 5_100_000, sizeFor: 'preview' },
    });
    expect(needsRawSizeUpgrade(current)).toBe(true);
    expect(probeWriteBlocked(item(), current)).toBe(false);
  });

  it('条目还没有体积 → 放行（先给预览体积，升级补测随后接手）', () => {
    const current = item({ ...settledWithTreeSize, meta: { ext: 'mp4' } });
    expect(probeWriteBlocked(item(), current)).toBe(false);
  });
});
