/** UI 通用工具：转义、格式化、主题、Toast、复制 */

import type { Config, MediaItem, MediaState } from '../../core/types';
import { CHAT_EXPIRED_LABEL, IMG_PATCH_FAIL_LABEL, IMG_PATCH_LABEL, SHARE_VIDEO_LABEL } from '../../core/constants';
import { needsShareWatermark, sizeForOf } from '../../core/library-store';
import type { IconName } from './icons';

/** HTML 转义 —— 上游把未转义的 URL 直接拼进 href，属于注入风险，这里统一收口 */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const total = Math.round(seconds);
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** 时间戳 → `09-26 14:20`（今天则显示 `14:20`） */
export function fmtClock(ts: number): string {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) return `${p2(date.getHours())}:${p2(date.getMinutes())}`;
  return `${p2(date.getMonth() + 1)}-${p2(date.getDate())} ${p2(date.getHours())}:${p2(date.getMinutes())}`;
}

/**
 * 卡片副信息：`2048×2048 · 3.2 MB`；信息不足时退回扩展名。
 * （真实生成时间不在这里 —— 它由 `itemTimeLabel()` 单独给出，位置见 `popup.ts` 的卡片模板。）
 *
 * 「预览」前缀（2026-10-02 §37 起用；§39 改为**按体积归属**判定，用户拍板）：
 * 原片还没就绪时，卡片上那个数字描述的是**带水印候选流**（点下载此刻会拿到的那个文件），
 * 如实标成「预览 3.1 MB」；拿到原片字节数（创作树真值 / 对原片的实测）后变回纯数字。
 *   ① 判据 = `sizeForOf(item)`（**跟着数字走的归属标记**），**不是** `primaryIsRaw()` ——
 *      后者是现场推断，在「实测候选流 → 原片才切过来」的竞态下会把候选流的数字当成原片体积
 *      （实机 bug：卡片 `3.0 MB` + 「无水印原片」，而真原片 `7.1 MB`，见 `docs/03` §39）；
 *   ② 宽高本来就是预览规格时（`meta.dimsPreview`，如 `预览 384×216`）**不再重复**两个字 ——
 *      整行读作「预览 384×216 · 3.1 MB」，前缀对整个规格串生效。
 */
export function itemMetaLine(item: MediaItem): string {
  const parts: string[] = [];
  const dimsPreview = Boolean(item.meta.dimsPreview && item.meta.width && item.meta.height);
  if (item.meta.width && item.meta.height) {
    // 视频宽高常是预览转码流的规格（`docs/03` §12），如实标注「预览」，避免与清晰度标签矛盾
    const dims = `${item.meta.width}×${item.meta.height}`;
    parts.push(dimsPreview ? `预览 ${dims}` : dims);
  }
  const size = fmtBytes(item.meta.size);
  if (size) parts.push(dimsPreview || sizeForOf(item) === 'raw' ? size : `预览 ${size}`);
  if (!parts.length) return (item.meta.ext || 'bin').toUpperCase();
  return parts.join(' · ');
}

/**
 * 卡片上的**真实生成时间**文案（2026-09-28 第十轮）。
 *
 * 来源是站点创作树节点的 `create_time`（`meta.createdAt`）—— 「这条作品什么时候生成的」。
 * 格式由 `fmtClock()` 给：今天 → `22:54`，其它日子 → `09-27 22:54`。
 * 拿不到就返回空串（图片目前没有这个字段、视频在解析成功前也没有）—— **不编造**。
 *
 * 展示位置：网格视图在**缩略图左上角**（与左下角「时长 / 格式」药丸同一套视觉语言）；
 * 列表视图缩略图只有 52px 放不下，退回卡片副信息行 —— 两处的显隐由 CSS 按视图切换。
 */
export function itemTimeLabel(item: MediaItem): string {
  const ts = item.meta.createdAt;
  if (!ts) return '';
  return fmtClock(ts);
}

export const STATE_TAG: Record<MediaState, { cls: string; label: string; icon: IconName }> = {
  raw: { cls: 't-raw', label: '无水印原片', icon: 'check' },
  thumb: { cls: 't-thumb', label: '仅缩略图', icon: 'image' },
  pending: { cls: 't-mid', label: '解析中', icon: 'clock' },
  fail: { cls: 't-fail', label: '获取失败', icon: 'alert' },
};

