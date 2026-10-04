/**
 * 「补角重建」的几何与校验 —— **纯函数**（2026-10-03 第二十三轮 §43）。
 *
 * 背景：老链路「修改生成」的图片（`msg.content.image_list[*]`）站点**没有**给无水印档，
 * 只给了两档**带水印的同源底图**：
 *   · 预览档 `image_raw`（水印在**左上**，全尺寸）—— 补角的**底板**；
 *   · 下载档 `image_ori`（水印在**右下**，全尺寸）—— 补角的**像素来源**。
 * 实测（10 次观测 / 8 张独立底图，`docs/03` §43.11）：
 *   ① 两档**除各自的水印矩形外逐像素相同**（排除矩形后全域差 = 0）；
 *   ② 两块水印矩形**互不相交**（左上 / 右下，相距 >1000px）。
 * ⇒ 把来源档的矩形区域**原样覆盖**到底板同一位置，即得无水印图（**无损**，不是合成）。
 *
 * ⚠️ 本文件只放**几何与判据**（可单测）；真正的取图 / canvas 合成在
 * `content/bridge.ts::downloadPatched`（那里有 OffscreenCanvas 与 blob 下载能力）。
 *
 * ⚠️ **同源校验是必须的**：补角的正确性完全建立在「两档同源」之上。万一站点将来改成
 * 两档不同源，覆盖就会把**别处的画面**糊到这块矩形里 —— 比带水印更糟。
 * 所以下载前先比对（`isSameSource`），不通过就**不补角**、退回带水印档（宁缺勿假）。
 */

import { IMG_PATCH_SRC_MARK, IMG_PATCH_VERIFY_RING } from './site-contract';

