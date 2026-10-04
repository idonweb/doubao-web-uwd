import { describe, expect, it } from 'vitest';

import { clampPatchRect, coverSize, isSameSource, patchExcludeRects, sourceMarkRect } from '../src/core/image-patch';
import {
  IMG_PATCH_RECT,
  IMG_PATCH_SRC_MARK,
  IMG_PATCH_VERIFY_RING,
  IMG_PATCH_VERIFY_STEP,
} from '../src/core/site-contract';

/** 造一张纯色 RGBA 缓冲（alpha 固定 255） */
function solid(width: number, height: number, value = 200): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return data;
}

function setPixel(data: Uint8ClampedArray, width: number, x: number, y: number, value: number): void {
  const p = (y * width + x) * 4;
  data[p] = value;
  data[p + 1] = value;
  data[p + 2] = value;
}

function fillRect(
  data: Uint8ClampedArray,
  width: number,
  rect: { x: number; y: number; w: number; h: number },
  value: number,
): void {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) setPixel(data, width, x, y, value);
  }
}

describe('clampPatchRect', () => {
  it('落在图内的矩形原样返回', () => {
    expect(clampPatchRect({ x: 0, y: 0, w: 260, h: 150 }, 1536, 2730)).toEqual({ x: 0, y: 0, w: 260, h: 150 });
  });

  it('负起点夹到 0，宽高相应缩小', () => {
    expect(clampPatchRect({ x: -10, y: -10, w: 100, h: 100 }, 400, 400)).toEqual({ x: 0, y: 0, w: 90, h: 90 });
  });

  it('右下越界时按图像尺寸截断', () => {
    expect(clampPatchRect({ x: 1500, y: 2700, w: 260, h: 150 }, 1536, 2730)).toEqual({ x: 1500, y: 2700, w: 36, h: 30 });
  });

  it('宽高非正 / 完全落在图外 → null', () => {
    expect(clampPatchRect({ x: 0, y: 0, w: 0, h: 10 }, 100, 100)).toBeNull();
    expect(clampPatchRect({ x: 500, y: 500, w: 10, h: 10 }, 100, 100)).toBeNull();
    expect(clampPatchRect({ x: Number.NaN, y: 0, w: 10, h: 10 }, 100, 100)).toBeNull();
  });
});

describe('sourceMarkRect / patchExcludeRects（来源档水印框）', () => {
  it('来源档水印框贴着右下角，尺寸 = IMG_PATCH_SRC_MARK', () => {
    expect(sourceMarkRect(1536, 2730)).toEqual({ x: 1240, y: 2620, w: 296, h: 110 });
  });

  it('图比框还小时夹进图内（起点夹到 0）', () => {
    expect(sourceMarkRect(100, 80)).toEqual({ x: 0, y: 0, w: 100, h: 80 });
  });

  it('patchExcludeRects = 补角矩形 + 来源档水印框（两块都要排除）', () => {
    expect(patchExcludeRects({ x: 0, y: 0, w: 260, h: 150 }, 1536, 2730)).toEqual([
      { x: 0, y: 0, w: 260, h: 150 },
      { x: 1240, y: 2620, w: 296, h: 110 },
    ]);
  });
});

