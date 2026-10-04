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

import { LIMITS, MSG } from '../core/constants';
import { createRepeatSuppressor, makeRecord, type DiagRecord } from '../core/diagnostics';
import { buildFplayUrl, isFplayUrl, pickFplayUrl } from '../core/fplay';
import { clampPatchRect, coverSize, isSameSource, patchExcludeRects } from '../core/image-patch';
import { envelope, onRuntimeMessage, onWindowMessage, postToWindow, sendToBg } from '../core/messaging';
import { onStateChanged, readConfig } from '../core/storage';
import {
  CHAT_PATH_PATTERN,
  CONV_ID_PATTERN,
  IMG_PATCH_VERIFY_STEP,
  THREAD_PATH_PATTERN,
  VIDEO_MODEL_ENDPOINT,
  VIDEO_MODEL_FALLBACK_KEY,
  VIDEO_MODEL_MODEL_PATH,
  VIDEO_MODEL_QUERY,
  VIDEO_MODEL_RESULT_PATH,
  VIDEO_MODEL_URI_KEY,
  VIDEO_SHARE_PATH_PATTERN,
  videoShareConvId,
} from '../core/site-contract';
import type { ConvScope, ImagePatch, MediaDraft, PageInfo, PageKind, ShareQuality } from '../core/types';

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
  triggerBlobDownload(blob, filename);
}