/**
 * 状态标签文案：视频拿到原片清晰度后拼成 `无水印原片720P`。
 *
 * `meta.label` 是 vid 三步 API 按**原片真实宽高**派生的（`docs/03` §12.7），
 * 所以它与用户真正下载到的文件一致；解析还没回来（`pending` / `fail`）
 * 或尺寸不是已知档位时就没有后缀，只显示「无水印原片」。
 *
 * 「原片已超期」（2026-09-27 Finding C）：页面已翻遍整棵「我的创作」树（且走完二次确认窗口）
 * 仍未找到该 vid —— 站点对创作记录有保存期限。与「获取失败」（下载失败 / 网络问题，可重试）
 * 区分开。样式沿用 fail 的红调。
 *
 * ⚠️ **正证据优先**（2026-09-28 第十轮）：只要条目已经拿到原片（`state === 'raw'`），
 * 一律按 raw 显示 —— 这个标记是弱结论，不得压过「原片已经在手」这个事实。
 *
 * 🆕 **补角重建**（2026-10-03 §43.9 方案 B）：条目带 `meta.patch` 说明这一族站点**没给**原片
 * （老链路 `image_list` 只给两张带水印的同源底图），无水印是**下载时互补还原**出来的 ——
 * 所以文案写「无水印（补角重建）」而不是「无水印原片」；同源校验没过时写「仅带水印档」。
 */
/**
 * 状态标签**三件套**（cls / label / icon）的唯一出口（2026-10-03 §48.7）。
 *
 * 文案与配色必须**同源**：分享页视频语义是「无水印可用」，
 * 配色就跟着翻成成功绿（`t-raw` + check 图标），不再继承 fail 的红 + alert ——
 * 实机反馈（19-48-55.png）：红色让用户误以为解析失败。
 * `shareDlFail`（这次直链没解出）是真失败，维持红 + alert。
 * 卡片渲染（`popup.ts::cardHtml`）一律经此取三件套，不得再直读 `STATE_TAG[item.state]`。
 *
 * ⚠️ **标签判据 = 行为判据**（2026-10-04 §55，用户拍板）：`needsShareWatermark()` 成立即标，
 * **不再额外要求 `meta.expired`**。成因（实机体感缺口的正解）：
 *   · 分享页的**下载能力当场就成立**（`thread` 无条件），而 `meta.expired` 要等 vid 三步链路
 *     翻完整棵树 + 二次确认窗口才落（`/video-sharing` 无 `create_time` ⇒ 必然等满
 *     `VID_EXPIRED_CONFIRM_MS` = 20s；`/thread/` 若分享的是**新生成**的视频，还会被
 *     「新作品入库窗口」拖到 30min）⇒ 出现「点下载已经生效、标签还停在『解析中』」的落差。
 *   · §53 当初多要求 `meta.expired`，是怕「其实是本账号作品、不该提前说成分享页」；
 *     但 2026-10-04 实测**三步真原片 ≡ fplay 原画质档（同一文件）**，这条路给的东西一样，顾虑不成立。
 *   · 若随后确实拿到原片（`state='raw'`）→ `needsShareWatermark()` 自然为假 → 自动升「无水印原片720P」。
 * ⚠️ **对话页超期视频不受影响**：它的 `needsShareWatermark()` 本身就含 `meta.expired`。
 * ⚠️ 图片条目（含分享页图片）仍走 fail 红原口径「原片不可得 / 原片已超期」。
 * ⚠️ **悬停说明（`stateTagTitle`）不跟着放行**：成功口径仍等 `meta.expired`（见那里的说明）。
 */
export function stateTagOf(item: MediaItem): { cls: string; label: string; icon: IconName } {
  /*
   * 要靠「站点播放源换无水印」的视频（`needsShareWatermark`：分享页视频 + 对话页超期视频）。
   * 这里 expired **不再是「失败」语义** —— 无水印仍可下（分享页 `/thread/` 免登录、
   * `/video-sharing` 需任意账号登录；对话页超期走同一套 fplay 原画质档，2026-10-04 §53）。
   * 按补角先例「落地即标能力、失败才降级」：默认绿（t-raw + check）；
   * bg 回写 `shareDlFail`（这次没解出）才降红「仅带水印档」。
   * 文案按来源分：分享页 = 「无水印（分享页）」；对话页超期 = 「无水印（超期补救）」。
   */
  if (needsShareWatermark(item)) {
    if (item.meta.shareDlFail) return { ...STATE_TAG.fail, label: IMG_PATCH_FAIL_LABEL };
    return item.convKind === 'thread'
      ? { ...STATE_TAG.raw, label: SHARE_VIDEO_LABEL }
      : { ...STATE_TAG.raw, label: CHAT_EXPIRED_LABEL };
  }
  if (item.meta.expired && item.state !== 'raw') {
    return { ...STATE_TAG.fail, label: RAW_UNAVAILABLE_LABEL[item.convKind] };
  }
  if (item.state === 'raw' && item.meta.patch) {
    return item.meta.patchFail
      ? { ...STATE_TAG.raw, label: IMG_PATCH_FAIL_LABEL }
      : { ...STATE_TAG.raw, label: IMG_PATCH_LABEL };
  }
  const base = STATE_TAG[item.state];
  const label = item.state === 'raw' && item.meta.label ? `${base.label}${item.meta.label}` : base.label;
  return { ...base, label };
}