describe('isSameSource（补角同源校验）', () => {
  const W = 60;
  const H = 60;
  const RECT = { x: 10, y: 10, w: 20, h: 20 };
  const OPTS = { step: 5 };

  it('两档完全相同 → true', () => {
    expect(isSameSource(solid(W, H), solid(W, H), W, H, [RECT], OPTS)).toBe(true);
  });

  it('只有补角矩形内不同（那里正是水印所在）→ 仍然 true', () => {
    const a = solid(W, H);
    const b = solid(W, H);
    fillRect(b, W, RECT, 250);
    expect(isSameSource(a, b, W, H, [RECT], OPTS)).toBe(true);
  });

  it('环带里有一处不同 → false（紧邻水印的一圈必须逐像素一致）', () => {
    const a = solid(W, H);
    const b = solid(W, H);
    setPixel(b, W, RECT.x - 1, RECT.y - 1, 250);
    expect(isSameSource(a, b, W, H, [RECT], OPTS)).toBe(false);
  });

  it('远处（矩形与环带之外）有一处不同 → false（挡住「其实是两张不同的图」）', () => {
    const a = solid(W, H);
    const b = solid(W, H);
    setPixel(b, W, 50, 50, 10);
    expect(isSameSource(a, b, W, H, [RECT], OPTS)).toBe(false);
  });

  it('容差参数生效（tolerance=10 时小差异放过）', () => {
    const a = solid(W, H, 200);
    const b = solid(W, H, 200);
    setPixel(b, W, 50, 50, 205);
    expect(isSameSource(a, b, W, H, [RECT], OPTS)).toBe(false);
    expect(isSameSource(a, b, W, H, [RECT], { ...OPTS, tolerance: 10 })).toBe(true);
  });

  it('可以排除多块：第二块水印内的差异同样被放过', () => {
    const a = solid(W, H);
    const b = solid(W, H);
    // ⚠️ `other` 要放在 `RECT` 的环带（默认 ring=16）**之外**，否则会被「环带必须逐像素一致」判掉 ——
    // 那是正确行为，只是 60×60 的小画布上 ring=16 占比过大，容易写出互相污染的用例。
    const other = { x: 50, y: 50, w: 8, h: 8 };
    fillRect(b, W, RECT, 250);
    fillRect(b, W, other, 250);
    expect(isSameSource(a, b, W, H, [RECT], OPTS)).toBe(false); // 只给一块 ⇒ 第二块被当成「不同源」
    expect(isSameSource(a, b, W, H, [RECT, other], OPTS)).toBe(true);
  });

  /**
   * 🆕 **2026-10-03 第二十六轮实机 bug 的回归锁**。
   *
   * 实机症状：全部补角条目恒显示「仅带水印档」，诊断 `content.patch` 恒为「同源校验未通过」。
   * 根因：`isSameSource` 只排除了「底板左上的补角矩形」，**没排除来源档自己的右下水印**
   * ⇒ 稀疏全图采样（step=37）必然扫到右下 ⇒ `channelDiff > 0` ⇒ **恒定失败**。
   * 这里用**真实几何**（1536×2730）+ 真实步长复现，并把「两块都排」的正确写法锁住。
   */
  it('🆕 回归：来源档右下水印不该被误判成「两档不同源」（真实几何 1536×2730）', () => {
    const W2 = 1536;
    const H2 = 2730;
    const rect = { x: 0, y: 0, w: 260, h: 150 }; // 底板左上水印（要被补掉的那块）
    const srcMark = { x: 1240, y: 2620, w: 296, h: 110 }; // 来源档右下水印
    const a = solid(W2, H2); // 底板（预览档）
    const b = solid(W2, H2); // 来源档（下载档）
    fillRect(a, W2, rect, 250);
    fillRect(b, W2, srcMark, 250);
    const opts = { step: IMG_PATCH_VERIFY_STEP };

    // 旧写法（只排补角矩形）⇒ 必失败 —— 这正是实机上发生的事
    expect(isSameSource(a, b, W2, H2, [rect], opts)).toBe(false);
    // 正确写法（两块都排）⇒ 通过
    expect(isSameSource(a, b, W2, H2, patchExcludeRects(rect, W2, H2), opts)).toBe(true);
  });
});

describe('补角常量（与实测口径锁在一起）', () => {  it('补角宽松框 0,0 260×150 —— 覆盖实测并集 203×92 且留 ~30px 余量', () => {
    expect(IMG_PATCH_RECT).toEqual({ x: 0, y: 0, w: 260, h: 150 });
  });

  it('来源档水印宽松框 296×110（距右下角）—— 覆盖实测并集 247×60 且留余量', () => {
    expect(IMG_PATCH_SRC_MARK).toEqual({ w: 296, h: 110 });
    // 实测并集 x1267~1513 y2644~2703（原图 1536×2730）必须落在框内
    const box = sourceMarkRect(1536, 2730);
    expect(box).not.toBeNull();
    expect(box!.x).toBeLessThanOrEqual(1267);
    expect(box!.y).toBeLessThanOrEqual(2644);
    expect(box!.x + box!.w).toBeGreaterThanOrEqual(1513);
    expect(box!.y + box!.h).toBeGreaterThanOrEqual(2703);
  });

  it('校验步长 37 / 环带 16', () => {
    expect(IMG_PATCH_VERIFY_STEP).toBe(37);
    expect(IMG_PATCH_VERIFY_RING).toBe(16);
  });
});

describe('coverSize（卡片封面的等比尺寸，第三十一轮）', () => {
  it('长边缩到 maxPx，比例不变', () => {
    // 实测老链路补角图的真实规格 1536×2730
    expect(coverSize(1536, 2730, 480)).toEqual({ width: 270, height: 480 });
  });

  it('比 maxPx 小就不放大（放大只会糊）', () => {
    expect(coverSize(240, 240, 480)).toEqual({ width: 240, height: 240 });
  });

  it('横版同样按长边缩', () => {
    expect(coverSize(2048, 1024, 512)).toEqual({ width: 512, height: 256 });
  });

  it('极端小图 / 零尺寸不会算出 0 或 NaN', () => {
    expect(coverSize(3, 1, 480)).toEqual({ width: 3, height: 1 });
    expect(coverSize(0, 0, 480)).toEqual({ width: 1, height: 1 });
  });
});
