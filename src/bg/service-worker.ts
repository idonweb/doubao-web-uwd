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
import { createRepeatSuppressor, makeRecord, pushBounded, type DiagRecord } from '../core/diagnostics';
import { DownloadQueue, FilenameAllocator, parseTotalBytes } from '../core/download';
import {
  type Library,
  filterDraftsByConv,
  isLeaveScope,
  itemId,
  markExpired,
  markFailed,
  needsShareWatermark,
  patchItem,
  rekeyConv,
  retainConv,
  retitleConv,
  sizeForNow,
  statsOf,
  upsertDrafts,
} from '../core/library-store';
import { broadcast, onRuntimeMessage, trySendToTab } from '../core/messaging';
import { canRetryProbe, needsRawSizeUpgrade, needsSizeProbe, probeWriteBlocked, recordProbeAttempt } from '../core/size-probe';
import { migrate, onStateChanged, patchConfig, readConfig, readLibrarySlots, readState, writeLibrarySlots } from '../core/storage';
import {
  CHAT_PATH_PATTERN,
  SIZE_PROBE_RANGE,
  THREAD_PATH_PATTERN,
  VIDEO_SHARE_PATH_PATTERN,
  convIdFromUrl,
  isDoubaoHostUrl,
  isLocalConvId,
} from '../core/site-contract';
import type {
  Config,
  ConvScope,
  DiagChangedPayload,
  DownloadProgress,
  DownloadRequest,
  DownloadTarget,
  LibraryRequest,
  LibrarySyncPayload,
  MediaDraft,
  MediaItem,
  PageInfo,
  StateRequest,
  StateResponse,
} from '../core/types';
import type { LibrarySlots } from '../core/storage';


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
    /*
     * 广播顺带捎上「此刻的环境快照」，诊断页的环境卡片就能跟着日志一起活，
     * 不必自己发 `state:get` / `library:list` 去问 —— 那两者每次都会经 `tab:query`
     * 在缓冲里写下 3 条非关键记录（`docs/03` §28.3：观察者扰动了被测对象）。
     * 触发时机天然正确：库的每次条数变化（`bg.upsert` / `bg.scope`）本身就带一条诊断记录，
     * 记录 → 400ms 去抖 → 这里，所以「库变了必然广播」。
     */
    const slot = slotOf(await getSlots(), lastContentTabId);
    const scope = await recallScope();
    const payload: DiagChangedPayload = {
      count: diagCache.length,
      lib: Object.keys(slot).length,
      scope,
    };
    broadcast(MSG.DiagChanged, payload);
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

/** 纯查询回执的重复抑制（§40）—— 只作用于 `page.query` / `content.query` / `bg.state` */
const shouldLogDiag = createRepeatSuppressor();

function diag(event: string, detail?: string, options: { level?: 'info' | 'warn' | 'error'; text?: string } = {}): void {
  if (!shouldLogDiag(event, detail ?? '')) return;
  appendDiag([makeRecord('bg', event, detail, options)]);
}


/* --------------------------------------------------------------------------- */
/* 资源库缓存（background 是唯一写入方）—— **按标签页分槽**（2026-10-02 §38）          */
/*                                                                             */
/* 结构：`tabId → 槽`；槽内部与第四轮完全一致（只管该标签页的当前会话）。              */
/* 这样一来「切走即清」只清自己那个槽，不再把别的标签页刚解析出来的条目删掉 ——        */
/* 旧的全局单槽在多标签页下就是「互相删库」（实测 3 个标签页来回切 → 三边全空）。        */
/* --------------------------------------------------------------------------- */

let slotsCache: LibrarySlots | null = null;

async function getSlots(): Promise<LibrarySlots> {
  if (!slotsCache) slotsCache = await readLibrarySlots();
  return slotsCache;
}

/** 取某个标签页的槽（没有 / 拿不到 tabId → 空槽） */
function slotOf(slots: LibrarySlots, tabId: number | null | undefined): Library {
  if (typeof tabId !== 'number') return {};
  return slots[String(tabId)] ?? {};
}

async function persistSlots(next: LibrarySlots): Promise<void> {
  slotsCache = next;
  await writeLibrarySlots(next);
}

/**
 * 写一个标签页的槽，并**主动广播**给 UI（`library:sync`）。
 *
 * 为什么要广播：UI（扩展页）没有 tabId，无法从 `storage.onChanged` 里挑出自己的槽；
 * 而弹窗是单例，所以「推当前槽」永远是对的（诊断页仍走 `diag:changed` 快照）。
 */
async function writeSlot(tabId: number, slot: Library): Promise<void> {
  const slots = { ...(await getSlots()) };
  const key = String(tabId);
  if (Object.keys(slot).length) slots[key] = slot;
  else delete slots[key];
  await persistSlots(slots);
  broadcast(MSG.LibrarySync, { convId: tabScopeOf(tabId)?.convId ?? '', library: slot });
}

/** 丢掉一个标签页的槽（关标签页 / 离开会话 / 启动对账） */
async function dropSlot(tabId: number, reason: string): Promise<void> {
  const slots = await getSlots();
  if (!slots[String(tabId)]) return;
  const counts = Object.keys(slots[String(tabId)]).length;
  const next = { ...slots };
  delete next[String(tabId)];
  await persistSlots(next);
  diag('bg.slot', `tab #${tabId} 槽已删除（${reason}，原 ${counts} 条）`);
}

/* --------------------------------------------------------------------------- */
/* 会话作用域（2026-09-26 第四轮；2026-10-02 §38 改为**按标签页**）                   */
/*                                                                             */
/* 用户口径不变：**资源库只针对「当前激活的对话本身」**。                            */
/* 页面脚本在会话切换 / 标题解析完成时上报 `conv:scope`，这里据此：                   */
/*   ① 会话变了 → 裁剪**该标签页的槽**（切走即清空，但只清自己）                      */
/*   ② 拿到真实标题 → 刷新该标签页槽内条目的会话名（解除「兜底标题粘住」）              */
/*                                                                             */
/* ⚠️ 槽的生命周期（§38 新增，实机 bug 的修复点）：                                  */
/*   · 关标签页（`tabs.onRemoved`）→ 删槽；                                        */
/*   · 该标签页离开会话（`tabs.onUpdated` 导航到非会话页，或页面自报 `kind=none`）→ 清该槽；*/
/*   · 浏览器重启后 tabId 重新分配 → 启动时对账，删掉不再存在的槽。                     */
/* --------------------------------------------------------------------------- */