/** 把 blob 落盘（blob URL + 隐藏 `<a download>`，用完即撤） */
function triggerBlobDownload(blob: Blob, filename: string): void {
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
/* 补角重建（2026-10-03 第二十三轮 §43.9 方案 B）                                 */
/* --------------------------------------------------------------------------- */

/** 取一档图的位图。`credentials: 'omit'` —— 签名在 URL 里，不需要 cookie */
async function bitmapOf(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

/** 把位图画进离屏画布并读出像素（先铺白底，与看图软件显示一致） */
function rasterize(bitmap: ImageBitmap): { ctx: OffscreenCanvasRenderingContext2D; data: Uint8ClampedArray } | null {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  return { ctx, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
}

/**
 * **补角合成**（2026-10-03 第二十三轮 §43；第三十一轮抽成共用件）。
 *
 * 步骤：取两档 → 尺寸校验 → 矩形夹取 → **同源校验** → 覆盖。**不落盘**，只回一块补好的画布 ——
 * 「下载」与「卡片封面」共用它（前者编码成 PNG 落盘，后者降采样成小图给弹窗）。
 *
 * ⚠️ 失败分两类，调用方要区别对待：
 *   · `mismatch: true`  —— 两档不是同一张底图 / 尺寸不一致 / 矩形非法：**预期内的兜底分支**
 *     （下载链路据此把条目标成「仅带水印档」）；
 *   · `mismatch: false` —— 取图失败 / 页面不支持 canvas：**环境问题**，不该改条目状态。
 */
type ComposeOutcome =
  | { ok: true; canvas: OffscreenCanvas; rect: { x: number; y: number; w: number; h: number } }
  | { ok: false; mismatch: boolean; error: string };

async function composePatched(url: string, patch: ImagePatch): Promise<ComposeOutcome> {
  let base: ImageBitmap | null = null;
  let source: ImageBitmap | null = null;
  try {
    [base, source] = await Promise.all([bitmapOf(url), bitmapOf(patch.url)]);
    if (base.width !== source.width || base.height !== source.height) {
      return {
        ok: false,
        mismatch: true,
        error: `两档尺寸不一致（${base.width}×${base.height} / ${source.width}×${source.height}）`,
      };
    }
    const rect = clampPatchRect(patch.rect, base.width, base.height);
    if (!rect) return { ok: false, mismatch: true, error: '补角矩形非法' };

    const baseRaster = rasterize(base);
    const sourceRaster = rasterize(source);
    if (!baseRaster || !sourceRaster) return { ok: false, mismatch: false, error: '页面不支持 canvas 2D' };

    /*
     * **同源校验**（缺不得）：补角的正确性完全建立在「两档是同一张底图」之上。
     * 不通过就什么都别做 —— 覆盖上去只会把别处的画面糊进水印位置，比带水印更糟。
     *
     * ⚠️ 要排除**两块**水印矩形：底板左上的补角矩形 + **来源档自己的右下那处**
     *    （只排前者 ⇒ 稀疏采样必扫到来源档水印 ⇒ 恒定判失败，2026-10-03 第二十六轮实机修复）。
     */
    const exclude = patchExcludeRects(rect, base.width, base.height);
    if (!isSameSource(baseRaster.data, sourceRaster.data, base.width, base.height, exclude, { step: IMG_PATCH_VERIFY_STEP })) {
      return { ok: false, mismatch: true, error: '两档不是同一张底图（同源校验未通过）' };
    }

    // 把来源档的水印矩形**原样覆盖**到底板同一位置 —— 无损补角，不是像素合成
    baseRaster.ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    return { ok: true, canvas: baseRaster.ctx.canvas as OffscreenCanvas, rect };
  } catch (error) {
    return { ok: false, mismatch: false, error: String((error as Error)?.message ?? error) };
  } finally {
    base?.close();
    source?.close();
  }
}

/**
 * **补角重建后下载**（老链路 `image_list` 的图，站点只给了两档带水印的同源底图）。
 *
 * 返回值三态（bg 据此决定要不要回退）：
 *   · `{ ok:true, patched:true }`  —— 已合成并触发下载（无水印）；
 *   · `{ ok:true, patched:false }` —— **同源校验没过 / 尺寸不一致 / 矩形非法**：
 *     **没有**合成、**没有**下载任何文件，由 bg 退回「直接下带水印原图」并把条目标成 `meta.patchFail`；
 *   · `{ ok:false }` —— 取图失败 / 页面不支持 canvas 等，同样由 bg 回退。
 */
async function downloadPatched(url: string, patch: ImagePatch, filename: string): Promise<PatchDownloadResult> {
  const composed = await composePatched(url, patch);
  if (!composed.ok) {
    return composed.mismatch ? { ok: true, patched: false, error: composed.error } : { ok: false, error: composed.error };
  }
  try {
    const blob = await composed.canvas.convertToBlob({ type: 'image/png' });
    if (!blob.size) return { ok: false, error: '合成结果为空' };
    triggerBlobDownload(blob, filename);
    const { rect } = composed;
    diag(
      'content.patch',
      `补角成功 rect=${rect.x},${rect.y},${rect.w},${rect.h} ${composed.canvas.width}×${composed.canvas.height} bytes=${blob.size} ${filename}`,
    );
    return { ok: true, patched: true };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) };
  }
}

/* --------------------------------------------------------------------------- */
/* 补角条目的卡片封面（2026-10-03 第三十一轮）                                     */
/* --------------------------------------------------------------------------- */

/** 等比缩到长边 ≤ `maxPx`（比它小就不放大）；先铺白底，与下载产物一致 */
function downscale(canvas: OffscreenCanvas, maxPx: number): OffscreenCanvas {
  const size = coverSize(canvas.width, canvas.height, maxPx);
  if (size.width === canvas.width && size.height === canvas.height) return canvas;
  const small = new OffscreenCanvas(size.width, size.height);
  const ctx = small.getContext('2d', { alpha: false });
  if (!ctx) return canvas;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(canvas, 0, 0, size.width, size.height);
  return small;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取合成结果失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 封面缓存（FIFO，条数上限见 `LIMITS.PATCH_COVER_CACHE_MAX`）。
 * 键 = 两档地址；弹窗每次重新打开（模块重载）都会再问一遍，有它就不必重新取两档**全尺寸**图。
 */
const patchCoverCache = new Map<string, string>();

/**
 * **合成补角条目的卡片封面** —— 与下载链路同一套补角，只是产物缩成小图 data URL。
 *
 * 为什么要有它：卡片标着「无水印（补角重建）」，封面却直接用了站点的 `image_thumb`
 * （`downsize_watermark`，**带水印**）—— 预览与结论自相矛盾（`docs/03` §45.1）。
 *
 * ⚠️ **不落库、不落盘**：data URL 只回给弹窗填 `<img src>`，像素不是资源的描述。
 * ⚠️ 封面是**预览用**，宁可退回站点缩略图也不许把别的画面糊上去 —— 同源校验不过就返回失败。
 */
async function buildPatchCover(url: string, patch: ImagePatch, maxPx: number): Promise<{ ok: true; cover: string } | { ok: false; error: string }> {
  const key = `${url}::${patch.url}`;
  const cached = patchCoverCache.get(key);
  if (cached) return { ok: true, cover: cached };

  const composed = await composePatched(url, patch);
  if (!composed.ok) return { ok: false, error: composed.error };
  try {
    const small = downscale(composed.canvas, maxPx);
    const blob = await small.convertToBlob({ type: 'image/jpeg', quality: LIMITS.PATCH_COVER_QUALITY });
    if (!blob.size) return { ok: false, error: '封面结果为空' };
    const cover = await blobToDataUrl(blob);
    if (patchCoverCache.size >= LIMITS.PATCH_COVER_CACHE_MAX) {
      const oldest = patchCoverCache.keys().next().value;
      if (oldest !== undefined) patchCoverCache.delete(oldest);
    }
    patchCoverCache.set(key, cover);
    diag('content.cover', `封面已合成 ${small.width}×${small.height} bytes=${blob.size}`);
    return { ok: true, cover };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message ?? error) };
  }
}


