/**
 * 弹窗列表的「滚轮 = 整屏」翻页（2026-10-04 第三十三轮 §51）。
 *
 * ## 口径（用户 2026-10-04 拍板）
 *   · **一格滚轮 = 一屏**：列表 5 行、网格两排 4 列 —— 行数常量见下，与 `popup.css` 文首那张
 *     纵向预算表**同源**（改版式要一起看，否则滚一屏会与卡片错位）；
 *   · **批量条出现时不改步长**：列表可视高变矮就让它遮住第 5 行一点，不做自适应；
 *   · **不接管键盘**：PageDown / 空格 / 方向键维持浏览器原生滚动（原生一次 ~393px，不是
 *     375/376，会停在半屏）——由 `nextSnapTarget()` 的「落到下一个整屏边界」自动纠偏；
 *   · `Ctrl+滚轮`（缩放）与横向滚轮一律放行；指针不在列表里时不介入（保持「在头部/工具条上
 *     滚轮不翻页」的原状）。
 *
 * ## 为什么不用 CSS `scroll-snap-type`
 * 它只能**按卡片**吸附（吸附点来自 `.card` 的 `scroll-snap-align`）⇒ 一格滚轮只走 1~2 行，
 * 做不到「一格一屏」；要按屏吸附就得给每 5 行 / 每 2 排套一层 wrapper，而卡片查询
 * （补角封面的 IntersectionObserver、多选、`data-id`）全挂在 `.card` 上 —— 代价与风险都更大。
 *
 * ## 为什么不给 `.list` 加 `scroll-behavior: smooth`
 * 那样连 `render()` 还原滚动位置的赋值都会变成动画（每次重渲都从 0 滑回去）。平滑只在本次
 * 翻页里显式指定（`scrollTo({ behavior })`）。
 *
 * ## 触控板与滚轮的区别（本模块的核心难点）
 * 鼠标一格 = **单次** ~100px 事件；触控板一次手势 = 几十个 1~5px 的小事件。
 * 若「每个事件滚一屏」，触控板轻扫一下会飞几十屏 ⇒ 小事件走「累积到阈值算一步 + 同一手势
 * 只算一步（静默 150ms 重新起算）」；大事件视作一格，直接出一屏。
 */

/** 一屏的行数：列表 5 行、网格两排 4 列（与 `popup.css` 文首预算表同源） */
const ROWS_LIST = 5;
const ROWS_GRID = 2;

/** 单次 wheel 事件达到这个量（px）即视作滚轮的「一格」（Chromium 一格 ≈ 100px） */
const NOTCH_MIN = 40;
/** 触控板手势的静默间隔（ms）：静默这么久 = 手势结束，重新起算累积 */
const BURST_IDLE_MS = 150;
/** 平滑滚动期间的锁（ms）：锁内来的格只记账，动画结束后逐个补上 */
const ANIM_LOCK_MS = 260;
/** 待办最多积这么多步（防止长按滚轮后还在自己滚） */
const MAX_PENDING = 3;
/** 与整屏边界的容差（px）：平滑动画收尾时 `scrollTop` 会带小数 */
const EDGE_EPS = 2;

/**
 * 下一个整屏位置（纯函数，有单测）。
 *
 * · `dir = 1` → **严格大于**当前位置的下一个整屏边界；`dir = -1` → 严格小于的上一个边界；
 * · 停在半屏时（原生键盘滚动 / 拖过滚动条之后）只补到**下一个**边界，不跳过没看过的内容 ——
 *   若按「先对齐再走一屏」，从 200px 会直接跳到 750px，而 593~750 那段用户从没看见；
 * · 结果钳在 `[0, max]`；到头了返回原位，调用方据此放行这一下。
 */
export function nextSnapTarget(current: number, step: number, max: number, dir: 1 | -1): number {
  const limit = Math.max(0, max);
  const from = Math.min(Math.max(current, 0), limit);
  if (!(step > 0)) return from;
  const edge = Math.round(from / step);
  const onEdge = Math.abs(from - edge * step) <= EDGE_EPS;
  const base = onEdge ? edge : dir > 0 ? Math.floor(from / step) : Math.ceil(from / step);
  return Math.min(Math.max((base + dir) * step, 0), limit);
}