const SESSION_SCOPE = 'uwd:activeScope';
const SESSION_TAB_SCOPES = 'uwd:tabScopes';

/** 全局「最近一次会话」快照 —— §38 起**只用于诊断**（真正的判定都走按标签页的 `tabScopes`） */
let activeScope: ConvScope | null = null;
/** `tabId → 该标签页当前会话`（内存 + session 存储） */
let tabScopes: Map<number, ConvScope> | null = null;

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

async function getTabScopes(): Promise<Map<number, ConvScope>> {
  if (tabScopes) return tabScopes;
  tabScopes = new Map();
  try {
    const data = (await chrome.storage.session.get(SESSION_TAB_SCOPES)) as Record<string, unknown>;
    const raw = data[SESSION_TAB_SCOPES];
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const tabId = Number(key);
        if (Number.isInteger(tabId) && value && typeof (value as ConvScope).convId === 'string') {
          tabScopes.set(tabId, value as ConvScope);
        }
      }
    }
  } catch {
    /* 忽略 */
  }
  return tabScopes;
}

/** 同步读取某个标签页的会话（读缓存；没加载过就先返回 null，调用方在 async 上下文里先 `getTabScopes()`） */
function tabScopeOf(tabId: number | null | undefined): ConvScope | null {
  if (typeof tabId !== 'number') return null;
  return tabScopes?.get(tabId) ?? null;
}

async function persistTabScopes(): Promise<void> {
  try {
    const record: Record<string, ConvScope> = {};
    for (const [tabId, scope] of (await getTabScopes()).entries()) record[String(tabId)] = scope;
    await chrome.storage.session.set({ [SESSION_TAB_SCOPES]: record });
  } catch {
    /* session 存储不可用时只留内存 */
  }
}

async function rememberTabScope(tabId: number, scope: ConvScope): Promise<void> {
  (await getTabScopes()).set(tabId, scope);
  await persistTabScopes();
}

async function forgetTabScope(tabId: number): Promise<void> {
  const scopes = await getTabScopes();
  if (!scopes.delete(tabId)) return;
  await persistTabScopes();
}

/** 归一化：空串与「没有作用域」等价，避免把 `''` 当成一次真正的会话切换 */
function scopeKey(scope: ConvScope | null | undefined): string | null {
  const convId = scope?.convId?.trim();
  return convId ? convId : null;
}

/** 结束**全局**会话快照（`isLeaveScope` 分支专用；槽的清理由 `dropSlot` 负责） */
async function clearScope(): Promise<void> {
  activeScope = null;
  try {
    await chrome.storage.session.remove(SESSION_SCOPE);
  } catch {
    /* session 存储不可用时内存已置空 */
  }
}

/**
 * 应用一次会话上报 —— **作用范围 = 这一个标签页的槽**（§38）。
 *
 * `tabId === null`（拿不到标签页，例如诊断页在没有豆包标签页时取状态）只记全局快照，
 * 不动任何槽：绝不能因为「不知道是谁」就把某个槽清掉。
 */
async function applyScope(scope: ConvScope, tabId: number | null = null): Promise<void> {
  try {
    const convId = scope.convId.trim();

    /*
     * 离开会话（2026-09-27 第八轮；§38 收窄到本标签页）：
     * 豆包域内的非会话页（首页 `/chat` 等）→ **只清这个标签页的槽**。
     * 旧实现 `persistLibrary({})` 清的是全局库 —— 多标签页下等于「切一下主页，
     * 另外两个分享页的资源全没」（实机截图 2/3/4 就是这个）。
     */
    if (isLeaveScope(scope)) {
      if (tabId === null) return;
      const previous = (await getTabScopes()).get(tabId);
      if (!previous) return; // 幂等：本来就没有会话
      await forgetTabScope(tabId);
      const slot = slotOf(await getSlots(), tabId);
      const left = Object.keys(slot).length;
      if (left) await writeSlot(tabId, {});
      if (scopeKey(await recallScope()) === scopeKey(previous)) await clearScope();
      diag('bg.scope', `tab #${tabId} 离开会话（kind=${scope.kind}）→ 该槽清空（原 ${left} 条）`);
      return;
    }

    // 没有标签页上下文时只记全局快照（不动槽）
    const previous = tabId === null ? await recallScope() : ((await getTabScopes()).get(tabId) ?? null);
    const convChanged = scopeKey(previous) !== scopeKey(scope);
    const titleChanged = Boolean(convId && scope.title && previous?.title !== scope.title);

    if (tabId !== null) {
      await rememberTabScope(tabId, {
        convId,
        kind: scope.kind,
        title: scope.title || (convChanged ? '' : (previous?.title ?? '')),
      });
    }
    await rememberScope({
      convId,
      kind: scope.kind,
      title: scope.title || (convChanged ? '' : (previous?.title ?? '')),
    });
    if (!convChanged && !titleChanged) return;

    const slots = await getSlots();
    const before = slotOf(slots, tabId);
    let next = before;
    if (convChanged && convId) {
      /*
       * 新建会话的占位 ID（`local_*`）→ 真实 ID（2026-09-27 第七轮）：
       * 占位窗口期入库的条目 convId 是占位值，直接 retainConv 会把它们当「异会话」清掉。
       * 先重键到真实会话、再裁剪 —— 新会话生成阶段捕获的素材因此不会丢。
       * ⚠️ §38 起顺序很重要：**先重键、后裁剪**，且都只在本标签页的槽内进行。
       */
      const previousId = scopeKey(previous);
      if (previousId && isLocalConvId(previousId) && !isLocalConvId(convId)) {
        next = rekeyConv(next, previousId, convId);
      }
      next = retainConv(next, convId);
    }
    if (convId && scope.title) next = retitleConv(next, convId, scope.title);
    if (tabId !== null && next !== before) await writeSlot(tabId, next);

    diag(
      'bg.scope',
      `tab #${tabId ?? '-'} convId=${convId || '-'} kind=${scope.kind} title=${scope.title || '-'} 会话变更=${convChanged} 槽内保留=${
        Object.keys(next).length
      }/${Object.keys(before).length}`,
    );
  } catch (error) {
    // 会话作用域是增强能力：出错绝不能让 state:get / library:list 挂住
    diag('bg.scope', `应用会话作用域失败：${String((error as Error)?.message ?? error)}`, { level: 'error' });
  }
}

