/**
 * `bg/service-worker.ts` —— MV3 后台。
 *
 * 职责：
 *   1. 消息路由（UI ↔ background；content → background）
 *   2. 资源库写入（upsert + 99 条 FIFO）
 *   3. 下载调度（单并发队列 + 文件名分配 + 方案 A/B 取流）
 *   4. 安装期迁移与上游遗留键清理
 *
 * 设计取舍：
 *   - **不缓存页面状态**。popup 问「当前页面什么状况」时，主动向该标签页的 content script
 *     发一次 `tab:query`；拿不到应答 = 内容脚本没注入 = 「页面需刷新后生效」。
 *     这样天然免疫 MV3 Service Worker 随时被回收的问题
 *     （上游把状态放内存变量里，SW 一重启就丢，于是状态条永远显示"运行中"）。
 *   - 唯一的模块级缓存是资源库（background 是它的唯一写入方）。
 *   - 2026-09-26 第三轮：资源库改为在**弹窗内**显示，`sidePanel` 相关能力与消息已移除。
 */

import { DOWNLOAD_STRATEGY, EXT_VERSION, LIMITS, MSG, STORAGE } from '../core/constants';
import { makeRecord, pushBounded, type DiagRecord } from '../core/diagnostics';
import { DownloadQueue, FilenameAllocator, parseTotalBytes } from '../core/download';
import {
  type Library,
  filterDraftsByConv,
  isLeaveScope,
  itemId,
  markExpired,
  markFailed,
  patchItem,
  rekeyConv,
  retainConv,
  retitleConv,
  statsOf,
  upsertDrafts,
} from '../core/library-store';
import { broadcast, onRuntimeMessage, trySendToTab } from '../core/messaging';
import { migrate, onStateChanged, patchConfig, readConfig, readLibrary, readState, writeLibrary } from '../core/storage';
import {
  CHAT_PATH_PATTERN,
  CONV_ID_PATTERN,
  SIZE_PROBE_RANGE,
  THREAD_PATH_PATTERN,
  isDoubaoHostUrl,
  isLocalConvId,
} from '../core/site-contract';
import type {
  Config,
  ConvScope,
  DownloadProgress,
  DownloadRequest,
  DownloadTarget,
  MediaDraft,
  MediaItem,
  PageInfo,
  StateRequest,
  StateResponse,
} from '../core/types';

/* --------------------------------------------------------------------------- */
/* 诊断（真机联调用；有界环形缓冲，不影响业务）                                    */
/* --------------------------------------------------------------------------- */

let diagCache: DiagRecord[] | null = null;
let diagFlushTimer: ReturnType<typeof setTimeout> | null = null;
/** 串行化 append/clear，避免并发交错导致丢写 */
let diagChain: Promise<void> = Promise.resolve();

async function getDiag(): Promise<DiagRecord[]> {
  if (diagCache) return diagCache;
  try {
    const data = (await chrome.storage.local.get(STORAGE.diag)) as Record<string, unknown>;
    const raw = data[STORAGE.diag];
    diagCache = Array.isArray(raw) ? (raw as DiagRecord[]) : [];
  } catch {
    diagCache = [];
  }
  return diagCache;
}

function scheduleDiagFlush(): void {
  if (diagFlushTimer) return;
  diagFlushTimer = setTimeout(() => {
    diagFlushTimer = null;
    void flushDiag();
  }, 400);
}

async function flushDiag(): Promise<void> {
  if (!diagCache) return;
  try {
    await chrome.storage.local.set({ [STORAGE.diag]: diagCache });
    broadcast(MSG.DiagChanged, { count: diagCache.length });
  } catch {
    /* 诊断写失败不影响业务 */
  }
}

/**
 * 追加诊断记录。
 *
 * ⚠️ 修复 `docs/03` §3 缺陷 1：**必须先 `await getDiag()`**。
 * SW 被回收再唤醒时 `diagCache` 是 null，若直接以 `[]` 为基底追加，
 * 这一批新记录会连带把已落库的历史记录**整体覆盖**掉
 * （首轮联调报告只剩 5 条、`hook.ready` / `parse.*` 全部缺失，就是由此造成）。
 * 另用 promise 串行化，保证多次 append 的顺序与可见性。
 */
function appendDiag(records: DiagRecord[]): void {
  if (!records.length) return;
  diagChain = diagChain
    .then(async () => {
      let next = await getDiag();
      for (const record of records) next = pushBounded(next, record);
      diagCache = next;
      scheduleDiagFlush();
    })
    .catch(() => {
      /* 诊断失败不影响业务 */
    });
}

/** 清空诊断记录（同样走串行链，避免清空后又被在途的 append 写回） */
async function resetDiag(): Promise<void> {
  await diagChain.catch(() => undefined);
  diagCache = [];
  await flushDiag();
}