/** `MSG.FetchPatchBlob` 的回执（bg 只看 `ok` / `patched`） */
export interface PatchDownloadResult {
  ok: boolean;
  /** 是否真的做了补角并触发下载 */
  patched?: boolean;
  error?: string;
}

/* --------------------------------------------------------------------------- */
/* 分享页无水印解析（2026-10-03 第二十八轮 §48）                                  */
/* --------------------------------------------------------------------------- */

/** `MSG.ResolveShareVideo` 的回执（bg 只看 `ok` / `url`） */
export interface ShareResolveResult {
  ok: boolean;
  /** 解出的**明文直链**（带时效签名，bg 拿到后立即下载，**不入库**） */
  url?: string;
  error?: string;
}

/** 取值：对象直接用；字符串先解**转义 JSON**（`video_model` 就是这种形态） */
function parseMaybeJson(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  const text = value.replace(/\\u0026/g, '&').replace(/\\\//g, '/').trim();
  for (const candidate of [text, text.replace(/\\"/g, '"')]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* 再试 */
    }
  }
  return null;
}

/** 按路径取值（只走对象，不猜） */
function readPath(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * **分享页视频的无水印解析**：`vid` → `fallback_api` → 改 fplay 档位 → 解 qAAB → 明文直链。
 *
 * 为什么放**这里**（content 脚本）而不是 bg：
 *   · `get_video_model` 要**登录 cookie** —— 同源（doubao.com）请求才带得上；
 *   · fplay 是跨域请求，要靠 DNR 注入的 CORS 头（`||vas-lf-x.snssdk.com/`）。
 * 解密本体在 `core/fplay.ts`（纯函数，有真实样本单测）；这里只做取数与串接。
 *
 * ⚠️ 任何一步失败都返回 `{ ok:false, error }`，由 bg **如实回退**去下站点给的那个档 ——
 *    **绝不猜一个地址、也不假装无水印**。
 */
async function resolveShareVideo(vid: string, quality: ShareQuality): Promise<ShareResolveResult> {
  if (!vid) return { ok: false, error: '缺少 vid' };

  // ① 只吃 vid 的接口（同源 POST → 自动带登录 cookie）→ fallback_api
  const query = new URLSearchParams(VIDEO_MODEL_QUERY).toString();
  let payload: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${VIDEO_MODEL_ENDPOINT}?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: [{ [VIDEO_MODEL_URI_KEY]: vid }] }),
    });
    if (!res.ok) return { ok: false, error: `get_video_model HTTP ${res.status}` };
    payload = parseMaybeJson(await res.json());
    if (!payload) return { ok: false, error: 'get_video_model 响应不是 JSON' };
  } catch (error) {
    return { ok: false, error: `get_video_model 请求失败：${String((error as Error)?.message ?? error)}` };
  }
  const code = payload.code;
  if (Number(code) !== 0) return { ok: false, error: `get_video_model code=${code}` };

  const results = readPath(payload, VIDEO_MODEL_RESULT_PATH);
  const entry = Array.isArray(results) ? results[0] : undefined;
  const model = parseMaybeJson(readPath(entry, VIDEO_MODEL_MODEL_PATH));
  const fallbackApi = model?.[VIDEO_MODEL_FALLBACK_KEY];
  if (!isFplayUrl(fallbackApi)) return { ok: false, error: '响应里没有可用的 fallback_api' };

  // ② 改档位 → GET fplay
  const fplayUrl = buildFplayUrl(fallbackApi, quality);
  if (!fplayUrl) return { ok: false, error: 'fplay 地址不合法' };
  try {
    const res = await fetch(fplayUrl, { credentials: 'omit' });
    if (!res.ok) return { ok: false, error: `fplay HTTP ${res.status}` };
    const info = parseMaybeJson(await res.json());
    if (!info) return { ok: false, error: 'fplay 响应不是 JSON' };

    // ③ 解 qAAB → 明文直链
    const url = await pickFplayUrl(info);
    if (!url) return { ok: false, error: 'qAAB 解密失败' };
    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: `fplay 请求失败：${String((error as Error)?.message ?? error)}` };
  }
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

  if (env.type === MSG.FetchPatchBlob) {
    const payload = env.payload as { url?: string; patch?: ImagePatch; filename?: string } | undefined;
    const patch = payload?.patch;
    if (!payload?.url || !payload.filename || !patch?.url || !patch.rect) {
      sendResponse({ ok: false, error: '参数缺失' });
      return undefined;
    }
    void downloadPatched(payload.url, patch, payload.filename)
      .then((result) => {
        // `patched:false` 不是异常（同源校验未通过是**预期内的兜底分支**），但要留痕
        if (!result.ok || result.patched === false) {
          diag('content.patch', `补角未完成：${result.error ?? '未知原因'}`, { level: 'warn' });
        }
        sendResponse(result);
      })
      .catch((error: unknown) => {
        const message = String((error as Error)?.message ?? error);
        diag('content.patch', `补角异常：${message}`, { level: 'error' });
        sendResponse({ ok: false, error: message });
      });
    return true;
  }

  // bg 请求「合成补角条目的卡片封面」（弹窗只对**可见**卡片发问，见 `ui/popup/popup.ts`）
  if (env.type === MSG.PatchCover) {
    const payload = env.payload as { url?: string; patch?: ImagePatch; maxPx?: number } | undefined;
    const patch = payload?.patch;
    if (!payload?.url || !patch?.url || !patch.rect) {
      sendResponse({ ok: false, error: '参数缺失' });
      return undefined;
    }
    const maxPx = Math.min(2_048, Math.max(64, Math.floor(payload.maxPx ?? LIMITS.PATCH_COVER_MAX_PX)));
    void buildPatchCover(payload.url, patch, maxPx)
      .then((result) => {
        // 封面是预览用的尽力而为：失败**不改条目状态**、界面保持站点缩略图，只留痕
        if (!result.ok) diag('content.cover', `封面未合成：${result.error}`, { level: 'warn' });
        sendResponse(result);
      })
      .catch((error: unknown) => {
        const message = String((error as Error)?.message ?? error);
        diag('content.cover', `封面合成异常：${message}`, { level: 'error' });
        sendResponse({ ok: false, error: message });
      });
    return true;
  }

  if (env.type === MSG.ResolveShareVideo) {
    const payload = env.payload as { vid?: string; quality?: ShareQuality } | undefined;
    const vid = payload?.vid ?? '';
    const quality: ShareQuality = payload?.quality === 'heavy' ? 'heavy' : 'light';
    if (!vid) {
      sendResponse({ ok: false, error: '参数缺失（vid）' });
      return undefined;
    }
    void resolveShareVideo(vid, quality)
      .then((result) => {
        // 解析失败是**预期内的兜底分支**（bg 会回退去下站点给的那个档），但要留痕
        if (!result.ok) diag('content.share', `分享页无水印解析未成功：${result.error ?? '未知原因'}`, { level: 'warn' });
        else diag('content.share', `分享页无水印直链已解出（${quality}）`);
        sendResponse(result);
      })
      .catch((error: unknown) => {
        const message = String((error as Error)?.message ?? error);
        diag('content.share', `分享页无水印解析异常：${message}`, { level: 'error' });
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
