import { describe, expect, it } from 'vitest';

import { rawFromCreation, siteTimeToMs, toDraft } from '../src/core/extract/common';

/**
 * 站点时间字段的单位换算（2026-09-28 第十轮）。
 *
 * 站点所有时间字段都是**秒级** Unix（消息 `create_time`、创作树节点 `create_time`），
 * 而 `meta.createdAt` 与 `firstSeen` / `lastSeen` 统一用**毫秒** —— 换算只走这一个函数。
 */
describe('siteTimeToMs（秒级 → 毫秒）', () => {
  it('正常值 ×1000 取整', () => {
    expect(siteTimeToMs(1790520877)).toBe(1_790_520_877_000);
    expect(siteTimeToMs(1779538923)).toBe(1_779_538_923_000);
    // 带小数也取整（站点偶尔给 .5 这类）
    expect(siteTimeToMs(1790520877.512)).toBe(1_790_520_877_512);
  });

  it('缺省 / 0 / 负数 / NaN / undefined 一律返回 undefined —— 宁缺勿假，不编时间', () => {
    expect(siteTimeToMs(undefined)).toBeUndefined();
    expect(siteTimeToMs(null)).toBeUndefined();
    expect(siteTimeToMs(0)).toBeUndefined();
    expect(siteTimeToMs(-1)).toBeUndefined();
    expect(siteTimeToMs(Number.NaN)).toBeUndefined();
    expect(siteTimeToMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

/**
 * 图片体积：**报文里的 `size` 一律不采纳**（2026-09-28 实机反例，`docs/03` §18）。
 *
 * 站点确实会在 image 的子对象里给 `size`，但它与「我们真正下载的那个文件」不是同一个字节数 ——
 * 实机：卡片显示 378 KB（子对象的 size），而 `image_ori_raw.url` 下回来的是 3.81 MB 的 PNG
 * （3 996 293 字节）。所以宽高照旧从子对象取，`size` 一律丢掉，
 * 图片体积只由 background 实测 `primary` 得到。
 */
describe('图片体积：不从报文取 size（回归锁）', () => {
  const creation = {
    image: {
      image_thumb: { url: 'https://p3-ibyteimg.com/t.jpeg', width: 2720, height: 1520, size: 379_000 },
      image_preview: { url: 'https://p3-ibyteimg.com/p.jpeg', width: 2732, height: 1534 },
      image_ori_raw: {
        url: 'https://p3-ibyteimg.com/rc_gen_image/dfe9.jpeg~tplv-a9rns2rl98-image_raw.png',
        width: 2732,
        height: 1534,
        size: 378_043,
      },
    },
  };

  it('rawFromCreation 只取宽高：子对象带 size 也不读', () => {
    const raw = rawFromCreation(creation, 'chain');
    expect(raw?.width).toBe(2732); // image_ori_raw 的宽高（质量最高优先）
    expect(raw?.height).toBe(1534);
    expect(raw?.raw).toContain('image_raw.png');
    expect(raw?.size).toBeUndefined();
  });

  it('toDraft 因此不会把假体积写进 meta.size —— 交给 bg 实测兜底', () => {
    const raw = rawFromCreation(creation, 'chain');
    const draft = toDraft(raw!, { convId: 'c1', convKind: 'chat', convTitle: 't' });
    expect(draft).not.toBeNull();
    expect(draft?.meta.size).toBeUndefined();
  });
});