export function stateTagLabel(item: MediaItem): string {
  return stateTagOf(item).label;
}

/**
 * 「取不到原片」时的两种说法（2026-09-28）—— **宁缺勿假也适用于结论文案**。
 *
 * 原片只有一条路：`vid → 我的创作 → get_download_info`，而「我的创作」**按登录账号隔离**。
 * 三步 API 只能说明「这棵树里没有这个 vid」，**无法区分**两种原因：
 *   · 作品超出站点保存期（约三个月）；
 *   · 作品不属于当前登录账号 —— 别人的作品永远不会出现在自己的「我的创作」里。
 * （实测：同一条分享链接，作品所属账号能解出 6.3 MB 原片，其它账号不能。）
 *
 * 因此按页面类型分开说：**对话页**的会话必然是自己的 → 「原片已超期」成立；
 * **分享页**两种原因都可能 → 只如实说「原片不可得」，原因见悬停说明。
 *
 * ⚠️ **分享页视频例外**（2026-10-03 §48.7）：这类条目已不再用上面的文案 ——
 * 分享直链两档无水印可下（`SHARE_VIDEO_LABEL`），判定的**能力口径**变了，见 `stateTagLabel`。
 * 本表只剩对话页与分享页**图片**条目在用。
 */
const RAW_UNAVAILABLE_LABEL: Record<MediaItem['convKind'], string> = {
  chat: '原片已超期',
  thread: '原片不可得',
};

/** 「取不到原片」时的悬停说明：两种可能都列出来，不替用户下结论 */
const RAW_UNAVAILABLE_TITLE =
  '取不到无水印原片：原片地址只对作品所属账号开放；若这就是你自己的作品，也可能已超出站点保存期（约三个月）';

/**
 * 「无水印（分享页）」的悬停说明（2026-10-03 §48.7）—— 讲清三件事：
 * 为什么原片不可得（树按账号隔离）、无水印从哪来（分享直链两档）、以及直链的时效性
 * （现解现用，绝不入库）。与补角说明同一哲学：不让用户误以为站点给了原片。
 */
const SHARE_VIDEO_TITLE =
  '分享页视频：创作树原片不可得（原片只对作品所属账号开放），但分享直链可下无水印 —— ' +
  '「下载」= 轻量档、「原画」= 原画质档。直链带时效，下载时现解现用。';

/**
 * 分享直链**这次没解出**（`meta.shareDlFail`，bg 回写）的悬停说明 —— 如实说这次下到的是什么、
 * 怎么恢复。失败原因（未登录 / 分享失效 / 网络）与两条链路的登录要求都列出来，不替用户下结论。
 */
const SHARE_DL_FAIL_TITLE =
  '这次分享直链没有解出（未登录 / 分享已失效 / 网络问题），下到的是站点给的带水印播放档 —— 不假装无水印。' +
  '可再点一次「下载」重试（/thread/ 页免登录；/video-sharing 页需任意账号登录），成功后本标签自动恢复。';

/**
 * 「补角重建」的悬停说明（2026-10-03 §43）—— 把「为什么不是原片」讲清楚，
 * 而不是让用户以为站点给了原片。实测口径见 `docs/03` §43。
 */
const PATCH_TITLE =
  '无水印 · 补角重建：这一档站点只给了两张带水印的图（水印分别在左上与右下，底图完全相同）。' +
  '下载时插件用另一张的同位置像素补掉水印 —— 补角区域之外与原图逐像素一致。';

/** 同源校验没过时的悬停说明：说清「不补角」与「下到的是什么」 */
const PATCH_FAIL_TITLE =
  '补角不可用：这两张图不是同一张底图（同源校验未通过），所以插件**不做**补角 —— ' +
  '现在下到的是带水印的预览档，不会冒充无水印。可 F5 重新解析后再试。';

