/** UI 通用工具：转义、格式化、主题、Toast、复制 */

import type { Config, MediaItem, MediaState } from '../../core/types';
import { sizeForOf } from '../../core/library-store';
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
 */
export function stateTagLabel(item: MediaItem): string {
  if (item.meta.expired && item.state !== 'raw') return RAW_UNAVAILABLE_LABEL[item.convKind];
  const base = STATE_TAG[item.state].label;
  return item.state === 'raw' && item.meta.label ? `${base}${item.meta.label}` : base;
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
 */
const RAW_UNAVAILABLE_LABEL: Record<MediaItem['convKind'], string> = {
  chat: '原片已超期',
  thread: '原片不可得',
};

/** 「取不到原片」时的悬停说明：两种可能都列出来，不替用户下结论 */
const RAW_UNAVAILABLE_TITLE =
  '取不到无水印原片：原片地址只对作品所属账号开放；若这就是你自己的作品，也可能已超出站点保存期（约三个月）';

/** 状态标签的悬停说明：只有「取不到原片」时有内容，其余返回空串 */
export function stateTagTitle(item: MediaItem): string {
  if (item.meta.expired && item.state !== 'raw') return RAW_UNAVAILABLE_TITLE;
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