export interface PatchRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 把补角矩形夹进图像范围；非法（宽高非正 / 完全落在图外）时返回 `null` */
export function clampPatchRect(rect: PatchRect, width: number, height: number): PatchRect | null {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return null;
  if (!Number.isFinite(rect.w) || !Number.isFinite(rect.h)) return null;
  if (rect.w <= 0 || rect.h <= 0) return null;
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(width, Math.floor(rect.x + rect.w));
  const bottom = Math.min(height, Math.floor(rect.y + rect.h));
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * **来源档（下载档 `image_ori`）右下水印的宽松框** —— 距右下角 `IMG_PATCH_SRC_MARK` 并夹进图内。
 *
 * 图比宽松框还小时返回 `null`（那就无从排除，调用方只需处理补角矩形那一块）。
 */
export function sourceMarkRect(width: number, height: number): PatchRect | null {
  const w = Math.min(width, IMG_PATCH_SRC_MARK.w);
  const h = Math.min(height, IMG_PATCH_SRC_MARK.h);
  if (!(w > 0) || !(h > 0)) return null;
  return {
    x: Math.max(0, width - IMG_PATCH_SRC_MARK.w),
    y: Math.max(0, height - IMG_PATCH_SRC_MARK.h),
    w,
    h,
  };
}

/**
 * **同源校验要排除的全部矩形** = 补角矩形（底板**左上**的水印）+ **来源档自己的水印**（右下）。
 *
 * ⚠️ **两块都必须给**：两档「除各自水印外逐像素相同」，只排除补角矩形的话，
 *   稀疏全图采样会扫到来源档右下那处水印 ⇒ **恒定判失败**（2026-10-03 第二十六轮实机 bug，
 *   见 `site-contract` 的 `IMG_PATCH_SRC_MARK` 与 `docs/03` §46）。
 */
export function patchExcludeRects(rect: PatchRect, width: number, height: number): PatchRect[] {
  const out: PatchRect[] = [rect];
  const src = sourceMarkRect(width, height);
  if (src) out.push(src);
  return out;
}

/**
 * **卡片封面的等比尺寸**（2026-10-03 第三十一轮）。
 *
 * 补角重建的图没有无水印直链可当封面，封面也是现场合成出来的（`content/bridge.ts`）——
 * 但卡片缩略图最大也就 ~200px 宽，把 1536×2730 的合成结果整张编码成 data URL 是白花成本，
 * 所以先等比缩到长边 ≤ `maxPx`。**比 `maxPx` 小就不放大**（放大只会糊）。
 */
export function coverSize(width: number, height: number, maxPx: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  const scale = longest > 0 ? Math.min(1, maxPx / longest) : 1;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** 两个 RGBA 缓冲在同一个像素上的**最大通道差** */function channelDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, pixelIndex: number): number {
  const p = pixelIndex * 4;
  const d0 = Math.abs(a[p] - b[p]);
  const d1 = Math.abs(a[p + 1] - b[p + 1]);
  const d2 = Math.abs(a[p + 2] - b[p + 2]);
  return d0 > d1 ? (d0 > d2 ? d0 : d2) : d1 > d2 ? d1 : d2;
}

export interface SameSourceOptions {
  /** 稀疏全图采样的步长（像素）；越小越严、越慢 */
  step: number;
  /** 矩形外扩的环带宽度（像素），缺省 `site-contract::IMG_PATCH_VERIFY_RING` */
  ring?: number;
  /** 允许的通道差，缺省 `0`（要求逐像素相同） */
  tolerance?: number;
}

/**
 * **同源校验**：两档是否「除**各自的水印矩形**（各含其外一圈环带）外逐像素相同」。
 *
 * 两层判据（都要过）：
 *   ① **环带**：紧邻每个水印矩形的 `ring` 圈**逐像素**比对 —— 这是最要紧的一处，
 *      因为补角后紧邻的位置最容易看出接缝；
 *   ② **稀疏全图**：按 `step` 抽样整个画面（含矩形以外的所有区域），挡住「矩形离水印很远、
 *      但两档其实是两张不同的图」这种情形。
 *
 * ⚠️ 矩形**内部**允许不同（那里正是水印所在），故两层都跳过它。
 * ⚠️ `rects` 必须**同时包含**「补角矩形（底板左上）」与「来源档自己的水印矩形（右下）」
 *   —— 只给前者会恒定失败（2026-10-03 第二十六轮实机 bug）。请用 `patchExcludeRects()` 组装。
 *
 * @param a        底板（预览档）的 RGBA 数据
 * @param b        来源档（下载档）的 RGBA 数据
 * @param width    图像宽（两档必须一致，调用方先校验）
 * @param height   图像高
 * @param rects    允许两档不同的全部矩形（一般 = `patchExcludeRects(rect, w, h)`）
 */
export function isSameSource(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  height: number,
  rects: readonly PatchRect[],
  options: SameSourceOptions,
): boolean {
  const ring = Math.max(0, Math.floor(options.ring ?? IMG_PATCH_VERIFY_RING));
  const tolerance = Math.max(0, options.tolerance ?? 0);
  const step = Math.max(1, Math.floor(options.step));

  // 只保留合法的矩形（含 `w`/`h` 非正的一律忽略）
  const bands = rects
    .filter((r) => r.w > 0 && r.h > 0)
    .map((r) => ({ x1: r.x, y1: r.y, x2: r.x + r.w - 1, y2: r.y + r.h - 1 }));

  const inBand = (band: { x1: number; y1: number; x2: number; y2: number }, x: number, y: number): boolean =>
    x >= band.x1 && x <= band.x2 && y >= band.y1 && y <= band.y2;

  // ① 每个水印矩形各自的环带：紧邻水印的一圈逐像素比对
  for (const band of bands) {
    const rx1 = Math.max(0, band.x1 - ring);
    const ry1 = Math.max(0, band.y1 - ring);
    const rx2 = Math.min(width - 1, band.x2 + ring);
    const ry2 = Math.min(height - 1, band.y2 + ring);
    for (let y = ry1; y <= ry2; y += 1) {
      const row = y * width;
      for (let x = rx1; x <= rx2; x += 1) {
        if (inBand(band, x, y)) continue;
        if (channelDiff(a, b, row + x) > tolerance) return false;
      }
    }
  }

  // ② 稀疏全图抽样（跳过所有矩形与其环带）
  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < width; x += step) {
      let skip = false;
      for (const band of bands) {
        if (x >= band.x1 - ring && x <= band.x2 + ring && y >= band.y1 - ring && y <= band.y2 + ring) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      if (channelDiff(a, b, row + x) > tolerance) return false;
    }
  }

  return true;
}