/**
 * 「超期补救」的悬停说明（2026-10-04 第三十五轮）—— 对话页创作者本人的老视频。
 * 讲清三件事：为什么原片没了（创作树只留约三个月）、无水印从哪来（站点播放源换原画质档）、
 * 直链带时效（现解现用、不入库）。与分享页说明同一哲学，但**不说「分享页」**。
 */
const CHAT_EXPIRED_TITLE =
  '原片已超期（创作树只保留约三个月），但站点播放源仍能换出**无水印原画质档** —— ' +
  '「下载」会在下载那一刻现场解析（直链带时效，不入库）；失败时如实回退站点给的带水印档。';

/** 「超期补救」这次没解出（`meta.shareDlFail`）的悬停说明：如实说下到的是什么、怎么恢复 */
const CHAT_EXPIRED_FAIL_TITLE =
  '这次没换到无水印档（未登录 / 播放源已失效 / 网络问题），下到的是站点给的带水印档 —— 不假装无水印。' +
  '可再点一次「下载」重试，成功后本标签自动恢复。';

/**
 * 状态标签的悬停说明：只有「取不到原片」「播放源换无水印」「补角」这几种有内容，其余返回空串。
 *
 * ⚠️ **与标签判据不同源**（2026-10-04 §55，用户拍板）：标签可以乐观提前翻绿
 * （`stateTagOf` 只看 `needsShareWatermark()`），但**成功口径的说明仍等 `meta.expired`** ——
 * 「创作树原片不可得」这句结论要确认后才说，不提前下断言。
 * 反例（不受此限制）：`shareDlFail` 是 bg 当场回写的**真结论**（这次确实没解出）⇒ 立即给失败说明，
 * 否则卡片标着红「仅带水印档」却没有任何解释。
 */
export function stateTagTitle(item: MediaItem): string {
  if (needsShareWatermark(item)) {
    if (item.meta.shareDlFail) {
      return item.convKind === 'thread' ? SHARE_DL_FAIL_TITLE : CHAT_EXPIRED_FAIL_TITLE;
    }
    if (item.meta.expired) {
      return item.convKind === 'thread' ? SHARE_VIDEO_TITLE : CHAT_EXPIRED_TITLE;
    }
    return '';
  }
  if (item.meta.expired && item.state !== 'raw') return RAW_UNAVAILABLE_TITLE;
  if (item.state === 'raw' && item.meta.patch) return item.meta.patchFail ? PATCH_FAIL_TITLE : PATCH_TITLE;
  return '';
}

/* --------------------------------------------------------------------------- */
/* 主题                                                                          */
/* --------------------------------------------------------------------------- */

/**
 * 系统深色偏好 —— **懒取**（2026-10-02 §37）。
 *
 * 原先在模块顶层直接 `window.matchMedia(...)`，于是这个文件在 node 环境里**无法被 import**
 * （`window is not defined`）——同文件的 `itemMetaLine()` 等纯函数因此没法单测。
 * 改成首次使用时才创建：对象仍是同一个、`.matches` 仍然是实时的，行为不变。
 */
let darkQuery: MediaQueryList | null = null;

function systemDarkQuery(): MediaQueryList {
  darkQuery ??= window.matchMedia('(prefers-color-scheme: dark)');
  return darkQuery;
}

export function resolveTheme(theme: Config['theme']): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme;
  return systemDarkQuery().matches ? 'dark' : 'light';
}

/** 跟随系统主题变化（仅在 theme === 'system' 时生效） */
export function watchSystemTheme(getTheme: () => Config['theme'], onChange: () => void): void {
  systemDarkQuery().addEventListener('change', () => {
    if (getTheme() === 'system') onChange();
  });
}

/* --------------------------------------------------------------------------- */
/* Toast                                                                         */
/* --------------------------------------------------------------------------- */

let toastHost: HTMLElement | null = null;

export function toast(message: string, isError = false): void {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = message;
  toastHost.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 1800);
}

/* --------------------------------------------------------------------------- */
/* 剪贴板 / 扩展管理页                                                            */
/* --------------------------------------------------------------------------- */

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 打开浏览器扩展管理页（Edge 用 edge:// 前缀） */
export function openExtensionManager(): void {
  const isEdge = /Edg\//.test(navigator.userAgent);
  const scheme = isEdge ? 'edge' : 'chrome';
  const url = `${scheme}://extensions/?id=${chrome.runtime.id}`;
  void chrome.tabs.create({ url });
}