function diag(event: string, detail?: string, options: { level?: 'info' | 'warn' | 'error'; text?: string } = {}): void {
  appendDiag([makeRecord('bg', event, detail, options)]);
}


/* --------------------------------------------------------------------------- */
/* 资源库缓存（background 是唯一写入方）                                          */
/* --------------------------------------------------------------------------- */

let libraryCache: Library | null = null;

async function getLibrary(): Promise<Library> {
  if (!libraryCache) libraryCache = await readLibrary();
  return libraryCache;
}

async function persistLibrary(next: Library): Promise<void> {
  libraryCache = next;
  await writeLibrary(next);
}

/* --------------------------------------------------------------------------- */
/* 会话作用域（2026-09-26 第四轮）                                                */
/*                                                                             */
/* 用户口径：**资源库只针对「当前激活的对话本身」**。                              */
/* 页面脚本在会话切换 / 标题解析完成时上报 `conv:scope`，这里据此：                 */
/*   ① 会话变了 → 裁剪资源库（切走即清空其它会话，宁可从简也不留错乱的历史）          */
/*   ② 拿到真实标题 → 刷新该会话下已有条目的会话名（解除「兜底标题粘住」）            */
/* --------------------------------------------------------------------------- */

const SESSION_SCOPE = 'uwd:activeScope';
let activeScope: ConvScope | null = null;

async function rememberScope(scope: ConvScope): Promise<void> {
  activeScope = scope;
  try {
    await chrome.storage.session.set({ [SESSION_SCOPE]: scope });
  } catch {
    /* session 存储不可用时降级为内存记忆 */
  }
}

async function recallScope(): Promise<ConvScope | null> {
  if (activeScope) return activeScope;
  try {
    const data = (await chrome.storage.session.get(SESSION_SCOPE)) as Record<string, unknown>;
    const value = data[SESSION_SCOPE];
    if (value && typeof value === 'object' && typeof (value as ConvScope).convId === 'string') {
      activeScope = value as ConvScope;
    }
  } catch {
    /* 忽略 */
  }
  return activeScope;
}

/** 归一化：空串与「没有作用域」等价，避免把 `''` 当成一次真正的会话切换 */
function scopeKey(scope: ConvScope | null | undefined): string | null {
  const convId = scope?.convId?.trim();
  return convId ? convId : null;
}

/** 结束会话作用域：内存与 session 存储一并置空（`isLeaveScope` 分支专用） */
async function clearScope(): Promise<void> {
  activeScope = null;
  try {
    await chrome.storage.session.remove(SESSION_SCOPE);
  } catch {
    /* session 存储不可用时内存已置空 */
  }
}

async function applyScope(scope: ConvScope): Promise<void> {
  try {
    const previous = await recallScope();
    const convId = scope.convId.trim();

    /*
     * 离开会话（2026-09-27 第八轮）：豆包域内的非会话页（首页 `/chat` 等）。
     * L1 语义补角：资源库 == 当前激活会话 —— 没有激活会话 → 库整体清空 + 作用域置空。
     * 回到任何会话时 chain 历史重拉会照常恢复该会话的条目（与「切走即清空」同一语义）。
     * 幂等：已处于无会话状态时直接返回。
     * ⚠️ 只由**页面侧的 conv:scope** 触发 —— `buildStateResponse` / `syncScopeFromTab`
     *   对 kind=none 仍然不调用本函数的清库分支（活动标签页不是豆包页 ≠ 离开会话，
     *   不能因为用户切去别的网站就清掉后台豆包页的库）。
     */
    if (isLeaveScope(scope)) {
      if (!scopeKey(previous)) return;
      const library = await getLibrary();
      const left = Object.keys(library).length;
      await clearScope();
      await persistLibrary({});
      diag('bg.scope', `离开会话（kind=${scope.kind}）→ 资源库清空（原 ${left} 条）`);
      return;
    }

    const convChanged = scopeKey(previous) !== scopeKey(scope);
    const titleChanged = Boolean(convId && scope.title && previous?.title !== scope.title);
    if (!convChanged && !titleChanged) return;

    const library = await getLibrary();
    let next = library;
    if (convChanged && convId) {
      const previousId = scopeKey(previous);
      /*
       * 新建会话的占位 ID（`local_*`）→ 真实 ID（2026-09-27 第七轮）：
       * 占位窗口期入库的条目 convId 是占位值，直接 retainConv 会把它们当「异会话」清掉。
       * 先重键到真实会话、再裁剪其它会话 —— 新会话生成阶段捕获的素材因此不会丢。
       */
      if (previousId && isLocalConvId(previousId) && !isLocalConvId(convId)) {
        next = rekeyConv(next, previousId, convId);
      }
      next = retainConv(next, convId);
    }
    if (convId && scope.title) next = retitleConv(next, convId, scope.title);

    // 标题留空时沿用同一会话上一次已知的真实标题（页面可能先报空、随后再报标题）
    await rememberScope({
      convId,
      kind: scope.kind,
      title: scope.title || (scopeKey(previous) === scopeKey(scope) ? (previous?.title ?? '') : ''),
    });
    if (next !== library) await persistLibrary(next);

    diag(
      'bg.scope',
      `convId=${convId || '-'} kind=${scope.kind} title=${scope.title || '-'} 会话变更=${convChanged} 保留=${
        Object.keys(next).length
      }/${Object.keys(library).length}`,
    );
  } catch (error) {
    // 会话作用域是增强能力：出错绝不能让 state:get / library:list 挂住
    diag('bg.scope', `应用会话作用域失败：${String((error as Error)?.message ?? error)}`, { level: 'error' });
  }
}