/** 一屏的像素高度 =（卡高 + 行距）× 行数 —— 从 DOM 现算，避免与 CSS 两处硬编码对不上 */
function snapStep(list: HTMLElement): number {
  const wrap = list.querySelector<HTMLElement>('.grid-wrap');
  const card = wrap?.querySelector<HTMLElement>('.card');
  if (!wrap || !card) return 0;
  const gap = Number.parseFloat(getComputedStyle(wrap).rowGap) || 0;
  const rows = wrap.classList.contains('list-mode') ? ROWS_LIST : ROWS_GRID;
  return (card.offsetHeight + gap) * rows;
}

/** 系统的「减少动态效果」偏好（懒取，理由同 `dom.ts::systemDarkQuery`：模块顶层碰 window 会让 node 测试 import 失败） */
let reduceMotion: MediaQueryList | null = null;

function wantsReducedMotion(): boolean {
  reduceMotion ??= window.matchMedia('(prefers-reduced-motion: reduce)');
  return reduceMotion.matches;
}

/**
 * 装上滚轮翻页。挂在 `root` 上**委托一次**即可 —— `render()` 会重建 `.list`，
 * 逐元素绑定会掉（同守则 2 的理由）。
 */
export function wireSnapScroll(root: HTMLElement): void {
  let acc = 0; // 本次手势累积的小量
  let burstUsed = false; // 本次手势已经出过一步（触控板惯性的尾巴丢掉）
  let burstTimer: ReturnType<typeof setTimeout> | null = null;
  let lockUntil = 0; // 平滑动画期间的锁
  let pending = 0; // 锁内欠下的步数（带符号）
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function step(dir: 1 | -1): void {
    const list = root.querySelector<HTMLElement>('.list');
    if (!list) return;
    const size = snapStep(list);
    const max = list.scrollHeight - list.clientHeight;
    if (!(size > 0) || max <= 0) return;
    const target = nextSnapTarget(list.scrollTop, size, max, dir);
    if (target === list.scrollTop) {
      pending = 0; // 到头了：欠的步数作废，别让它攒着
      return;
    }
    list.scrollTo({ top: target, behavior: wantsReducedMotion() ? 'auto' : 'smooth' });
    lockUntil = Date.now() + ANIM_LOCK_MS;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      lockUntil = 0;
      if (!pending) return;
      const next: 1 | -1 = pending > 0 ? 1 : -1;
      pending -= next;
      step(next);
    }, ANIM_LOCK_MS);
  }

  /** 锁内只记账（快速连拨因此能 1:1 跟手），否则立刻翻 */
  function request(dir: 1 | -1): void {
    if (Date.now() < lockUntil) {
      pending = Math.max(-MAX_PENDING, Math.min(MAX_PENDING, pending + dir));
      return;
    }
    step(dir);
  }

  root.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey) return; // 缩放放行
      const dy = event.deltaY;
      if (!dy || Math.abs(event.deltaX) > Math.abs(dy)) return; // 横向滚轮放行
      if (!(event.target as HTMLElement | null)?.closest('.list')) return; // 只在列表内接管
      const list = root.querySelector<HTMLElement>('.list');
      if (!list) return;
      const max = list.scrollHeight - list.clientHeight;
      if (!(snapStep(list) > 0) || max <= 0) return; // 没得滚：完全放行
      // 到这一步就一定「接管」：不足阈值的小量也不能放给浏览器（否则原生像素滚动会与整屏错位）
      event.preventDefault();

      if (Math.abs(dy) >= NOTCH_MIN) {
        // 滚轮的一格
        acc = 0;
        burstUsed = false;
        if (burstTimer) {
          clearTimeout(burstTimer);
          burstTimer = null;
        }
        request(dy > 0 ? 1 : -1);
        return;
      }

      // 触控板：同一手势内只出一屏
      if (burstTimer) clearTimeout(burstTimer);
      burstTimer = setTimeout(() => {
        burstTimer = null;
        acc = 0;
        burstUsed = false;
      }, BURST_IDLE_MS);
      if (burstUsed) return;
      acc += dy;
      if (Math.abs(acc) < NOTCH_MIN) return;
      burstUsed = true;
      acc = 0;
      request(dy > 0 ? 1 : -1);
    },
    { passive: false },
  );
}
