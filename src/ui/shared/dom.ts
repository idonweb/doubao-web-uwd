/** UI 通用工具：转义、格式化、主题、Toast、复制 */

import type { Config, MediaItem, MediaState } from '../../core/types';
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

/** 卡片副信息：`2048×2048 · 3.2 MB`；信息不足时退回扩展名 */
export function itemMetaLine(item: MediaItem): string {
  const parts: string[] = [];
  if (item.meta.width && item.meta.height) {
    // 视频宽高常是预览转码流的规格（`docs/03` §12），如实标注「预览」，避免与清晰度标签矛盾
    const dims = `${item.meta.width}×${item.meta.height}`;
    parts.push(item.meta.dimsPreview ? `预览 ${dims}` : dims);
  }
  const size = fmtBytes(item.meta.size);
  if (size) parts.push(size);
  if (!parts.length) return (item.meta.ext || 'bin').toUpperCase();
  return parts.join(' · ');
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
 * 「原片已超期」（2026-09-27 Finding C）：页面已翻遍整棵「我的创作」树仍未找到该 vid
 * —— 站点对创作记录有保存期限，原片永远取不到了。这是确定性结论，与「获取失败」
 * （下载失败 / 网络问题，可重试）区分开。样式沿用 fail 的红调。
 */
export function stateTagLabel(item: MediaItem): string {
  if (item.meta.expired) return '原片已超期';
  const base = STATE_TAG[item.state].label;
  return item.state === 'raw' && item.meta.label ? `${base}${item.meta.label}` : base;
}

/* --------------------------------------------------------------------------- */
/* 主题                                                                          */
/* --------------------------------------------------------------------------- */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(theme: Config['theme']): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme;
  return darkQuery.matches ? 'dark' : 'light';
}

/** 跟随系统主题变化（仅在 theme === 'system' 时生效） */
export function watchSystemTheme(getTheme: () => Config['theme'], onChange: () => void): void {
  darkQuery.addEventListener('change', () => {
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