/**
 * 主动向某个标签页问一次页面信息，并据此应用会话作用域。
 * 用作兜底：即使 `conv:scope` 消息丢了（SW 被回收等），打开弹窗 / 资源库时也会收敛。
 */
async function syncScopeFromTab(tabId: number | null): Promise<PageInfo | null> {
  if (tabId === null) return null;
  const info = await trySendToTab<PageInfo>(tabId, MSG.TabQuery);
  if (!info || typeof info.kind !== 'string' || info.kind === 'none') return null;
  await applyScope({ convId: info.convId, title: info.title, kind: info.kind });
  return info;
}

/* --------------------------------------------------------------------------- */
/* 媒体草稿入库（短去抖：SSE 增量推送会高频触发）                                  */
/* --------------------------------------------------------------------------- */

let draftBuffer: MediaDraft[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queueDrafts(drafts: MediaDraft[]): void {
  draftBuffer.push(...drafts);
  if (draftBuffer.length >= LIMITS.DRAFT_BATCH_MAX) {
    void flushDrafts();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    void flushDrafts();
  }, 120);
}

async function flushDrafts(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!draftBuffer.length) return;

  const buffered = draftBuffer;
  draftBuffer = [];

  // 会话作用域：只收「当前激活会话」的草稿 ——
  // chain / SSE 的响应可能晚于「用户切走」才到，那时页面盖的是新会话的 ID，
  // 收进来就会变成另一条会话下的重复资源。
  const scope = await recallScope();
  // 没有激活会话（已离开会话页，第八轮）→ 草稿一律不入库。
  // 否则首页期间兜到的「unknown 会话」草稿会写进刚清空的库，残留重新出现。
  if (!scope?.convId) {
    diag('bg.upsert', `无激活会话，丢弃草稿 ${buffered.length} 条`, { level: 'warn' });
    return;
  }
  const drafts = filterDraftsByConv(buffered, scope.convId);
  const dropped = buffered.length - drafts.length;
  if (dropped > 0) {
    diag('bg.upsert', `丢弃异会话草稿 ${dropped} 条（当前会话=${scope?.convId || '-'}）`, { level: 'warn' });
  }
  if (!drafts.length) return;

  const [library, config] = await Promise.all([getLibrary(), readConfig()]);
  const result = upsertDrafts(library, drafts, { skipThumbOnly: config.skipThumbOnly });
  if (result.added || result.merged) await persistLibrary(result.library);

  diag(
    'bg.upsert',
    `in=${drafts.length} added=${result.added} merged=${result.merged} skipped=${result.skipped} evicted=${result.evicted} total=${Object.keys(result.library).length} skipThumbOnly=${config.skipThumbOnly}`,
    result.added || result.merged ? {} : { level: 'warn' },
  );

  // 体积兜底：创作树里查不到体积的条目（超期视频 / 超过约三个月的旧图片）实测一次字节数。
  // ⚠️ **不 await**：每条最多 8s，等在这里会把入库链路拖住几十秒，期间别的写入
  // （`bg.expire` 的超期落库等）可能被旧快照回写覆盖 —— 实测踩过这个坑。
  void backfillSizes(drafts.map((draft) => itemId(draft.convId, draft.fingerprint)));
}

/* --------------------------------------------------------------------------- */
/* 体积兜底（2026-09-28 第十轮补丁）                                              */
/*                                                                             */
/* 体积的**首选来源**是创作树节点 `size`（视频由 vid 三步 API 带回、图片由页面侧         */
/* `imageSizeOf` 查树带回）—— 零额外请求、实测与落盘字节数一致。                      */
/* 树里没有的条目（超期视频 / 超过约三个月的旧图片）就只能**实测**：                       */
/* 对条目 `primary`（点下载真正会拿到的那个地址）发一次 `Range: bytes=0-0`，             */
/* 从 `Content-Range` 读总长 —— 只下 1 字节。                                      */
/*                                                                             */
/* ⚠️ 必须在这里（background）发：页面里发会被 CORS 挡住响应头（探针实测              */
/* `content-range=null`）；扩展上下文有 host_permissions，能读全。                     */
/* ⚠️ 只测「已定局」的条目（`pending` 表示还在解析中，体积等一下就会随解析结果来），        */
/* 且同一条目在一个 SW 生命周期内只测一次（失败不重试，等 F5 重解析）。                  */
/* --------------------------------------------------------------------------- */