/**
 * 主动向某个标签页问一次页面信息，并据此应用会话作用域（**只影响该标签页的槽**）。
 * 用作兜底：即使 `conv:scope` 消息丢了（SW 被回收等），打开弹窗 / 资源库时也会收敛。
 */
async function syncScopeFromTab(tabId: number | null): Promise<PageInfo | null> {
  if (tabId === null) return null;
  const info = await trySendToTab<PageInfo>(tabId, MSG.TabQuery);
  if (!info || typeof info.kind !== 'string' || info.kind === 'none') return null;
  await applyScope({ convId: info.convId, title: info.title, kind: info.kind }, tabId);
  return info;
}

/* --------------------------------------------------------------------------- */
/* 媒体草稿入库（短去抖：SSE 增量推送会高频触发）                                  */
/* --------------------------------------------------------------------------- */

/** 缓冲里的草稿**必须带着来源标签页**：入库要写进「它自己那个槽」（§38） */
interface BufferedDraft {
  tabId: number;
  draft: MediaDraft;
}

let draftBuffer: BufferedDraft[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queueDrafts(drafts: MediaDraft[], tabId: number | null): void {
  if (typeof tabId !== 'number') {
    diag('bg.upsert', `丢弃无标签页来源的草稿 ${drafts.length} 条`, { level: 'warn' });
    return;
  }
  draftBuffer.push(...drafts.map((draft) => ({ tabId, draft })));
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

  // 按来源标签页分组：每组写进各自的槽（§38 —— 不再有「全局作用域」这一步）
  const byTab = new Map<number, MediaDraft[]>();
  for (const entry of buffered) {
    const list = byTab.get(entry.tabId);
    if (list) list.push(entry.draft);
    else byTab.set(entry.tabId, [entry.draft]);
  }

  const config = await readConfig();
  const slots = { ...(await getSlots()) };
  let touched = false;
  /** 体积实测要等**写库之后**再发（否则 `getSlots()` 还是旧缓存，条目看起来「不存在」→ 静默漏测） */
  const pendingProbes: Array<{ tabId: number; ids: string[] }> = [];

  for (const [tabId, drafts] of byTab) {
    /*
     * 会话作用域：只收「**这个标签页**当前会话」的草稿 —— chain / SSE 的响应可能晚于
     * 「用户在这个标签页里切走」才到，收进来就会变成该槽里另一个会话的残留条目
     * （原全局版判定的语义一字未改，只是把「当前会话」从全局换成按标签页）。
     */
    const scope = (await getTabScopes()).get(tabId);
    if (!scope?.convId) {
      diag('bg.upsert', `tab #${tabId} 无激活会话，丢弃草稿 ${drafts.length} 条`, { level: 'warn' });
      continue;
    }
    const accepted = filterDraftsByConv(drafts, scope.convId);
    const dropped = drafts.length - accepted.length;
    if (dropped > 0) {
      diag('bg.upsert', `tab #${tabId} 丢弃异会话草稿 ${dropped} 条（该槽会话=${scope.convId}）`, { level: 'warn' });
    }
    if (!accepted.length) continue;

    const slot = slotOf(slots, tabId);
    const result = upsertDrafts(slot, accepted, { skipThumbOnly: config.skipThumbOnly });
    if (result.added || result.merged) {
      slots[String(tabId)] = result.library;
      touched = true;
      broadcast(MSG.LibrarySync, { convId: scope.convId, library: result.library } satisfies LibrarySyncPayload);
    }

    diag(
      'bg.upsert',
      `tab #${tabId} in=${accepted.length} added=${result.added} merged=${result.merged} skipped=${result.skipped} evicted=${result.evicted} slot=${Object.keys(result.library).length} skipThumbOnly=${config.skipThumbOnly}`,
      result.added || result.merged ? {} : { level: 'warn' },
    );

    // 体积实测：创作树里查不到体积的条目（候选流 / 超期视频 / 超过约三个月的旧图片）
    // 立刻量一次真实字节数 —— **入库即测**（`pending` 也测：先给出「预览体积」，
    // 原片就绪后由树里的真值覆盖，见 `core/size-probe.ts` 与 `docs/03` §37）。
    // ⚠️ 真正发起在**本批全部写库之后**（下面的循环），否则读到的还是旧缓存；
    // 且**不 await**：每条最多 8s，等在这里会把入库链路拖住几十秒，期间别的写入
    // （`bg.expire` 的超期落库等）可能被旧快照回写覆盖 —— 实测踩过这个坑。
    pendingProbes.push({ tabId, ids: accepted.map((draft) => itemId(draft.convId, draft.fingerprint)) });
  }

  if (touched) await persistSlots(slots);
  for (const probe of pendingProbes) void backfillSizes(probe.tabId, probe.ids);
}

/* --------------------------------------------------------------------------- */
/* 体积实测（2026-09-28 第十轮补丁；2026-10-02 §37 改「入库即测」）                    */
/*                                                                             */
/* 体积的**首选来源**是创作树节点 `size`（视频由 vid 三步 API 带回、图片由页面侧         */
/* `imageSizeOf` 查树带回）—— 零额外请求、实测与落盘字节数一致。                      */
/* 树里没有的条目（候选流 / 超期视频 / 超过约三个月的旧图片）就只能**实测**：            */
/* 对条目 `primary`（点下载真正会拿到的那个地址）发一次 `Range: bytes=0-0`，             */
/* 从 `Content-Range` 读总长 —— 只下 1 字节。                                      */
/*                                                                             */
/* ⚠️ 必须在这里（background）发：页面里发会被 CORS 挡住响应头（探针实测                */
/* `content-range=null`；而 `*.365yg.com` 还会因为页面请求带豆包 Referer 直接回 403）。  */
/* 扩展上下文有 host_permissions（不需要 `Range` 的**预检**也实测能过：该域回 200 +      */
/* `ACAO: *` + `Allow-Headers: range`），能读全 —— 见 `docs/03` §37 的四个 curl 实验。   */
/*                                                                             */
/* ⚠️ 调度规则见 `core/size-probe.ts`（纯函数、可单测）：**入库即测**（`state=pending`     */
/* 也测）、**按「条目 + 归一化地址」记账**（地址换成另一个文件就允许重测）、              */
/* **失败只重试 1 次**（`LIMITS.SIZE_PROBE_RETRY`），绝不做无上限轮询。                 */
/* --------------------------------------------------------------------------- */

/**
 * 探测记账：**每个标签页一份**（`tabId → (sizeProbeKey(item) → 已尝试次数)`）。
 *
 * ⚠️ 原实现是 `Set<itemId>` 且**在测量之前就记下** → 一次失败即永久跳过（时有时无的根因），
 * 且地址换成另一个文件后也不会重测。现在按「条目 + 归一化地址」记账、失败留重试额度。
 * 量到就写 `meta.size`，`needsSizeProbe` 见它有值即跳过 —— 成功不需要额外标记。
 * §38 起再按标签页分层：条目 id 只在槽内唯一（同一会话在两个标签页里会有两份同名 id）。
 */
const sizeProbeAttempts = new Map<number, Map<string, number>>();

function attemptsFor(tabId: number): Map<string, number> {
  let map = sizeProbeAttempts.get(tabId);
  if (!map) {
    map = new Map<string, number>();
    sizeProbeAttempts.set(tabId, map);
  }
  return map;
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
 * 给「体积仍缺失」的条目实测字节数，回写 `meta.size`。
 * 每轮最多 `SIZE_PROBE_MAX_PER_ROUND` 条、串行执行（避免对 CDN 打出脉冲）。
 *
 * 入参是**条目 id**（`itemId()` 的产物）—— 入库后（`flushDrafts`）与「原片已超期」落库后
 * 都要走一次；地址换成另一个文件的条目也会被下一次 upsert 重新排进来（按地址记账）。
 */
async function backfillSizes(tabId: number, ids: Iterable<string>): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const slot = slotOf(await getSlots(), tabId);
  const attempts = attemptsFor(tabId);
  const candidates = unique
    .map((id) => slot[id])
    .filter((item): item is MediaItem => !!item && needsSizeProbe(item, attempts));
  const todo = candidates.slice(0, LIMITS.SIZE_PROBE_MAX_PER_ROUND);
  const rest = candidates.slice(LIMITS.SIZE_PROBE_MAX_PER_ROUND).map((item) => item.id);
  if (!todo.length) return;

  let measured = 0;
  let rawCount = 0;
  let failed = 0;
  /** 扫描到「该测」、但轮到它时条目已经被清掉（切会话/关标签页）—— 单列一档，别混进「失败」 */
  let vanished = 0;
  /** 写回被守卫拦下（预览实测值晚于创作树真值到场，§41）—— 保留真值，不覆盖 */
  let keptRaw = 0;
  const notes: string[] = [];
  const samples: string[] = [];
  const retryIds: string[] = [];
  /** 写回了「预览体积」但条目已原片就绪 → 稍后自触发一次升级补测（§41，不等下一次 upsert） */
  const upgradeIds: string[] = [];
  for (const item of todo) {
    // 先记账再发请求（并发安全）；失败时额度没用完 → 排一次重试
    const used = recordProbeAttempt(attempts, item);
    const result = await measureBytes(item.primary);
    if (result.size === undefined) {
      failed += 1;
      if (notes.length < 2) notes.push(result.note);
      if (canRetryProbe(used)) retryIds.push(item.id);
      continue;
    }
    /*
     * 每条**重新读一次**当前槽再打补丁：批量下载/解析期间别的路径（如 `bg.expire`、
     * 页面新草稿）也在写库，用旧快照整体回写会把它们的成果抹掉。
     *
     * ⚠️ **归属标记必须按「测量那一刻」的快照判定**（§39）：`item` 是扫描时的快照，
     * 而 `primary` 可能在测量的这 ~0.7s 里从候选流切到原片 —— 旧实现只写数字不写归属，
     * 于是「候选流的 3.0 MB」被记成了原片体积（实机卡片 `3.0 MB` 对真原片 `7.1 MB`）。
     * ⚠️ 判据用 `sizeForNow()`（`rawReady`：`state === 'raw'` **或** primary 是 isRaw 变体）——
     * 与「要不要升级测量」共用同一把尺子，避免两处判据分叉（§39.6 的实机 bug）。
     * ⚠️ **写回守卫（§41）**：若测的是预览归属、而条目此刻已拿着原片归属的体积
     * （创作树真值在探测在飞期间落库），这次写回是**降级**，必须跳过 ——
     * 实机：真值 35.9 MB 落库后 0.4s 被在飞预览实测覆盖回「预览 5.1 MB」，
     * 而升级补测没有自触发，卡片停了 ~39s 才因用户开弹窗触发重解析翻正。
     */
    const current = slotOf(await getSlots(), tabId)[item.id];
    if (!current) {
      vanished += 1;
      continue;
    }
    const sizeFor = sizeForNow(item);
    if (probeWriteBlocked(item, current)) {
      keptRaw += 1;
      continue;
    }
    await writeSlot(tabId, patchItem(slotOf(await getSlots(), tabId), item.id, {
      meta: { ...current.meta, size: result.size, sizeFor },
    }));
    measured += 1;
    if (sizeFor === 'raw') rawCount += 1;
    else if (needsRawSizeUpgrade(current)) upgradeIds.push(item.id);
    /*
     * 样本行（§40）：诊断里必须能看出「这条体积是量谁得到的、算到哪个文件头上」——
     * 此前 `bg.size` 只有汇总数字，排查「卡片体积不对」时无从下手（`docs/03` §39 / §39.6
     * 两轮都得反推）。最多留 3 条，控制记录长度。
     */
    if (samples.length < 3) {
      const tag = item.fingerprint.length > 8 ? item.fingerprint.slice(-8) : item.fingerprint;
      samples.push(`${tag}→${(result.size / 1048576).toFixed(1)}MB(${sizeFor === 'raw' ? '原片' : '预览'})`);
    }
  }
  diag(
    'bg.size',
    `实测字节（tab #${tabId}）：成功 ${measured} 条（原片 ${rawCount} / 预览体积 ${measured - rawCount}）/ 失败 ${failed} 条${
      vanished ? ` / 已消失 ${vanished} 条` : ''
    }${keptRaw ? ` / 保留真值 ${keptRaw} 条（§41）` : ''}（候选 ${todo.length} 条${
      rest.length ? `，余 ${rest.length} 条下一轮继续` : ''
    }${
      retryIds.length ? `，${retryIds.length} 条 ${Math.round(LIMITS.SIZE_PROBE_RETRY_DELAY_MS / 1000)}s 后重试` : ''
    }${
      upgradeIds.length
        ? `，${upgradeIds.length} 条 ${Math.round(LIMITS.SIZE_PROBE_UPGRADE_DELAY_MS / 1000)}s 后升级补测（原片就绪、只有预览体积）`
        : ''
    }）${samples.length ? `｜样本：${samples.join(' ')}` : ''}${notes.length ? `｜失败原因：${notes.join(' ; ')}` : ''}`,
    measured || keptRaw ? {} : { level: 'warn' },
  );
  /*
   * 一个会话里可能压着几十条待测（例如整屏都是超过三个月的旧图片），而每轮只放
   * `SIZE_PROBE_MAX_PER_ROUND` 条 —— 剩下的**分批续跑**（一次性定时器，不是轮询；
   * 每轮都会把测过的地址记进 `sizeProbeAttempts`，所以一定会收敛到「没有候选」而停下）。
   */
  if (rest.length) setTimeout(() => void backfillSizes(tabId, rest), LIMITS.SIZE_PROBE_CONTINUE_MS);
  // 失败重试：同样是一次性定时器，且额度写死在 `LIMITS.SIZE_PROBE_RETRY`（用户拍板 1 次）
  if (retryIds.length) setTimeout(() => void backfillSizes(tabId, retryIds), LIMITS.SIZE_PROBE_RETRY_DELAY_MS);
  /*
   * 升级补测自触发（§41）：写回「预览体积」时条目已原片就绪（创作树真值没给 `size`、
   * 或真值落库与本轮写回赛跑）—— 原实现只能等「下一次 upsert」才有机会升级，
   * 用户不动界面就一直停在「预览 X.X MB」。这里主动排一次补测：走同一套记账与额度
   * （原片地址是新账本），若下一次 upsert 先到且已带来真值，补测醒来发现
   * `needsSizeProbe = false` 自然空转退出，不会多发请求。
   */
  if (upgradeIds.length) setTimeout(() => void backfillSizes(tabId, upgradeIds), LIMITS.SIZE_PROBE_UPGRADE_DELAY_MS);
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

/**
 * 把一个条目落成「获取失败」。
 *
 * §38 起库是**多槽**的，而队列任务只带条目 id（槽内唯一，跨槽可能重名）——
 * 所以在所有槽里找一遍，命中几个就标几个（同一会话开在两个标签页时，两边都该显示失败）。
 */
async function markItemFailed(itemId: string): Promise<void> {
  const slots = { ...(await getSlots()) };
  let touched = false;
  for (const [tabKey, slot] of Object.entries(slots)) {
    if (!slot[itemId]) continue;
    const next = markFailed(slot, itemId);
    if (next === slot) continue;
    slots[tabKey] = next;
    touched = true;
  }
  if (touched) await persistSlots(slots);
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
 * 把条目的**补角状态**写回库（2026-10-03 第二十三轮 §43）。
 *
 * `fail = true`  → 同源校验未通过（这一档只能下到带水印的版本）→ 界面显示「仅带水印档」；
 * `fail = false` → 补角成功 → 清掉标记（**可自愈**，下次再下载/复验成功即恢复）。
 *
 * 与 `markItemFailed` 同一套多槽语义：条目 id 只在槽内唯一，所以在所有槽里找一遍。
 * ⚠️ 必须走 `writeSlot`（它才广播 `library:sync`），否则界面不会刷新。
 */
async function setPatchFail(itemId: string, fail: boolean): Promise<void> {
  if (!itemId) return;
  const slots = await getSlots();
  for (const [tabKey, slot] of Object.entries(slots)) {
    const item = slot[itemId];
    if (!item) continue;
    if (fail ? item.meta.patchFail === true : item.meta.patchFail === undefined) continue;
    const meta = { ...item.meta };
    if (fail) meta.patchFail = true;
    else delete meta.patchFail;
    await writeSlot(Number(tabKey), { ...slot, [itemId]: { ...item, meta } });
  }
}

/**
 * 把条目的**分享直链解析状态**写回库（2026-10-03 第三十轮 §48.7）。
 *
 * 分享页视频即使被判「原片不可得」（`meta.expired`），无水印仍可经分享直链拿到；
 * 但那一步在下载时可能失败（未登录 / 分享失效 / 网络问题）→ 这次实际下到的是
 * **站点给的带水印播放档**，界面必须如实降级成「仅带水印档」，不假装无水印。
 *
 * `fail = true`  → 这一次直链没解出（回退下带水印档）→ 界面显示「仅带水印档」；
 * `fail = false` → 直链解出并下载 → 清掉标记（**可自愈**，下次成功即恢复「无水印（分享页）」）。
 *
 * 与 `setPatchFail` 同一套多槽语义 + `writeSlot` 广播；`meta.shareDlFail` 与 `patchFail` 一样
 * **不进 `metaMerge` 白名单**（它不是「文件的描述」，是下载时的一次解析结果，由 bg 显式设置/清除）。
 */
async function setShareFail(itemId: string, fail: boolean): Promise<void> {
  if (!itemId) return;
  const slots = await getSlots();
  for (const [tabKey, slot] of Object.entries(slots)) {
    const item = slot[itemId];
    if (!item) continue;
    if (fail ? item.meta.shareDlFail === true : item.meta.shareDlFail === undefined) continue;
    const meta = { ...item.meta };
    if (fail) meta.shareDlFail = true;
    else delete meta.shareDlFail;
    await writeSlot(Number(tabKey), { ...slot, [itemId]: { ...item, meta } });
  }
}

/**
 * 取流方案（方案 §7.3）：
 *   auto      → 先试 A，失败自动回退 B（默认）
 *   downloads → 只用 A
 *   blob      → 只用 B
 *
 * 📌 **补角条目（2026-10-03 §43.9 方案 B）先走另一条路**：`chrome.downloads` 与页面 fetch
 * 都只能拿到「板上带水印的预览档」，只有**页面内的 canvas 合成**才能产出无水印图。
 * 所以有 `patch` 时先请页面补角；页面明确回「同源校验没过」时把条目标成 `patchFail`
 * （界面如实显示「仅带水印档」），然后照常回退下载带水印的原图 —— **绝不假装无水印**。
 */
async function performDownload(target: DownloadTarget, filename: string, tabId: number | null): Promise<void> {
  /*
   * **现场换无水印**（2026-10-03 §48 分享页；2026-10-04 §53 扩到**对话页超期视频**）：
   * 这类视频站点只给带水印播放档，无水印要靠页面把 vid 换成无水印直链（§47 实测走通）。
   *   · 分享页 `/thread/`（页面 SSR 里就有 `fallback_api`，免登录）与 `/video-sharing`
   *     （要调 `get_video_model`，需任意账号登录）；
   *   · 对话页超期视频（创作树原片已清，但播放源仍能换出无水印**原画质**档）。
   * 由 `target.shareVideo` 标记（判定 = `library-store::needsShareWatermark()`）。
   *
   * ⚠️ 直链**带时效** ⇒ 只能**下载那一刻现解现用**；解析失败 / 下载失败都**如实回退**
   *    去下站点给的那个档（带水印）—— **绝不假装无水印**（与补角链路同一哲学）。
   */
  if (target.shareVideo) {
    if (tabId === null || !target.vid) {
      diag('bg.download', `播放源换无水印链路不可用（${tabId === null ? '无豆包标签页' : '条目没有 vid'}）→ 下站点给的档 ${filename}`, { level: 'warn' });
      await setShareFail(target.itemId, true);
    } else {
      const quality = target.quality ?? 'light';
      const resolved = await trySendToTab<{ ok: boolean; url?: string; error?: string }>(
        tabId,
        MSG.ResolveShareVideo,
        { vid: target.vid, quality },
        30_000,
      );
      const url = resolved?.ok ? resolved.url : undefined;
      if (!url) {
        diag('bg.download', `播放源换无水印解析未成功（${resolved?.error ?? '页面脚本未就绪'}）→ 下站点给的档 ${filename}`, { level: 'warn' });
        await setShareFail(target.itemId, true);
      } else {
        diag('bg.download', `播放源无水印直链已解出（${quality}）→ 方案 A ${filename}`);
        try {
          await downloadWithDownloadsApi(url, filename);
          diag('bg.download', `方案 A 成功 ${filename}`);
          await setShareFail(target.itemId, false);
          return;
        } catch (error) {
          diag('bg.download', `方案 A 失败（${String((error as Error)?.message ?? error)}）→ 下站点给的档 ${filename}`, { level: 'warn' });
          await setShareFail(target.itemId, true);
        }
      }
    }
  }

  if (target.patch) {
    if (tabId === null) {
      diag('bg.download', `补角链路不可用（找不到可用的豆包标签页）→ 下带水印原图 ${filename}`, { level: 'warn' });
    } else {
      const result = await trySendToTab<{ ok: boolean; patched?: boolean; error?: string }>(
        tabId,
        MSG.FetchPatchBlob,
        { url: target.url, patch: target.patch, filename },
        10 * 60_000,
      );
      if (!result?.ok) {
        diag('bg.download', `补角失败（${result?.error ?? '页面脚本未就绪'}）→ 下带水印原图 ${filename}`, { level: 'warn' });
      } else if (result.patched) {
        diag('bg.download', `补角重建成功 ${filename}`);
        await setPatchFail(target.itemId, false);
        return;
      } else {
        diag('bg.download', `补角同源校验未通过（${result.error ?? '-'}）→ 下带水印原图 ${filename}`, { level: 'warn' });
        await setPatchFail(target.itemId, true);
      }
    }
  }

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

/**
 * 在所有槽里找一个条目（**唯一命中**才算数，§38）。
 *
 * 用于兜底：UI 传来的 id 是槽内键（`convId::fingerprint`），跨槽可能重名
 * （同一会话开在两个标签页）。正常路径先在「请求方标签页的槽」里找，找不到才来这里；
 * 多个槽都有同名条目时返回 null（说不清是哪一个 → 让调用方跳过，宁可不下载也不下错）。
 */
async function findItemEverywhere(id: string): Promise<{ tabId: number; item: MediaItem } | null> {
  const slots = await getSlots();
  let hit: { tabId: number; item: MediaItem } | null = null;
  for (const [tabKey, slot] of Object.entries(slots)) {
    const item = slot[id];
    if (!item) continue;
    if (hit) return null;
    hit = { tabId: Number(tabKey), item };
  }
  return hit;
}

/** 把 UI / 页面的下载请求展开成一批下载目标（**优先在请求方标签页的槽里找**） */
async function buildTargets(request: DownloadRequest, tabId: number | null): Promise<DownloadTarget[]> {
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
  const slot = slotOf(await getSlots(), tabId);
  const targets: DownloadTarget[] = [];
  for (const id of ids) {
    let item: MediaItem | undefined = slot[id];
    let slotTabId = tabId ?? undefined;
    if (!item) {
      const found = await findItemEverywhere(id);
      if (!found) continue;
      item = found.item;
      slotTabId = found.tabId;
    }
    const target: DownloadTarget = {
      itemId: item.id,
      convId: item.convId,
      url: item.primary,
      ext: item.meta.ext,
      // 文件名要用的两个站点真值：真实生成时间 + 所属对话页标题（弱/缺失时 download.ts 里兜底）
      createdAtMs: item.meta.createdAt,
      convTitle: item.convTitle,
      // 自愈回写要知道改哪个槽（§38）
      slotTabId,
    };
    // 补角配方（2026-10-03 §43）：有它 ⇒ 这个条目的「无水印」要在页面里两档互补合成
    if (item.meta.patch) target.patch = item.meta.patch;
    // 视频指纹形如 `vid:<x>` —— 签名地址过期时靠它让页面重新解析
    if (item.fingerprint.startsWith('vid:')) target.vid = item.fingerprint.slice(4);
    // 现场换无水印（2026-10-03 §48 分享页；2026-10-04 §53 扩到对话页超期视频）：
    // UI 只按「当前是不是会话页」置位，**这里逐条按 `needsShareWatermark()` 筛** ——
    // 图片、已拿到原片（state=raw）、非超期的视频一律不走这条路（否则会把真原片降级成预览档）。
    if (request.shareVideo && needsShareWatermark(item) && target.vid) {
      target.shareVideo = true;
      target.quality = request.quality === 'heavy' ? 'heavy' : 'light';
    }
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

  const slotTab = target.slotTabId ?? tabId;
  const slot = slotOf(await getSlots(), slotTab);
  if (target.itemId && slot[target.itemId]) {
    await writeSlot(slotTab, patchItem(slot, target.itemId, { primary: url, state: 'raw' }));
  }
  diag('bg.download', `已重新解析原片地址 vid=${target.vid}（签名过期自愈）`);
  return url;
}

async function handleDownloadRequest(
  request: DownloadRequest,
  senderTabId?: number,
): Promise<{ ok: boolean; queued: number; error?: string }> {
  const tabId = senderTabId ?? (await resolveActiveTabId());
  const targets = await buildTargets(request, tabId);
  if (!targets.length) return { ok: false, queued: 0, error: '没有可下载的资源' };

  const allocator = new FilenameAllocator();
  diag('bg.download', `入队 ${targets.length} 项（ids=${request.ids?.length ?? 0} inline=${request.url ? 1 : 0} tabId=${tabId ?? '-'}）`);

  queue.enqueue(
    targets.map((target) => ({
      id: target.itemId,
      label: target.url,
      run: async () => {
        const filename = allocator.next(target);
        try {
          await performDownload(target, filename, tabId);
        } catch (error) {
          // 第一次失败 → 换一份新签名再试一次（常见的失败原因就是签名过期）
          const fresh = await refreshTargetUrl(target, tabId);
          if (!fresh) throw error;
          await performDownload({ ...target, url: fresh }, allocator.next(target), tabId);
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
    /*
     * ⚠️ 2026-10-02 §36/§38：`/video-sharing`（单条视频分享页）**也是会话页** ——
     * 它的会话 ID 在查询参数里（`share_<share_id>`，见 `convIdFromUrl`），
     * 旧实现只认 chat / thread 两条路径，导致分享页被当成「非豆包页」
     * （`stale` 判定失效 + 槽的离开判定误伤）。
     */
    return CHAT_PATH_PATTERN.test(pathname) || THREAD_PATH_PATTERN.test(pathname) || VIDEO_SHARE_PATH_PATTERN.test(pathname);
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
  return isDoubaoUrl(url) && Boolean(convIdFromUrl(url));
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
        // ⚠️ §38 起必须带上 tabId —— 否则会去动「别人的槽」（多标签页实机 bug）
        await applyScope({ convId: page.convId, title: page.title, kind: page.kind }, tabId);
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

  // ⚠️ 必须等会话作用域收敛之后再取库，否则本次的 stats 会按「裁剪前」的旧槽算
  const slot = slotOf(await getSlots(), tabId);
  const stats = statsOf(slot, page.convId || undefined);
  diag(
    'bg.state',
    `tabId=${tabId ?? '-'}${followedRecent ? '(跟随最近豆包页)' : ''} page=${page.kind}/${page.convId || '-'} title=${
      page.title || '-'
    } slot=${Object.keys(slot).length} stats=${stats.total}`,
  );

  return {
    config,
    page,
    stale,
    stats,
    libraryTotal: Object.keys(slot).length,
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
      const tabId = sender.tab?.id;
      if (typeof tabId === 'number') void rememberContentTab(tabId);
      if (Array.isArray(drafts) && drafts.length) {
        // §38：草稿必须带回来源标签页 —— 它决定进哪个槽
        queueDrafts(drafts, typeof tabId === 'number' ? tabId : null);
        diag(
          'bg.media',
          `tab #${tabId ?? '-'} 收到草稿 ${drafts.length} 条：${drafts.map((d) => `${d.kind}:${d.state}`).join(',')}`,
        );
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

    // 当前激活会话变了（第四轮；§38 起**只作用于本标签页的槽**）→ 裁剪该槽 + 刷新会话名
    case MSG.ConvScope: {
      const scope = env.payload as ConvScope | undefined;
      const tabId = sender.tab?.id;
      if (typeof tabId === 'number') void rememberContentTab(tabId);
      if (scope && typeof scope.convId === 'string') {
        void applyScope(scope, typeof tabId === 'number' ? tabId : null).then(() => sendResponse({ ok: true }));
        return true;
      }
      sendResponse({ ok: false });
      return undefined;
    }

    // 原片已超期（2026-09-27 Finding C）：页面翻遍创作树未见该 vid → 确定性失败，不再永挂「解析中」
    case MSG.LibraryExpire: {
      const payload = env.payload as { convId?: string; fingerprint?: string; vid?: string } | undefined;
      const tabId = sender.tab?.id;
      if (payload?.convId && payload.fingerprint && typeof tabId === 'number') {
        void (async () => {
          const slot = slotOf(await getSlots(), tabId);
          const next = markExpired(slot, payload.convId as string, payload.fingerprint as string);
          if (next !== slot) {
            await writeSlot(tabId, next);
            diag(
              'bg.expire',
              `tab #${tabId} convId=${payload.convId} fingerprint=${payload.fingerprint} → 原片已超期（创作树二次确认仍未见）`,
              { level: 'warn' },
            );
            /*
             * 超期条目拿不到创作树节点 `size`（作品已被站点清除），但它的 `primary` 仍是
             * 站点可下载的那个文件 —— 实测一次字节数，卡片就有「文件大小」了
             * （口径：显示的是**能下载到的那个文件**的体积，用户已拍板，2026-09-28）。
             */
            void backfillSizes(tabId, [itemId(payload.convId as string, payload.fingerprint as string)]);
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
      const request = (env.payload ?? {}) as LibraryRequest;
      void (async () => {
        /*
         * 打开资源库时主动对齐一次会话作用域：保证返回的库就是「当前标签页那个槽」。
         * §38：取库范围 = **报告目标标签页的槽** —— 弹窗不传 `follow`（活动标签页就是用户
         * 在看的那页），诊断页传 `follow: true`（它自己是 active tab，得跟随豆包页）。
         * `syncScopeFromTab` 也只动这个槽。
         */
        const { tabId } = await resolveReportTarget(request.tabId, request.follow === true);
        await syncScopeFromTab(tabId);
        const [slots, config] = await Promise.all([getSlots(), readConfig()]);
        const scope = tabScopeOf(tabId) ?? (await recallScope());
        sendResponse({ library: slotOf(slots, tabId), config, scope });
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

    /*
     * 弹窗请求「补角条目的卡片封面」（2026-10-03 第三十一轮）。
     *
     * 封面必须**在页面上下文里合成**（两档同源底图 → 覆盖 → 缩图；`<img>` 直接拿不到无水印的那张），
     * 所以这里是纯转发：按条目 id 找到**它所属的那个槽的标签页**，把 `primary`（底板）+ `meta.patch`
     * （来源档配方）交给页面，拿回一张小图 data URL。**不写库** —— 封面不是资源的描述，只给这次弹窗用。
     * 失败（页面没开 / 取图失败 / 同源校验没过）一律如实回报，弹窗保持站点缩略图。
     */
    case MSG.PatchCover: {
      const itemId = (env.payload as { itemId?: string } | undefined)?.itemId;
      if (!itemId) {
        sendResponse({ ok: false, error: '缺少条目 id' });
        return undefined;
      }
      void (async () => {
        const found = await findItemEverywhere(itemId);
        if (!found) {
          sendResponse({ ok: false, error: '资源库里没有这条（可能已随会话切换清掉）' });
          return;
        }
        const patch = found.item.meta.patch;
        if (!patch) {
          sendResponse({ ok: false, error: '这条没有补角配方' });
          return;
        }
        const res = await trySendToTab<{ ok?: boolean; cover?: string; error?: string }>(
          found.tabId,
          MSG.PatchCover,
          { url: found.item.primary, patch, maxPx: LIMITS.PATCH_COVER_MAX_PX },
          30_000,
        );
        if (res?.ok && res.cover) {
          sendResponse({ ok: true, cover: res.cover });
          return;
        }
        diag('bg.cover', `补角封面未取到（${res?.error ?? '页面脚本未就绪'}）item=${itemId}`, { level: 'warn' });
        sendResponse({ ok: false, error: res?.error ?? '页面脚本未就绪' });
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

/* --------------------------------------------------------------------------- */
/* 标签页槽的生命周期（2026-10-02 §38）                                            */
/*                                                                             */
/* 多槽之后，「什么时候删」必须明确，否则要么互相删（旧 bug）、要么永久堆积：        */
/*   · **关标签页** → 删该槽；                                                    */
/*   · **该标签页离开会话**（导航到非会话页：豆包首页 / 别的站点）→ 清该槽；           */
/*   · **浏览器重启 / 扩展重载**后 tabId 会重新分配 → 启动时对账，删掉不存在的槽。     */
/* ⚠️ 页面侧自报 `kind=none`（首页）走的是 `applyScope` 的离开分支，两条路都覆盖。       */
/* --------------------------------------------------------------------------- */

/** 该会话是否还被别的活标签页占着（同一会话开两个标签页时，别把另一个的槽删了） */
async function convStillOpen(convId: string, exceptTabId: number): Promise<boolean> {
  for (const [tabId, scope] of (await getTabScopes()).entries()) {
    if (tabId !== exceptTabId && scope.convId === convId) return true;
  }
  return false;
}

/** 释放一个标签页的槽（关标签页 / 离开会话）；会话仍被别的标签页占着时只忘掉映射，不删槽 */
async function releaseTab(tabId: number, reason: string): Promise<void> {
  const scope = (await getTabScopes()).get(tabId);
  await forgetTabScope(tabId);
  if (!scope?.convId) return;
  if (await convStillOpen(scope.convId, tabId)) return;
  await dropSlot(tabId, reason);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void releaseTab(tabId, '标签页已关闭');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 只在**地址真的换了**时判断（SPA 的同文档导航也会给 changeInfo.url）
  if (typeof changeInfo.url !== 'string') return;
  if (convIdFromUrl(changeInfo.url)) return; // 仍是会话页（含 /video-sharing）→ 交给页面自报
  void releaseTab(tabId, `导航离开会话（${changeInfo.url.slice(0, 80)}）`);
});

/**
 * 启动对账：删掉「已不存在的标签页」的槽。
 *
 * SW 被回收再唤醒 / 浏览器重启后，`tabId` 可能是上一轮的编号（浏览器重启后一定重排），
 * 留着只会让存储缓慢膨胀、并可能被新标签页复用而串味。
 */
async function reconcileSlots(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    const alive = new Set<number>();
    for (const tab of tabs) if (typeof tab.id === 'number') alive.add(tab.id);

    const slots = await getSlots();
    const stale = Object.keys(slots).filter((key) => !alive.has(Number(key)));
    if (stale.length) {
      const next = { ...slots };
      for (const key of stale) delete next[key];
      await persistSlots(next);
      diag('bg.slot', `启动对账：删除 ${stale.length} 个已不存在的标签页槽（${stale.join(',')}）`);
    }

    const scopes = await getTabScopes();
    const scopesStale = [...scopes.keys()].filter((tabId) => !alive.has(tabId));
    if (scopesStale.length) {
      for (const tabId of scopesStale) scopes.delete(tabId);
      await persistTabScopes();
    }
  } catch {
    /* 对账是清理性工作，失败不影响业务 */
  }
}

onStateChanged((change) => {
  // background 是唯一写入方，库里出现外部变更只可能是别的上下文写入 → 同步缓存
  if (change.library) slotsCache = change.library;
});

// SW 唤醒后从磁盘恢复资源库缓存，并做一次标签页对账（**延后 2s**：浏览器重启时标签页还在恢复，
// 太早查会漏掉尚未恢复的标签页而误删它们的槽 —— 反正那些页面会重新加载并重新解析，代价为零）
void readState().then((state) => {
  slotsCache = state.library;
  setTimeout(() => void reconcileSlots(), 2_000);
});
