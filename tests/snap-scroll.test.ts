/**
 * 滚轮翻页的整屏对齐（`nextSnapTarget`）—— 2026-10-04 第三十三轮 §51。
 *
 * 口径（用户拍板）：一格滚轮 = 一屏 —— **列表 5 行 / 网格两排 4 列**，批量条出现时也不改步长。
 * 步长由 `popup.css` 的纵向预算决定，这里按实测值代入：
 *   · 列表：卡 66 + 行距 9 = 75 → × 5 行 = **375**；
 *   · 网格：卡 179 + 行距 9 = 188 → × 2 排 = **376**。
 * DOM 那半边（`snapStep` / `wireSnapScroll`）不在 node 环境里测，靠离屏渲染核对。
 */

import { describe, expect, it } from 'vitest';

import { nextSnapTarget } from '../src/ui/shared/snap-scroll';

const STEP = 375; // 列表一屏
const GRID_STEP = 376; // 网格一屏
const MAX = 1_500;

describe('nextSnapTarget（滚轮翻页的整屏对齐）', () => {
  it('整屏边界上：一次就是整整一屏', () => {
    expect(nextSnapTarget(0, STEP, MAX, 1)).toBe(375);
    expect(nextSnapTarget(375, STEP, MAX, 1)).toBe(750);
    expect(nextSnapTarget(750, STEP, MAX, -1)).toBe(375);
    expect(nextSnapTarget(375, STEP, MAX, -1)).toBe(0);
  });

  it('停在半屏（原生键盘滚动 / 拖过滚动条）时补到下一个边界，不跳过没看过的内容', () => {
    expect(nextSnapTarget(200, STEP, MAX, 1)).toBe(375);
    expect(nextSnapTarget(200, STEP, MAX, -1)).toBe(0);
    // 503 = 一屏多一点 ⇒ 往下只到 750；若按「先对齐再走一屏」会跳到 1125（跳过 593~750）
    expect(nextSnapTarget(503, STEP, MAX, 1)).toBe(750);
  });

  it('平滑动画收尾的小数视作就在边界上（否则会「吃掉一格」）', () => {
    expect(nextSnapTarget(374.5, STEP, MAX, 1)).toBe(750);
    expect(nextSnapTarget(375.4, STEP, MAX, 1)).toBe(750);
    expect(nextSnapTarget(374.5, STEP, MAX, -1)).toBe(0);
  });

  it('首尾钳位：到头返回原位（调用方据此放行），末屏不满一屏也不回弹', () => {
    expect(nextSnapTarget(0, STEP, MAX, -1)).toBe(0);
    expect(nextSnapTarget(MAX, STEP, MAX, 1)).toBe(MAX);
    expect(nextSnapTarget(0, STEP, 0, 1)).toBe(0); // 内容不足一屏
    expect(nextSnapTarget(1_300, STEP, 1_400, 1)).toBe(1_400);
  });

  it('网格步长（376）同样成立', () => {
    expect(nextSnapTarget(0, GRID_STEP, 2_000, 1)).toBe(376);
    expect(nextSnapTarget(376, GRID_STEP, 2_000, 1)).toBe(752);
    expect(nextSnapTarget(752, GRID_STEP, 2_000, -1)).toBe(376);
  });

  it('步长非法（0 / 负）时原样返回，不做任何滚动', () => {
    expect(nextSnapTarget(120, 0, MAX, 1)).toBe(120);
    expect(nextSnapTarget(120, -5, MAX, 1)).toBe(120);
  });
});