const probedSizeIds = new Set<string>();

/** 该条目现在还值得测体积吗（已定局、缺体积、地址是可取的 http(s)） */
function needsSizeProbe(item: MediaItem): boolean {
  if (item.meta.size !== undefined) return false;
  if (item.state === 'pending') return false;
  if (probedSizeIds.has(item.id)) return false;
  return /^https?:/i.test(item.primary);
}

/**
 * 单次探测：先按 `Range: bytes=0-0` 试，读到总长就返回。
 *
 * 兜底原因（2026-09-28 实机/探针）：这两个来源的行为不一样 ——
 *   · 视频 CDN 支持 Range → **206** + `Content-Range: bytes 0-0/<总长>`，只下 1 字节；
 *   · 图片 CDN（`*-flow-imagex-sign.byteimg.com`）实测 **`accept-ranges: null`**，
 *     给了 Range 也可能忽略 → 回 **200** + `Content-Length`（完整长度），此时必须**立刻中断响应体**。
 * 所以两种都认；都读不到再退回「不带 Range 的普通 GET」（同样读 `Content-Length` 后中断）——
 * 这条路径在页面探针里**实测可用**（`content-length=4414234`）。
 */
async function probeSizeOnce(url: string, useRange: boolean): Promise<{ size?: number; note: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.SIZE_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      ...(useRange ? { headers: { Range: SIZE_PROBE_RANGE } } : {}),
      signal: controller.signal,
    });
    const size = parseTotalBytes(response.status, (name) => response.headers.get(name));
    // 200（没按 Range 回）= 整个响应体正在流下来 → 立刻掐掉，只留头信息
    if (response.status === 200) void response.body?.cancel().catch(() => undefined);
    return {
      size,
      note: `status=${response.status} len=${response.headers.get('content-length') ?? '-'} range=${
        response.headers.get('content-range') ?? '-'
      }${size ? '' : '（认不出总长）'}`,
    };
  } catch (error) {
    return { note: `❌ ${(error as Error).name} ${(error as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 实测一个地址的文件总字节数；读不到返回 undefined（宁缺勿假）。`note` 只用于诊断。 */
async function measureBytes(url: string): Promise<{ size?: number; note: string }> {
  const ranged = await probeSizeOnce(url, true);
  if (ranged.size !== undefined) return ranged;
  const plain = await probeSizeOnce(url, false);
  return { size: plain.size, note: `带 Range：${ranged.note}｜不带 Range：${plain.note}` };
}

/**
 * 给「体积仍缺失且已定局」的条目实测字节数，回写 `meta.size`。
 * 每轮最多 `SIZE_PROBE_MAX_PER_ROUND` 条、串行执行（避免对 CDN 打出脉冲）。
 *
 * 入参是**条目 id**（`itemId()` 的产物）—— upsert 后与「原片已超期」落库后都要走一次。
 */
async function backfillSizes(ids: Iterable<string>): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const library = await getLibrary();
  const candidates = unique
    .map((id) => library[id])
    .filter((item): item is MediaItem => !!item && needsSizeProbe(item));
  const todo = candidates.slice(0, LIMITS.SIZE_PROBE_MAX_PER_ROUND);
  const rest = candidates.slice(LIMITS.SIZE_PROBE_MAX_PER_ROUND).map((item) => item.id);
  if (!todo.length) return;

  let measured = 0;
  let failed = 0;
  const notes: string[] = [];
  for (const item of todo) {
    probedSizeIds.add(item.id);
    const result = await measureBytes(item.primary);
    if (result.size === undefined) {
      failed += 1;
      if (notes.length < 2) notes.push(result.note);
      continue;
    }
    /*
     * 每条**重新读一次**当前库再打补丁：批量下载/解析期间别的路径（如 `bg.expire`、
     * 页面新草稿）也在写库，用旧快照整体回写会把它们的成果抹掉。
     */
    const current = (await getLibrary())[item.id];
    if (!current) continue;
    await persistLibrary(patchItem(await getLibrary(), item.id, { meta: { ...current.meta, size: result.size } }));
    measured += 1;
  }
  diag(
    'bg.size',
    `实测字节：成功 ${measured} 条 / 失败 ${failed} 条（候选 ${todo.length} 条${
      rest.length ? `，余 ${rest.length} 条下一轮继续` : ''
    }）${notes.length ? `｜失败原因：${notes.join(' ; ')}` : ''}`,
    measured ? {} : { level: 'warn' },
  );
  /*
   * 一个会话里可能压着几十条待测（例如整屏都是超过三个月的旧图片），而每轮只放
   * `SIZE_PROBE_MAX_PER_ROUND` 条 —— 剩下的**分批续跑**（一次性定时器，不是轮询；
   * 每轮都会把测过的 id 记进 `probedSizeIds`，所以一定会收敛到「没有候选」而停下）。
   */
  if (rest.length) setTimeout(() => void backfillSizes(rest), LIMITS.SIZE_PROBE_CONTINUE_MS);
}

/* --------------------------------------------------------------------------- */
/* 下载                                                                          */
/* --------------------------------------------------------------------------- */

const EMPTY_PROGRESS: DownloadProgress = { total: 0, done: 0, failed: 0, running: 0, current: null, lastError: null };
let lastProgress: DownloadProgress = { ...EMPTY_PROGRESS };

const queue = new DownloadQueue({
  concurrency: LIMITS.DOWNLOAD_CONCURRENCY,
  retry: LIMITS.DOWNLOAD_RETRY,
  onProgress: (progress) => {
    lastProgress = progress;
    broadcast(MSG.DownloadProgress, progress);
  },
  onJobDone: (job, ok) => {
    if (!ok && job.id) void markItemFailed(job.id);
  },
});

async function markItemFailed(itemId: string): Promise<void> {
  const library = await getLibrary();
  if (!library[itemId]) return;
  await persistLibrary(markFailed(library, itemId));
}

/** 等待某个 chrome.downloads 任务结束 */
function waitForDownload(downloadId: number, timeoutMs = 10 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('下载超时'));
    }, timeoutMs);

    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        cleanup();
        resolve();
      } else if (delta.state?.current === 'interrupted') {
        cleanup();
        reject(new Error(delta.error?.current ?? 'interrupted'));
      } else if (delta.error?.current) {
        cleanup();
        reject(new Error(delta.error.current));
      }
    };

    chrome.downloads.onChanged.addListener(listener);
  });
}

/** 方案 A：chrome.downloads + DNR 注入 Referer（省内存，支持 39MB 级大文件） */
async function downloadWithDownloadsApi(url: string, filename: string): Promise<void> {
  const downloadId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  if (typeof downloadId !== 'number') throw new Error('下载未能启动');
  await waitForDownload(downloadId);
}

/** 方案 B：回到豆包页面上下文 fetch + blob（上游已验证可用，大文件吃内存） */
async function downloadViaContentScript(tabId: number, url: string, filename: string): Promise<void> {
  const result = await trySendToTab<{ ok: boolean; error?: string }>(
    tabId,
    MSG.FetchBlob,
    { url, filename },
    10 * 60_000,
  );
  if (!result) throw new Error('页面脚本未就绪，请刷新豆包页面后重试');
  if (!result.ok) throw new Error(result.error ?? '页面内下载失败');
}

/**
 * 取流方案（方案 §7.3）：
 *   auto      → 先试 A，失败自动回退 B（默认）
 *   downloads → 只用 A
 *   blob      → 只用 B
 */
async function performDownload(target: DownloadTarget, filename: string, tabId: number | null): Promise<void> {
  if (DOWNLOAD_STRATEGY === 'blob') {
    if (tabId === null) throw new Error('找不到可用的豆包标签页');
    await downloadViaContentScript(tabId, target.url, filename);
    return;
  }

  try {
    await downloadWithDownloadsApi(target.url, filename);
    diag('bg.download', `方案 A 成功 ${filename}`);
  } catch (error) {
    diag('bg.download', `方案 A 失败（${String((error as Error)?.message ?? error)}），回退方案 B`, { level: 'warn' });
    if (DOWNLOAD_STRATEGY === 'downloads') throw error;
    if (tabId === null) throw error;
    await downloadViaContentScript(tabId, target.url, filename);
  }
}

async function resolveActiveTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function tabUrlOf(tabId: number): Promise<string> {
  try {
    return (await chrome.tabs.get(tabId)).url ?? '';
  } catch {
    return '';
  }
}

/* --------------------------------------------------------------------------- */
/* 报告目标标签页（修复 docs/03 §3 缺陷 2）                                        */
/* --------------------------------------------------------------------------- */

const SESSION_LAST_TAB = 'uwd:lastContentTabId';
/** 最近一次收到豆包页内容脚本消息的标签页 */
let lastContentTabId: number | null = null;

async function rememberContentTab(tabId: number): Promise<void> {
  if (lastContentTabId === tabId) return;
  lastContentTabId = tabId;
  try {
    await chrome.storage.session.set({ [SESSION_LAST_TAB]: tabId });
  } catch {
    /* session 存储不可用时降级为内存记忆 */
  }
}

async function recallContentTab(): Promise<number | null> {
  if (lastContentTabId !== null) return lastContentTabId;
  try {
    const data = (await chrome.storage.session.get(SESSION_LAST_TAB)) as Record<string, unknown>;
    const value = data[SESSION_LAST_TAB];
    if (typeof value === 'number') lastContentTabId = value;
  } catch {
    /* 忽略 */
  }
  return lastContentTabId;
}

/** 兜底：在所有标签页里找第一个豆包对话页 / 分享页（SW 冷启动后记忆为空时用） */
async function findDoubaoTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.doubao.com/*', '*://*.dola.com/*'] });
    for (const tab of tabs) {
      if (typeof tab.id === 'number' && isDoubaoUrl(tab.url)) return tab.id;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

interface ReportTarget {
  tabId: number | null;
  /** true = 活动标签页不是豆包页，已自动跟随别的豆包页 */
  followedRecent: boolean;
}

/**
 * 选「本次要报告状态的标签页」。
 *
 * 默认（`follow = false`）只认活动标签页 —— popup / 侧边栏要的是「用户此刻在看什么」。
 * 诊断页传 `follow = true`：**它自己就是 active tab**，不跟随的话环境卡片永远显示
 * `页面类型=none / 内容脚本未注入`，把排查方向带偏（`docs/03` §3 缺陷 2）。
 *
 * 跟随顺序：记忆中的豆包页（最准，来自内容脚本消息）→ 全量查到的豆包页 → 活动标签页。
 */
async function resolveReportTarget(explicitTabId?: number, follow = false): Promise<ReportTarget> {
  if (typeof explicitTabId === 'number') return { tabId: explicitTabId, followedRecent: false };

  const activeTabId = await resolveActiveTabId();
  if (!follow) return { tabId: activeTabId, followedRecent: false };

  if (activeTabId !== null && isDoubaoUrl(await tabUrlOf(activeTabId))) {
    return { tabId: activeTabId, followedRecent: false };
  }

  const remembered = await recallContentTab();
  if (remembered !== null && remembered !== activeTabId) {
    if (await tabUrlOf(remembered)) return { tabId: remembered, followedRecent: true };
    lastContentTabId = null;
  }

  const found = await findDoubaoTabId();
  if (found !== null && found !== activeTabId) return { tabId: found, followedRecent: true };

  return { tabId: activeTabId, followedRecent: false };
}

/** 把 UI / 页面的下载请求展开成一批下载目标 */
async function buildTargets(request: DownloadRequest): Promise<DownloadTarget[]> {
  if (request.url) {
    return [
      {
        itemId: '',
        convId: request.convId || 'unknown',
        url: request.url,
        ext: request.ext || 'bin',
      },
    ];
  }

  const ids = request.ids ?? [];
  if (!ids.length) return [];
  const library = await getLibrary();
  const targets: DownloadTarget[] = [];
  for (const id of ids) {
    const item = library[id];
    if (!item) continue;
    const target: DownloadTarget = { itemId: item.id, convId: item.convId, url: item.primary, ext: item.meta.ext };
    // 视频指纹形如 `vid:<x>` —— 签名地址过期时靠它让页面重新解析
    if (item.fingerprint.startsWith('vid:')) target.vid = item.fingerprint.slice(4);
    targets.push(target);
  }
  return targets;
}

/**
 * 原片地址是**带时效的签名 URL**，长时间停留后可能已过期（现象：下载「获取失败」）。
 * 自愈路径：让页面**绕过缓存**重新走三步 API 换一份新签名，写回条目并重试一次。
 * 返回 null 表示无法自愈（非 vid 条目 / 页面不可用 / 重解析失败）。
 */
async function refreshTargetUrl(target: DownloadTarget, tabId: number | null): Promise<string | null> {
  if (!target.vid || tabId === null) return null;
  const res = await trySendToTab<{ url?: string | null }>(tabId, MSG.ReresolveVid, { vid: target.vid }, 45_000);
  const url = res?.url ?? null;
  if (!url) return null;

  const library = await getLibrary();
  if (target.itemId && library[target.itemId]) {
    await persistLibrary(patchItem(library, target.itemId, { primary: url, state: 'raw' }));
  }
  diag('bg.download', `已重新解析原片地址 vid=${target.vid}（签名过期自愈）`);
  return url;
}

async function handleDownloadRequest(
  request: DownloadRequest,
  senderTabId?: number,
): Promise<{ ok: boolean; queued: number; error?: string }> {
  const targets = await buildTargets(request);
  if (!targets.length) return { ok: false, queued: 0, error: '没有可下载的资源' };

  const tabId = senderTabId ?? (await resolveActiveTabId());
  const allocator = new FilenameAllocator();
  diag('bg.download', `入队 ${targets.length} 项（ids=${request.ids?.length ?? 0} inline=${request.url ? 1 : 0} tabId=${tabId ?? '-'}）`);

  queue.enqueue(
    targets.map((target) => ({
      id: target.itemId,
      label: target.url,
      run: async () => {
        const filename = allocator.next(target.convId, target.ext);
        try {
          await performDownload(target, filename, tabId);
        } catch (error) {
          // 第一次失败 → 换一份新签名再试一次（常见的失败原因就是签名过期）
          const fresh = await refreshTargetUrl(target, tabId);
          if (!fresh) throw error;
          await performDownload({ ...target, url: fresh }, allocator.next(target.convId, target.ext), tabId);
        }
      },
    })),
  );

  return { ok: true, queued: targets.length };
}

/* --------------------------------------------------------------------------- */
/* 页面状态                                                                      */
/* --------------------------------------------------------------------------- */

function isDoubaoUrl(url: string | undefined): boolean {
  // 域名判定集中在 site-contract（`isDoubaoHostUrl`），这里只补「是会话页路径」一层
  if (!isDoubaoHostUrl(url)) return false;
  try {
    const { pathname } = new URL(url ?? '');
    return CHAT_PATH_PATTERN.test(pathname) || THREAD_PATH_PATTERN.test(pathname);
  } catch {
    return false;
  }
}

/**
 * 豆包域内的**会话页 / 分享页**（路径里带会话 ID）。
 *
 * 与 `isDoubaoUrl` 的区别只在「有没有会话 ID」：首页 `/chat/` 会命中 `CHAT_PATH_PATTERN`
 * 但没有 ID，它属于「豆包非对话页」而不是「会话页待刷新」（2026-09-28 第十轮，与页面侧
 * `detectKind` 同一条口径）。
 */
function isDoubaoConversationUrl(url: string | undefined): boolean {
  return isDoubaoUrl(url) && CONV_ID_PATTERN.test(url ?? '');
}

const NONE_PAGE: PageInfo = { kind: 'none', convId: '', title: '', url: '', injected: false };

async function buildStateResponse(request?: StateRequest): Promise<StateResponse> {
  const config = await readConfig();
  const { tabId, followedRecent } = await resolveReportTarget(request?.tabId, request?.follow === true);

  let page: PageInfo = { ...NONE_PAGE };
  let stale = false;

  if (tabId !== null) {
    const info = await trySendToTab<PageInfo>(tabId, MSG.TabQuery);
    if (info && typeof info.kind === 'string') {
      page = info;
      if (page.kind !== 'none') {
        void rememberContentTab(tabId);
        // 会话作用域兜底收敛：即使 conv:scope 消息丢了，问一次页面也能对齐
        await applyScope({ convId: page.convId, title: page.title, kind: page.kind });
      }
    } else {
      // 内容脚本没应答：区分「豆包会话页但没注入」与「压根不是会话页」
      // ⚠️ 只对**带会话 ID 的页面**才算「待刷新」——首页 `/chat/` 没有会话，刷新也不会变成会话
      const tabUrl = await tabUrlOf(tabId);
      stale = isDoubaoConversationUrl(tabUrl);
      if (stale) void rememberContentTab(tabId);
      page = { ...NONE_PAGE, url: tabUrl };
      diag(
        'bg.state',
        `tab:query 无应答 tabId=${tabId} url=${tabUrl.slice(0, 120)} 判定为${stale ? '豆包页待刷新' : '非豆包页'}`,
        { level: 'warn' },
      );
    }
  }

  // ⚠️ 必须等会话作用域收敛之后再取库，否则本次的 stats 会按「裁剪前」的旧库算
  const library = await getLibrary();
  const stats = statsOf(library, page.convId || undefined);
  diag(
    'bg.state',
    `tabId=${tabId ?? '-'}${followedRecent ? '(跟随最近豆包页)' : ''} page=${page.kind}/${page.convId || '-'} title=${
      page.title || '-'
    } lib=${Object.keys(library).length} stats=${stats.total}`,
  );

  return {
    config,
    page,
    stale,
    stats,
    libraryTotal: Object.keys(library).length,
    version: EXT_VERSION,
    progress: lastProgress,
  };
}

/* --------------------------------------------------------------------------- */
/* 消息路由                                                                      */
/* --------------------------------------------------------------------------- */

onRuntimeMessage((env, sender, sendResponse) => {
  switch (env.type) {
    /* ---- content → bg ---- */
    case MSG.MediaAppend: {
      const drafts = env.payload as MediaDraft[] | undefined;
      if (typeof sender.tab?.id === 'number') void rememberContentTab(sender.tab.id);
      if (Array.isArray(drafts) && drafts.length) {
        queueDrafts(drafts);
        diag('bg.media', `收到草稿 ${drafts.length} 条：${drafts.map((d) => `${d.kind}:${d.state}`).join(',')}`);
      }
      sendResponse({ ok: true });
      return undefined;
    }

    case MSG.DiagAppend: {
      const payload = env.payload as DiagRecord | DiagRecord[] | undefined;
      if (typeof sender.tab?.id === 'number') void rememberContentTab(sender.tab.id);
      if (Array.isArray(payload)) appendDiag(payload);
      else if (payload) appendDiag([payload]);
      sendResponse({ ok: true });
      return undefined;
    }

    // 当前激活会话变了（第四轮）→ 资源库按会话裁剪 + 刷新会话名
    case MSG.ConvScope: {
      const scope = env.payload as ConvScope | undefined;
      if (typeof sender.tab?.id === 'number') void rememberContentTab(sender.tab.id);
      if (scope && typeof scope.convId === 'string') {
        void applyScope(scope).then(() => sendResponse({ ok: true }));
        return true;
      }
      sendResponse({ ok: false });
      return undefined;
    }

    // 原片已超期（2026-09-27 Finding C）：页面翻遍创作树未见该 vid → 确定性失败，不再永挂「解析中」
    case MSG.LibraryExpire: {
      const payload = env.payload as { convId?: string; fingerprint?: string; vid?: string } | undefined;
      if (payload?.convId && payload.fingerprint) {
        void (async () => {
          const library = await getLibrary();
          const next = markExpired(library, payload.convId as string, payload.fingerprint as string);
          if (next !== library) {
            await persistLibrary(next);
            diag(
              'bg.expire',
              `convId=${payload.convId} fingerprint=${payload.fingerprint} → 原片已超期（创作树二次确认仍未见）`,
              { level: 'warn' },
            );
            /*
             * 超期条目拿不到创作树节点 `size`（作品已被站点清除），但它的 `primary` 仍是
             * 站点可下载的那个文件 —— 实测一次字节数，卡片就有「文件大小」了
             * （口径：显示的是**能下载到的那个文件**的体积，用户已拍板，2026-09-28）。
             */
            void backfillSizes([itemId(payload.convId as string, payload.fingerprint as string)]);
          }
          sendResponse({ ok: true });
        })();
        return true;
      }
      sendResponse({ ok: false });
      return undefined;
    }

    /* ---- UI → bg ---- */
    case MSG.DiagGet: {
      void getDiag().then((records) => sendResponse({ records }));
      return true;
    }

    case MSG.DiagClear: {
      void resetDiag().then(() => sendResponse({ ok: true }));
      return true;
    }
    case MSG.StateGet: {
      void buildStateResponse(env.payload as StateRequest | undefined).then(sendResponse);
      return true;
    }

    case MSG.ConfigPatch: {
      const patch = (env.payload ?? {}) as Partial<Config>;
      void patchConfig(patch).then((config) => sendResponse({ ok: true, config }));
      return true;
    }

    case MSG.LibraryList: {
      void (async () => {
        // 打开资源库时主动对齐一次会话作用域：保证返回的库就是「当前激活会话的库」
        const { tabId } = await resolveReportTarget(undefined, false);
        await syncScopeFromTab(tabId);
        const [library, config, scope] = await Promise.all([getLibrary(), readConfig(), recallScope()]);
        sendResponse({ library, config, scope });
      })();
      return true;
    }

    case MSG.DownloadOne:
    case MSG.DownloadMany:
    case MSG.DownloadRetry: {
      const request = (env.payload ?? {}) as DownloadRequest;
      void handleDownloadRequest(request, sender.tab?.id)
        .then(sendResponse)
        .catch((error: unknown) =>
          sendResponse({ ok: false, queued: 0, error: String((error as Error)?.message ?? error) }),
        );
      return true;
    }

    /*
     * 资源库卡片点了「预览」（2026-09-28 第十轮）→ 让**页面**去定位这条资源并尽力唤起
     * 豆包自己的预览（用户拍板：插件不自己造播放器，只当「豆包功能的另一个入口」）。
     * 页面返回 `found`（是否在 DOM 里找到）—— 找不到时弹窗会如实提示，而不是假装成功。
     */
    case MSG.PreviewLocate: {
      const keys = (env.payload as { keys?: string[] } | undefined)?.keys;
      if (!Array.isArray(keys) || !keys.length) {
        sendResponse({ found: false });
        return undefined;
      }
      void (async () => {
        const { tabId } = await resolveReportTarget(undefined, false);
        if (tabId === null) {
          diag('bg.preview', '定位请求失败：没有可用的标签页', { level: 'warn' });
          sendResponse({ found: false, error: '没有可用的标签页' });
          return;
        }
        const res = await trySendToTab<{ found?: boolean }>(tabId, MSG.PreviewLocate, { keys }, 8_000);
        const found = res?.found === true;
        diag('bg.preview', `定位 keys=${keys.length} → ${found ? 'found' : 'not-found'}（tab #${tabId}）`, {
          level: found ? 'info' : 'warn',
        });
        sendResponse({ found });
      })();
      return true;
    }

    default:
      return undefined;
  }
});

/* --------------------------------------------------------------------------- */
/* 生命周期                                                                      */
/* --------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(() => {
  void migrate();
});

chrome.runtime.onStartup.addListener(() => {
  void migrate();
});

onStateChanged((change) => {
  // background 是唯一写入方，库里出现外部变更只可能是别的上下文写入 → 同步缓存
  if (change.library) libraryCache = change.library;
});

// SW 唤醒后从磁盘恢复资源库缓存
void readState().then((state) => {
  libraryCache = state.library;
});
