/**
 * `content/bridge.ts` —— ISOLATED world 消息桥（`run_at: document_start`）。
 *
 * 它是**唯一**把 MAIN world 的解析结果送进扩展的地方，也是 background 想了解页面状态时
 * 唯一的问询入口。职责严格限定为「转发 + 应答」，不含任何解析逻辑。
 *
 * 通道：
 *   page ──(window.postMessage: media-captured)──▶ bridge ──(runtime.sendMessage)──▶ bg
 *   bg ──(tabs.sendMessage: tab:query)──▶ bridge ──(window.postMessage: page-query)──▶ page
 *   bg ──(tabs.sendMessage: content:fetch-blob)──▶ bridge：在页面上下文里 fetch + blob 下载
 *   storage.onChanged(config) ──▶ bridge ──(window.postMessage: page-config)──▶ page
 */

import { MSG } from '../core/constants';
import { createRepeatSuppressor, makeRecord, type DiagRecord } from '../core/diagnostics';
import { envelope, onRuntimeMessage, onWindowMessage, postToWindow, sendToBg } from '../core/messaging';
import { onStateChanged, readConfig } from '../core/storage';
import { CHAT_PATH_PATTERN, CONV_ID_PATTERN, THREAD_PATH_PATTERN, VIDEO_SHARE_PATH_PATTERN, videoShareConvId } from '../core/site-contract';
import type { ConvScope, MediaDraft, PageInfo, PageKind } from '../core/types';

const QUERY_TIMEOUT_MS = 600;

/* --------------------------------------------------------------------------- */
/* 诊断                                                                          */
/* --------------------------------------------------------------------------- */

/** 纯查询回执的重复抑制（§40）：内容不变就不再刷同一条记录 */
const shouldLogDiag = createRepeatSuppressor();

function diag(event: string, detail?: string, options: { level?: 'info' | 'warn' | 'error'; text?: string } = {}): void {
  try {
    if (!shouldLogDiag(event, detail ?? '')) return;
    void sendToBg(MSG.DiagAppend, makeRecord('content', event, detail, options), 'content').catch(() => undefined);
  } catch {
    /* 诊断永远不能影响主流程 */
  }
}

function relay(record: DiagRecord): void {
  void sendToBg(MSG.DiagAppend, record, 'content').catch(() => undefined);
}

/* --------------------------------------------------------------------------- */
/* 向 MAIN world 问询页面信息                                                    */
/* --------------------------------------------------------------------------- */

let querySeq = 0;
const pendingQueries = new Map<string, (info: PageInfo) => void>();

/** bg 请求「重新解析某个 vid」时的等待表（key = reqId） */
let vidReqSeq = 0;
const pendingVidResolves = new Map<string, (url: string | null) => void>();
/** 页面侧要连走三步 API，给足时间 */
const VID_RERESOLVE_TIMEOUT_MS = 40_000;

/** 让 MAIN world 绕过缓存重新解析 vid（签名地址过期后的自愈） */
function askPageReresolve(vid: string): Promise<string | null> {
  return new Promise((resolve) => {
    const reqId = `v${++vidReqSeq}`;
    const timer = setTimeout(() => {
      pendingVidResolves.delete(reqId);
      resolve(null);
    }, VID_RERESOLVE_TIMEOUT_MS);
    pendingVidResolves.set(reqId, (url) => {
      clearTimeout(timer);
      pendingVidResolves.delete(reqId);
      resolve(url);
    });
    postToWindow(envelope('content', MSG.ReresolveVid, { reqId, vid }));
  });
}

/** bg 请求「在页面里定位并预览」时的等待表（key = reqId） */
let locateReqSeq = 0;
const pendingLocates = new Map<string, (found: boolean) => void>();
/** 定位是**同步 DOM 查询**，正常几毫秒就回来；给 5s 足够，超时按「没找到」处理 */
const LOCATE_TIMEOUT_MS = 5_000;

/**
 * 让 MAIN world 在页面里定位这条资源并尽力唤起豆包自己的预览（2026-09-28 第十轮）。
 * 返回是否在 DOM 里找到了它 —— 找不到多半是「消息还没滚到、未渲染」（豆包懒渲染）。
 */
function askPageLocate(keys: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const reqId = `l${++locateReqSeq}`;
    const timer = setTimeout(() => {
      pendingLocates.delete(reqId);
      resolve(false);
    }, LOCATE_TIMEOUT_MS);
    pendingLocates.set(reqId, (found) => {
      clearTimeout(timer);
      pendingLocates.delete(reqId);
      resolve(found);
    });
    postToWindow(envelope('content', MSG.PreviewLocate, { reqId, keys }));
  });
}

/**
 * 页面脚本未应答时的兜底：至少能根据 URL 判断页面类型。
 *
 * ⚠️ `title` 一律留空：这里的 `document.title` 在 SPA 切换瞬间可能是**上一个会话**的标题，
 * 而 background 会拿它去刷新资源库条目的会话名 —— 宁可留空（界面侧用兜底文案显示），
 * 也不要把错标题写进库里。
 */
function fallbackPageInfo(): PageInfo {
  let kind: PageKind = 'none';
  if (CHAT_PATH_PATTERN.test(location.pathname)) kind = 'chat';
  // `/thread/` 与 `/video-sharing`（单条视频分享，2026-10-02 第十六轮）都是分享页
  else if (THREAD_PATH_PATTERN.test(location.pathname) || VIDEO_SHARE_PATH_PATTERN.test(location.pathname)) {
    kind = 'thread';
  }
  const match = location.href.match(CONV_ID_PATTERN);
  // 视频分享页的 id 在查询参数里（路径里没有）→ 交给契约里的同一个函数推导
  const convId = match ? match[1] : videoShareConvId(location.href);
  return {
    kind,
    convId,
    title: '',
    url: location.href,
    injected: true,
  };
}

function askPageInfo(): Promise<PageInfo> {
  return new Promise((resolve) => {
    const reqId = `q${++querySeq}`;
    const timer = setTimeout(() => {
      pendingQueries.delete(reqId);
      resolve(fallbackPageInfo());
    }, QUERY_TIMEOUT_MS);
    pendingQueries.set(reqId, (info) => {
      clearTimeout(timer);
      pendingQueries.delete(reqId);
      resolve(info);
    });
    postToWindow(envelope('content', MSG.PageQuery, { reqId }));
  });
}

/* --------------------------------------------------------------------------- */
/* 取流方案 B：在页面上下文里 fetch + blob（回退路径）                            */
/* --------------------------------------------------------------------------- */

async function downloadViaBlob(url: string, filename: string): Promise<void> {
  // 在豆包页面上下文发起请求：浏览器会自动带上 `Referer: https://www.doubao.com/...`，
  // 这是绕过 CDN 防盗链的关键（Referer 是禁止手动设置的请求头，必须依赖页面来源）。
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

/* --------------------------------------------------------------------------- */
/* 转发 page → bg                                                               */
/* --------------------------------------------------------------------------- */

onWindowMessage((env) => {
  if (env.src !== 'page') return;

  if (env.type === MSG.PageInfo) {
    const payload = env.payload as (PageInfo & { reqId?: string }) | undefined;
    if (payload?.reqId) {
      pendingQueries.get(payload.reqId)?.(payload);
    }
    return;
  }

  if (env.type === MSG.PageDiag) {
    const record = env.payload as DiagRecord | undefined;
    if (record) relay(record);
    return;
  }

  // 会话切换（第四轮）：page 主动上报，bg 据此把资源库裁剪为当前会话
  if (env.type === MSG.ConvScope) {
    const scope = env.payload as ConvScope | undefined;
    if (!scope) return;
    diag('content.scope', `convId=${scope.convId || '-'} kind=${scope.kind} title=${scope.title || '-'}`);
    void sendToBg(MSG.ConvScope, scope, 'content').catch(() => undefined);
    return;
  }

  // 原片已超期（2026-09-27 Finding C）：page 翻遍创作树未见该 vid，bg 据此把条目落成失败态
  if (env.type === MSG.LibraryExpire) {
    const payload = env.payload as { convId?: string; fingerprint?: string; vid?: string } | undefined;
    if (payload?.convId && payload.fingerprint) {
      diag('content.expire', `convId=${payload.convId} fingerprint=${payload.fingerprint}`);
      void sendToBg(MSG.LibraryExpire, payload, 'content').catch(() => undefined);
    }
    return;
  }

  // bg 请求重解析 vid 的应答（page → content）
  if (env.type === MSG.VidResolved) {
    const payload = env.payload as { reqId?: string; url?: string | null } | undefined;
    if (payload?.reqId) pendingVidResolves.get(payload.reqId)?.(payload.url ?? null);
    return;
  }

  // bg 请求「定位并预览」的应答（page → content）
  if (env.type === MSG.PreviewLocated) {
    const payload = env.payload as { reqId?: string; found?: boolean } | undefined;
    if (payload?.reqId) pendingLocates.get(payload.reqId)?.(payload.found === true);
    return;
  }

  if (env.type === MSG.MediaCaptured) {
    const drafts = env.payload as MediaDraft[] | undefined;
    if (!Array.isArray(drafts) || !drafts.length) return;
    void sendToBg(MSG.MediaAppend, drafts, 'content').catch((error: unknown) => {
      // background 尚未唤醒时先丢弃；SSE 会持续推送，下一次就能成功
      diag('content.append', `上报失败：${String((error as Error)?.message ?? error)}`, { level: 'error' });
    });
  }
});

/* --------------------------------------------------------------------------- */
/* 应答 bg / UI                                                                 */
/* --------------------------------------------------------------------------- */

onRuntimeMessage((env, _sender, sendResponse) => {
  if (env.type === MSG.TabQuery) {
    void askPageInfo().then((info) => {
      diag('content.query', `kind=${info.kind} convId=${info.convId || '-'} title=${info.title || '-'}`);
      sendResponse(info);
    });
    return true;
  }

  // bg 发现下载失败（多半是签名地址过期）→ 让页面重解析这个 vid
  if (env.type === MSG.ReresolveVid) {
    const payload = env.payload as { vid?: string } | undefined;
    const vid = payload?.vid ?? '';
    if (!vid) {
      sendResponse({ url: null });
      return undefined;
    }
    void askPageReresolve(vid).then((url) => {
      diag('content.reresolve', `vid=${vid} → ${url ? 'ok' : 'null'}`, { level: url ? 'info' : 'warn' });
      sendResponse({ url });
    });
    return true;
  }

  // bg 请求「在页面里定位这条资源并唤起豆包自己的预览」（资源库卡片的「预览」按钮）
  if (env.type === MSG.PreviewLocate) {
    const payload = env.payload as { keys?: string[] } | undefined;
    const keys = Array.isArray(payload?.keys) ? payload.keys.filter((key) => typeof key === 'string') : [];
    if (!keys.length) {
      sendResponse({ found: false });
      return undefined;
    }
    void askPageLocate(keys).then((found) => {
      diag('content.preview', `定位 keys=${keys.length} → ${found ? 'found' : 'not-found'}`, {
        level: found ? 'info' : 'warn',
      });
      sendResponse({ found });
    });
    return true;
  }

  if (env.type === MSG.FetchBlob) {    const payload = env.payload as { url?: string; filename?: string } | undefined;
    if (!payload?.url || !payload.filename) {
      sendResponse({ ok: false, error: '参数缺失' });
      return undefined;
    }
    void downloadViaBlob(payload.url, payload.filename)
      .then(() => {
        diag('content.blob', `下载成功 ${payload.filename}`);
        sendResponse({ ok: true });
      })
      .catch((error: unknown) => {
        const message = String((error as Error)?.message ?? error);
        diag('content.blob', `下载失败 ${payload.filename}：${message}`, { level: 'error' });
        sendResponse({ ok: false, error: message });
      });
    return true;
  }

  return undefined;
});

/* --------------------------------------------------------------------------- */
/* 配置下发（唯一的 content → page 主动推送）                                     */
/* --------------------------------------------------------------------------- */

void readConfig().then((config) => {
  postToWindow(envelope('content', MSG.PageConfig, config));
});

diag('content.ready', `href=${location.href.slice(0, 140)}`);

onStateChanged((change) => {
  if (change.config) {
    postToWindow(envelope('content', MSG.PageConfig, change.config));
  }
});
