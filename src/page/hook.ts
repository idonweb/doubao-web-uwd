/**
 * `page/hook.ts` —— MAIN world 脚本（`run_at: document_start`）。
 *
 * 职责（对应实施方案 §6.1）：
 *   1. **只读** fetch / XHR hook：绝不修改任何请求（上游会改写 `duration`，本项目已删除该能力）
 *   2. 页面类型判定：对话页 / 分享链接页 / 非豆包页，SPA 路由变化时重新判定
 *   3. 解析 SSE / chain-single / thread 内联脚本 → 产出 `MediaDraft[]` → postMessage 出去
 *   4. `vid` → 三步 API 换取高清无水印原片
 *
 * 明确删除（相对上游）：
 *   - 请求体 `duration` 改写、`processStreamBody`
 *   - 15s 菜单项注入、去水印开关按钮注入
 *   - `startWatermarkReplacer` 的 500ms 轮询、`startVidScan` 的 3~10s 轮询、`startDurationOptionInjector`
 */

import { DEFAULT_CONFIG, LIMITS, MSG } from '../core/constants';
import { makeRecord, sample } from '../core/diagnostics';
import { envelope, onWindowMessage, postToWindow } from '../core/messaging';
import { normalizeConfig } from '../core/storage';
import { RANK, toDrafts, classifyResponseConv, collectConversationIds, type DraftContext } from '../core/extract';
import { extractChainRaw } from '../core/extract/chain';
import { extractSseRaw } from '../core/extract/sse';
import { extractThreadRaw, describeTitleFields, findShareInfo, parseFnArgs, shareTitle, FN_ARGS_SELECTOR } from '../core/extract/thread';
import { dedupeVariants, isUsableCover } from '../core/media-url';
import { qualityFromDims } from '../core/quality';
import {
  CHAIN_ENDPOINT,
  CHAIN_MAIN_URL_RE,
  CHAT_PATH_PATTERN,
  CONV_ID_PATTERN,
  DOM_CONTRACT,
  isLocalConvId,
  SSE_ENDPOINT,
  THREAD_PATH_PATTERN,
} from '../core/site-contract';
import { createVidResolver, formatVidStep, type VidStepEvent } from '../core/vid-resolver';
import { cleanDocTitle, isStaleTitle, normalizeTitleSnapshot, pickFreshTitle } from '../core/title';
import type { Config, MediaDraft, PageInfo, PageKind, RawMedia } from '../core/types';

declare global {
  interface Window {
    __uwd_hook_installed__?: boolean;
  }
}

(function main(): void {
  if (window.__uwd_hook_installed__) return;
  window.__uwd_hook_installed__ = true;

  /** 页面上可能被别的脚本重复注入，这里只装一次 */
  let config: Config = { ...DEFAULT_CONFIG };
  let pageKind: PageKind = 'none';
  let convId = '';
  /** **只保存「真实标题」**；拿不到时留空，界面侧用 `豆包对话 <id8>` 兜底显示 */
  let convTitle = '';
  let titleResolved = false;
  /**
   * 路由切换瞬间从页面读到的标题候选 —— 它们属于**上一个会话**，一律不可采用。
   * 这是「快照闸门」，见 `core/title.ts` 的说明。
   */
  let staleTitles: string[] = [];
  let titleTimers: number[] = [];

  /** vid → 最近一次解析的步骤事实（按 vid 收，避免并发解析互相覆盖） */
  const vidSteps = new Map<string, VidStepEvent[]>();

  const vidResolver = createVidResolver({
    concurrency: 2,
    /*
     * 三步 API 的每一步都写进诊断。这是「卡片一直显示解析中」唯一可归因的来源 ——
     * 插件自己发的 `/samantha/aispace/*` 不在 hook 的捕获白名单里（`isInteresting` 只认
     * `/chat/completion` 与 `/im/chain/single`），所以离开这个回调就再也看不到失败原因了。
     */
    onStep: (event) => {
      const list = vidSteps.get(event.vid);
      if (list) list.push(event);
      else vidSteps.set(event.vid, [event]);
      diag('vid.step', formatVidStep(event), { level: event.ok ? 'info' : 'warn' });
    },
  });

  /* ------------------------------------------------------------------------- */
  /* 诊断（真机联调用；与业务逻辑完全解耦）                                        */
  /* ------------------------------------------------------------------------- */

  function diag(event: string, detail?: string, options: { level?: 'info' | 'warn' | 'error'; text?: string } = {}): void {
    try {
      postToWindow(envelope('page', MSG.PageDiag, makeRecord('page', event, detail, options)));
    } catch {
      /* 诊断永远不能影响主流程 */
    }
  }

  /**
   * 跑一次 vid 解析，并把「哪一步失败、什么原因」收成一行诊断。
   * 命中缓存不会产生步骤事件，那行会如实写成「未产生步骤事件」而不是编一个原因。
   */
  async function resolveVidWithDiag(vid: string, force = false): Promise<string | null> {
    vidSteps.delete(vid);
    const url = await vidResolver.resolve(vid, force ? { force: true } : undefined);
    const steps = vidSteps.get(vid) ?? [];
    vidSteps.delete(vid);
    const failed = steps.find((step) => !step.ok);
    const suffix = force ? '（重解析）' : '';
    diag(
      'vid.resolve',
      url
        ? `vid=${vid} → ok${suffix}（${steps.length} 步）`
        : `vid=${vid} → null${suffix}：${failed ? formatVidStep(failed) : '未产生步骤事件'}`,
      { level: url ? 'info' : 'warn' },
    );
    return url;
  }

  /* ------------------------------------------------------------------------- */
  /* 页面类型判定                                                               */
  /* ------------------------------------------------------------------------- */

  function detectKind(pathname: string = location.pathname): PageKind {
    if (CHAT_PATH_PATTERN.test(pathname)) return 'chat';
    if (THREAD_PATH_PATTERN.test(pathname)) return 'thread';
    return 'none';
  }

  function detectConvId(href: string = location.href): string {
    const match = href.match(CONV_ID_PATTERN);
    return match ? match[1] : '';
  }

  function pickText(candidates: string[]): string {
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    return '';
  }

  /**
   * 页面里可作会话名的**候选**，按可信度排序。
   *
   * ⚠️ 只认这两个来源（第四轮 v2/v3）：
   *   - 「会话标题选择器」——最佳努力，实测当前站点**全部未命中**；
   *   - `document.title` —— **实际的标题来源**（对话页 `会话名 - 豆包`，分享页同形态）。
   * 曾经用过的「首条消息文本」兜底已**彻底移除**：实测它会把**上一段对话的消息**当成
   * 新会话的标题（消息容器在切换瞬间还是旧内容）。
   * 拿不到就交给界面显示兜底文案 —— 与 J3「宁缺勿假」同一条原则。
   */
  function titleCandidates(): string[] {
    const out: string[] = [];
    const heading = pickText(DOM_CONTRACT.conversationTitle);
    if (heading) out.push(heading);
    const fromDoc = cleanDocTitle(document.title);
    if (fromDoc) out.push(fromDoc);
    return out;
  }

  /**
   * 解析会话标题：候选必须**不在路由切换前的快照里**才被采用。
   * 拿不到就返回空串（**绝不返回兜底值**，兜底由界面侧 `displayConvTitle()` 负责）。
   */
  function refreshTitle(): void {
    if (titleResolved || pageKind === 'none') return;
    const title = pickFreshTitle(titleCandidates(), staleTitles);
    if (!title) return;
    convTitle = title;
    titleResolved = true;
    cancelTitleTimers();
    diag('page.title', `convId=${convId || '-'} title=${title}（已拒收过渡期候选 ${staleTitles.length} 个）`);
    // 标题确定后广播一次 → background 会把该会话下已有条目的标题一并刷新
    emitScope();
  }

  function cancelTitleTimers(): void {
    titleTimers.forEach((timer) => clearTimeout(timer));
    titleTimers = [];
  }

  /**
   * 有界的标题重试（低频、可停止，符合守则 4）。
   * 主要靠 `watchTitleElement()` 的 `<title>` 变更事件触发，这里只是兜底。
   */
  function scheduleTitleResolve(): void {
    cancelTitleTimers();
    if (pageKind === 'none') return;
    refreshTitle();
    if (titleResolved) return;
    for (const delay of [300, 1200, 3000]) {
      titleTimers.push(
        window.setTimeout(() => {
          if (titleResolved) return;
          refreshTitle();
          if (titleResolved) cancelTitleTimers();
        }, delay),
      );
    }
  }

  /**
   * 监听 `<title>` 文本变化：站点一改标题就**立刻**重新判定，不必等固定重试。
   * 事件驱动，无轮询（守则 4）。
   */
  function watchTitleElement(): void {
    const observer = new MutationObserver(() => {
      if (!titleResolved) refreshTitle();
    });
    observer.observe(document.head ?? document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function draftContext(): DraftContext {
    return {
      convId: convId || 'unknown',
      convKind: pageKind === 'thread' ? 'thread' : 'chat',
      convTitle,
    };
  }

  /**
   * 把「当前激活会话」告知 background —— 它是资源库会话作用域的唯一依据。
   *
   * ⚠️ 2026-09-27 第八轮：`kind=none`（豆包域内的非会话页，如首页 `/chat`）**也要上报** ——
   * 旧的 early-return 让 bg 永远不知道「已离开会话」，`retainConv` 不执行，
   * 上个会话的条目残留进库，被弹窗在「未检测到豆包对话或分享页面」状态下画出来
   * （实测：首页弹窗显示上一会话的视频，`docs/03` §15）。
   * bg 侧对 none 的处置（清库 + 作用域置空）见 `bg::applyScope` 的 `isLeaveScope` 分支。
   */
  function emitScope(): void {
    postToWindow(envelope('page', MSG.ConvScope, { convId, title: convTitle, kind: pageKind }));
  }

  function buildPageInfo(): PageInfo {
    return {
      kind: pageKind,
      convId,
      // 这里给的是**真实标题**（可能为空）。兜底文案由界面层自己拼，
      // 避免兜底值经 background 落进资源库条目里再也升不上去。
      title: convTitle,
      url: location.href,
      injected: true,
    };
  }

  /* ------------------------------------------------------------------------- */
  /* 产出草稿                                                                   */
  /* ------------------------------------------------------------------------- */

  function emitDrafts(drafts: MediaDraft[]): void {
    if (!drafts.length || pageKind === 'none') return;
    const filtered = config.skipThumbOnly ? drafts.filter((draft) => draft.state !== 'thumb') : drafts;
    diag(
      'draft.emit',
      `in=${drafts.length} out=${filtered.length} skipThumbOnly=${config.skipThumbOnly} kinds=${filtered
        .map((draft) => `${draft.kind}:${draft.state}`)
        .join(',')}`,
      { level: filtered.length ? 'info' : 'warn' },
    );
    if (!filtered.length) return;

    postToWindow(envelope('page', MSG.MediaCaptured, filtered));

    for (const draft of filtered) {
      if (draft.vid) void enrichWithResolvedVid(draft);
    }
  }

  /** 用 vid 三步 API 的结果补一条高清原片变体，再次上报（同指纹 → 走 upsert 合并） */
  async function enrichWithResolvedVid(draft: MediaDraft): Promise<void> {
    const vid = draft.vid;
    if (!vid) return;
    const url = await resolveVidWithDiag(vid);
    if (!url) return;
    // 解析是异步的：回来时用户可能已经切走 —— 异会话的增强结果一律丢弃
    if (draft.convId !== (convId || 'unknown')) return;
    /*
     * 第 3 步顺带带回的元数据（width / height / size）有就写进 meta：
     * chain 里 video.width 常是 384×216 的**预览规格**，download_infos 的才是原片规格 ——
     * 覆盖宽高的同时把「预览」标记撤掉（metaMerge 会把 `false` 写进库里），
     * upsert 的 metaMerge 让「更完整的后到值」覆盖先到的。
     *
     * 清晰度标签也在这里派生（`docs/03` §12.7）：它必须描述**原片这一个文件**，
     * 所以只能来自 download_infos 的真实宽高；尺寸缺失或不是已知档位就干脆不给标签，
     * 界面只显示「无水印原片」。
     */
    const resolvedMeta = vidResolver.metaOf(vid);
    const meta = { ...draft.meta };
    if (resolvedMeta?.width !== undefined) {
      meta.width = resolvedMeta.width;
      meta.height = resolvedMeta.height;
      meta.dimsPreview = false;
      const quality = qualityFromDims(resolvedMeta.width, resolvedMeta.height);
      if (quality) meta.label = quality;
    }
    if (resolvedMeta?.size !== undefined) meta.size = resolvedMeta.size;
    const enriched: MediaDraft = {
      ...draft,
      meta,
      state: 'raw',
      variants: dedupeVariants([
        { url, label: '无水印原片（高清）', rank: RANK.resolved, isRaw: true },
        ...draft.variants,
      ]),
    };
    postToWindow(envelope('page', MSG.MediaCaptured, [enriched]));
  }

  /**
   * 响应是否属于「当前激活会话」（**仅在没有响应自报会话可用时**作为兜底判定）。
   *
   * 判定依据是**请求发出那一刻**的 convId（而不是响应到达时），
   * 因为 SSE / chain 的响应可能晚于「用户切走」才到；那时 `draftContext()` 会盖上
   * 新会话的 convId，同一条素材于是在两个会话下各存一份 —— 实机的「重复记录」。
   *
   * ⚠️ 2026-09-27 第七轮补充：新建会话的请求发出时 convId 还是 `local_*` **占位 ID**，
   * 响应到达时页面已被站点 replaceState 成真实 ID —— 两者永不相等。
   * 占位值一律视为「属于当前会话」放行，否则新会话的生成响应会被误杀（实测 Bug A）。
   */
  function isCurrentConvResponse(requestConvId: string): boolean {
    if (!requestConvId || isLocalConvId(requestConvId)) return true;
    return requestConvId === (convId || 'unknown');
  }

  /** 拼一条「丢弃异会话响应」的诊断（把判定依据写清楚，便于以后翻记录） */
  function dropForeignResponse(
    event: 'parse.sse' | 'parse.chain',
    requestConvId: string,
    verdict: 'foreign' | 'unknown',
    text: string,
  ): void {
    const selfReported = verdict === 'foreign' ? collectConversationIds(text).join('|') : '未自报';
    diag(
      event,
      `丢弃异会话响应（请求 convId=${requestConvId} 当前=${convId || '-'} 响应自报=${selfReported}）len=${text.length}`,
      { level: 'warn' },
    );
  }

  function handleSse(text: string, requestConvId: string): void {
    /*
     * 响应归属两级判定（2026-09-27 第七轮，修 Bug A / Bug B）：
     * ① 响应自报会话优先：SSE 报文自带 conversation_id（SSE_ACK / FULL_MSG_NOTIFY）。
     *    自报会话不含当前会话 → 这是推给别的会话的消息，整体丢弃；
     * ② 自报不了（结构变化）才退回「请求时刻快照」判定（占位 local_* 豁免，见上）。
     */
    const verdict = classifyResponseConv(text, convId || 'unknown');
    if (verdict === 'foreign' || (verdict === 'unknown' && !isCurrentConvResponse(requestConvId))) {
      dropForeignResponse('parse.sse', requestConvId, verdict, text);
      return;
    }
    const hasCreationBlock = text.includes('creation_block');
    const raws = extractSseRaw(text);
    diag(
      'parse.sse',
      `len=${text.length} hasCreationBlock=${hasCreationBlock} raws=${raws.length}`,
      raws.length ? {} : { level: 'warn', text: sample(text, 'creation_block') },
    );
    if (!raws.length) return;
    emitDrafts(toDrafts(raws, draftContext()));
  }

  function handleChain(text: string, requestConvId: string): void {
    /*
     * 与 handleSse 同一套两级判定（2026-09-27 第七轮）。
     * 实测 Bug B：chain/single 是用户级 IM 同步通道，视频生成完成的消息会从**别的会话**
     * 推到当前连接上 —— 只看「请求发给谁」时它被盖上当前会话的章入库，
     * 造成「新视频跨对话出现在资源库」。现在按响应自报的 conversation_id 判定，异会话整体丢弃。
     */
    const verdict = classifyResponseConv(text, convId || 'unknown');
    if (verdict === 'foreign' || (verdict === 'unknown' && !isCurrentConvResponse(requestConvId))) {
      dropForeignResponse('parse.chain', requestConvId, verdict, text);
      return;
    }
    const hasMainUrl = new RegExp(CHAIN_MAIN_URL_RE.source, CHAIN_MAIN_URL_RE.flags).test(text);
    const raws = extractChainRaw(text);
    const vidHit = raws.filter((raw) => raw.vid).length;
    const fallbackOnly = raws.filter((raw) => !raw.vid && raw.downloadUrl).length;
    diag(
      'parse.chain',
      `len=${text.length} hasMainUrl=${hasMainUrl} raws=${raws.length} vidHit=${vidHit} fallbackOnly=${fallbackOnly}`,
      raws.length ? {} : { level: 'warn', text: sample(text, 'main_url') },
    );
    if (!raws.length) return;
    emitDrafts(toDrafts(raws, draftContext()));
  }

  /* ------------------------------------------------------------------------- */
  /* fetch hook（只读）                                                         */
  /* ------------------------------------------------------------------------- */

  function isInteresting(url: string): boolean {
    return url.includes(SSE_ENDPOINT) || url.includes(CHAIN_ENDPOINT);
  }

  function resolveRequestUrl(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input === 'object' && 'url' in input) {
      const url = (input as { url?: unknown }).url;
      if (typeof url === 'string') return url;
    }
    return '';
  }

  function readTextWithTimeout(response: Response, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      response
        .text()
        .then((text) => {
          clearTimeout(timer);
          resolve(text);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(null);
        });
    });
  }

  function inspectResponse(url: string, response: Response, requestConvId: string): void {
    try {
      if (!response || !response.body || response.status !== 200) {
        diag('net.response', `${url.slice(0, 120)} status=${response?.status} hasBody=${Boolean(response?.body)}`, {
          level: 'warn',
        });
        return;
      }
      const contentType = response.headers?.get('content-type') ?? '?';
      const clone = response.clone();
      const isChain = url.includes(CHAIN_ENDPOINT);
      const timeout = isChain ? 30_000 : LIMITS.SSE_READ_TIMEOUT_MS;
      void readTextWithTimeout(clone, timeout).then((text) => {
        if (text === null) {
          diag('net.response', `${url.slice(0, 120)} 读取超时或失败（timeout=${timeout}ms）`, { level: 'error' });
          return;
        }
        diag('net.response', `${url.slice(0, 120)} status=200 ctype=${contentType} len=${text.length}`);
        if (isChain) handleChain(text, requestConvId);
        else handleSse(text, requestConvId);
      });
    } catch {
      /* clone 失败（body 已被消费）时静默放过，绝不影响页面本身 */
    }
  }

  function installFetchHook(): void {
    const realFetch = window.fetch;
    if (typeof realFetch !== 'function') return;

    const hooked = function (this: unknown, ...args: unknown[]): Promise<Response> {
      const requestUrl = resolveRequestUrl(args[0]);
      // 在「请求发出」这一刻记住会话 ID：响应回来时用户可能已经切走了
      const requestConvId = convId || 'unknown';
      const result = (realFetch as (...a: unknown[]) => Promise<Response>).apply(this, args);
      if (!requestUrl || !isInteresting(requestUrl)) return result;
      diag('net.fetch', `捕获 ${requestUrl.split('?')[0]}`);
      return result.then((response) => {
        inspectResponse(requestUrl, response, requestConvId);
        return response;
      });
    };
    // 保留 toString 行为，降低被站点检测的概率
    hooked.toString = () => realFetch.toString();

    try {
      Object.defineProperty(window, 'fetch', {
        value: hooked,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      diag('hook.fetch', '已安装');
    } catch (error) {
      window.fetch = hooked as unknown as typeof window.fetch;
      diag('hook.fetch', `Object.defineProperty 失败，降级为直接赋值：${String(error)}`, { level: 'warn' });
    }
  }

  /* ------------------------------------------------------------------------- */
  /* XHR hook（只读）                                                           */
  /* ------------------------------------------------------------------------- */

  function installXhrHook(): void {
    const proto = XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;

    proto.open = function (this: XMLHttpRequest & { __uwdUrl?: string }, method: string, url: string | URL, ...rest: unknown[]) {
      this.__uwdUrl = typeof url === 'string' ? url : String(url ?? '');
      return (originalOpen as (...a: unknown[]) => void).apply(this, [method, url, ...rest]);
    } as typeof proto.open;

    proto.send = function (
      this: XMLHttpRequest & { __uwdUrl?: string; __uwdHooked?: boolean; __uwdConvId?: string },
      ...args: unknown[]
    ) {
      const url = this.__uwdUrl ?? '';
      if (url && isInteresting(url) && !this.__uwdHooked) {
        this.__uwdHooked = true;
        // 同 fetch：记下请求发出时的会话，响应到达时据此判定是否还属于当前会话
        this.__uwdConvId = convId || 'unknown';
        const requestConvId = this.__uwdConvId;
        diag('net.xhr', `捕获 ${url.split('?')[0]}`);
        this.addEventListener('load', () => {
          try {
            if (this.readyState !== 4) return;
            if (this.status !== 200) {
              diag('net.xhr', `${url.split('?')[0]} status=${this.status}`, { level: 'warn' });
              return;
            }
            if (this.responseType !== '' && this.responseType !== 'text') {
              diag('net.xhr', `${url.split('?')[0]} responseType=${this.responseType}（非文本，未读取）`, { level: 'warn' });
              return;
            }
            const text = this.responseText;
            diag('net.xhr', `${url.split('?')[0]} len=${text?.length ?? 0}`);
            if (!text) return;
            if (url.includes(CHAIN_ENDPOINT)) handleChain(text, requestConvId);
            else handleSse(text, requestConvId);
          } catch {
            /* 忽略 */
          }
        });
      }
      return (originalSend as (...a: unknown[]) => void).apply(this, args);
    } as typeof proto.send;

    diag('hook.xhr', '已安装');
  }

  /* ------------------------------------------------------------------------- */
  /* thread 分享页解析                                                          */
  /* ------------------------------------------------------------------------- */

  let threadRetryTimers: number[] = [];

  function parseThreadOnce(): boolean {
    if (pageKind !== 'thread') return false;
    const raws: RawMedia[] = [];
    const scripts = document.querySelectorAll(FN_ARGS_SELECTOR);
    let firstSample = '';
    let info: Record<string, unknown> | null = null;

    for (const script of scripts) {
      const argsText = script.getAttribute('data-fn-args') ?? '';
      if (!firstSample) firstSample = argsText;
      const found = findShareInfo(parseFnArgs(argsText));
      if (!found) continue;
      if (!info) info = found;

      /*
       * 分享页的标题**以分享信息为准**，并且允许覆盖此前锚定的标题。
       *
       * 为什么必须能覆盖：`syncContext()` 会先跑 `refreshTitle()`，而分享页首次加载时
       * `document.title` 还是空的，稍后会变成站点的**通用标题**（实测
       * `豆包 - 字节跳动旗下 AI 智能助手`）。若这里因为 `titleResolved` 而放弃，
       * 分享页就永远挂着那个通用名（实测 `docs/03` §9.9）。
       */
      const title = shareTitle(found, '');
      if (title && !isStaleTitle(title, staleTitles) && convTitle !== title) {
        convTitle = title;
        titleResolved = true;
        cancelTitleTimers();
        diag('page.title', `kind=thread title=${title}（来自分享信息，覆盖此前的判定）`);
        emitScope();
      }
      raws.push(...extractThreadRaw(found));
    }

    diag(
      'parse.thread',
      `scripts=${scripts.length} raws=${raws.length} title=${convTitle || '-'} titleResolved=${titleResolved}`,
      raws.length ? {} : { level: 'warn', text: firstSample },
    );

    // 标题没取到时把结构里的候选字段路径打出来，便于回填 SHARE_TITLE_PATHS（docs/03 §9.8）
    if (!titleResolved && info) {
      const lines = describeTitleFields(info);
      diag('parse.thread', `未取到分享标题；结构里形如 title/name 的字段共 ${lines.length} 条`, {
        level: 'warn',
        text: lines.length ? lines.join('\n') : '（结构里没有任何 title/name 字段）',
      });
    }

    if (!raws.length) return false;
    emitDrafts(toDrafts(raws, draftContext()));
    return true;
  }

  function scheduleThreadParse(): void {
    threadRetryTimers.forEach((timer) => clearTimeout(timer));
    threadRetryTimers = [];
    if (parseThreadOnce()) return;
    // 有界的几次兜底重试：内联脚本可能晚于路由变化注入（低频、可停止）
    for (const delay of [300, 1200, 3000]) {
      threadRetryTimers.push(
        window.setTimeout(() => {
          if (parseThreadOnce()) {
            threadRetryTimers.forEach((timer) => clearTimeout(timer));
            threadRetryTimers = [];
          }
        }, delay),
      );
    }
  }

  /** 监听 data-fn-args 脚本插入（豆包可能在滚动时追加） */
  function watchThreadScripts(): void {
    const observer = new MutationObserver((records) => {
      if (pageKind !== 'thread') return;
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element && (node.matches(FN_ARGS_SELECTOR) || node.querySelector(FN_ARGS_SELECTOR))) {
            parseThreadOnce();
            return;
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------------- */
  /* 对话页：可见区域内取 vid（不做全页定时扫描）                                */
  /* ------------------------------------------------------------------------- */

  /**
   * 从 DOM 里捞视频 id。同时匹配两种字段名（`vid` / `video_id`）——
   * 实测 `chain/single` 用的是 `video_id`，页面内联数据里两种都出现过（`docs/03` §4）。
   */
  const VID_RE_RAW = /["'](?:video_id|vid)["']\s*:\s*["']([A-Za-z0-9_-]{6,})/;
  const VID_RE_ESCAPED = /(?:video_id|vid)\\*&quot;\\*\s*:\\*\s*\\*&quot;([A-Za-z0-9_-]{6,})/;

  function vidFromScope(element: Element): string | null {
    let node: Element | null = element;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      let html = '';
      try {
        html = node.innerHTML;
      } catch {
        continue;
      }
      if (!html || html.length > 300_000) continue;
      const direct = html.match(VID_RE_RAW);
      if (direct) return direct[1];
      const escaped = html.match(VID_RE_ESCAPED);
      if (escaped) return escaped[1];
      const decoded = html.replace(/&quot;/g, '"').replace(/&#34;/g, '"');
      const fromDecoded = decoded.match(VID_RE_RAW);
      if (fromDecoded) return fromDecoded[1];
    }
    return null;
  }

  /**
   * 视频封面：只在**图片 CDN 域**内取，且排除分享短链图。
   * [实测 `docs/03` P1-4] 首轮联调取到了 `aka.doubaocdn.com/s/<token>`（分享卡片短链图），
   * 既加载失败又污染指纹。
   */
  function coverNearVideo(video: Element): string | null {
    let node: Element | null = video.parentElement;
    for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
      const imgs = Array.from(node.querySelectorAll('img[src]'));
      for (const img of imgs) {
        const src = img.getAttribute('src') ?? '';
        if (isUsableCover(src)) return src;
      }
    }
    return null;
  }

  let vidScanScheduled = false;

  function queueVidScan(): void {
    if (vidScanScheduled) return;
    vidScanScheduled = true;
    window.setTimeout(() => {
      vidScanScheduled = false;
      scanVisibleVideos();
    }, 400);
  }

  /**
   * 页面内可见视频的采集（**不做全页定时扫描**：只在加载 / 路由变化 / 视频插入时触发一次）。
   *
   * ⚠️ [实测修正 `docs/03` P0-2 + J3] **只保留「从视频元素向上找 vid → 三步 API」这一条路径。**
   * 原来的第二条「拿不到 vid 就改写播放地址的 `lr` 猜地址」已被删除，原因：
   * 实测站点把水印**烧进了转码产物**（chain 响应里 `lr` / `logo_type` 都是
   * `video_gen_watermark_dyn`），改请求参数不会改变下载到的内容；
   * 而用户已拍板「拿不到 vid 的历史资源不入库（宁缺勿假）」，这条路径因此没有任何产出。
   */
  function scanVisibleVideos(): void {
    if (pageKind === 'none') return;
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return;

    const raws: RawMedia[] = [];
    let vidHit = 0;
    let noVid = 0;

    for (const node of videos) {
      const video = node as HTMLVideoElement;
      const src = video.currentSrc || video.src || '';
      const vid = vidFromScope(video);
      const signature = `${src}|${vid ?? ''}`;
      // 同一内容只处理一次（豆包重渲染时不会重复入库）
      if (video.dataset.uwdVidScanned === signature) continue;
      video.dataset.uwdVidScanned = signature;

      if (!vid) {
        // 没有 vid 就没有真原片 → 按 J3 不入库，这里连草稿都不生成
        noVid++;
        continue;
      }

      vidHit++;
      const cover = coverNearVideo(video);
      const raw: RawMedia = { kind: 'video', origin: 'dom', vid };
      if (cover) raw.thumb = cover;
      raws.push(raw);
    }

    diag(
      'dom.vidscan',
      `videos=${videos.length} vidHit=${vidHit} noVid=${noVid}（无 vid 不入库：J3）`,
      raws.length ? {} : { level: 'warn' },
    );

    if (raws.length) emitDrafts(toDrafts(raws, draftContext()));
  }

  function watchVideos(): void {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.tagName === 'VIDEO' || node.querySelector('video')) {
            queueVidScan();
            return;
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------------- */
  /* 路由与上下文同步                                                            */
  /* ------------------------------------------------------------------------- */

  /**
   * 清掉「已扫描」标记：会话切换后要把当前页面重新扫一遍（= 重启解析流程）。
   * 否则 `scanVisibleVideos()` 会认为「这条视频我已经处理过」而不再上报，
   * 而资源库刚刚被按会话裁剪清空 → 界面会一直是空的。
   */
  function resetVideoScanMarks(): void {
    document.querySelectorAll<HTMLVideoElement>('video').forEach((video) => {
      delete video.dataset.uwdVidScanned;
    });
  }

  function syncContext(): void {
    const kind = detectKind();
    const id = detectConvId();
    const changed = kind !== pageKind || id !== convId;

    if (changed) {
      // ① **快照闸门**：路由刚变，此刻页面上能读到的标题全都属于「上一个会话」
      //    （document.title 滞后、标题元素/消息容器还是旧内容）→ 全部记为不可采用。
      //    必须在清空 convTitle 之前、在任何重试之前取。
      staleTitles = normalizeTitleSnapshot(titleCandidates());
    }

    pageKind = kind;
    convId = id;

    if (changed) {
      titleResolved = false;
      convTitle = '';
      cancelTitleTimers();
      threadRetryTimers.forEach((timer) => clearTimeout(timer));
      threadRetryTimers = [];
      // ——— 每次激活会话都重启解析流程 ———
      // ① vid 解析结果整体作废：原片地址是**带时效的签名 URL**，
      //    切走再切回必须重新走三步 API 换一份新签名，否则下载必然 403
      vidResolver.clear();
      // ② 清掉 DOM 扫描标记，让当前页面里的视频重新参与采集
      resetVideoScanMarks();
    }

    if (pageKind !== 'none') refreshTitle();

    if (changed) {
      diag(
        'page.detect',
        `kind=${pageKind} convId=${convId || '-'} path=${location.pathname} title=${convTitle || '-'} 拒收候选=[${
          staleTitles.join(' | ') || '-'
        }]`,
      );
      // 告知 background：资源库按「当前会话」裁剪（切走即清空其它会话）
      emitScope();
      // 标题可能晚一拍才更新 → 有界重试（主触发是 watchTitleElement 的 <title> 变更事件）
      scheduleTitleResolve();
    }

    if (changed && pageKind === 'thread') scheduleThreadParse();
    if (changed && pageKind === 'chat') queueVidScan();
  }

  function watchRoute(): void {
    window.addEventListener('popstate', syncContext);
    window.addEventListener('hashchange', syncContext);

    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      history[method] = function patched(this: History, ...args: unknown[]) {
        const result = (original as (...a: unknown[]) => void).apply(this, args);
        queueMicrotask(syncContext);
        return result;
      } as typeof history[typeof method];
    }
  }

  /* ------------------------------------------------------------------------- */
  /* 与 ISOLATED world 通信                                                      */
  /* ------------------------------------------------------------------------- */

  onWindowMessage((env) => {
    if (env.src !== 'content') return;

    if (env.type === MSG.PageQuery) {
      refreshTitle();
      const payload = env.payload as { reqId?: string } | undefined;
      const info = { ...buildPageInfo(), reqId: payload?.reqId };
      diag('page.query', `kind=${info.kind} convId=${info.convId || '-'} title=${info.title || '-'}`);
      postToWindow(envelope('page', MSG.PageInfo, info));
      return;
    }

    if (env.type === MSG.PageConfig) {
      config = normalizeConfig(env.payload);
      return;
    }

    // background 发现下载失败（多半是签名地址过期）→ 要求重新解析该 vid
    if (env.type === MSG.ReresolveVid) {
      const payload = env.payload as { reqId?: string; vid?: string } | undefined;
      const vid = payload?.vid ?? '';
      const reqId = payload?.reqId ?? '';
      if (!vid) {
        postToWindow(envelope('page', MSG.VidResolved, { reqId, vid, url: null }));
        return;
      }
      // force：必须绕过缓存，否则拿回来的还是那份过期地址
      void resolveVidWithDiag(vid, true).then((url) => {
        postToWindow(envelope('page', MSG.VidResolved, { reqId, vid, url }));
      });
    }
  });

  /* ------------------------------------------------------------------------- */
  /* 启动                                                                        */
  /* ------------------------------------------------------------------------- */

  /** 启动时按当前页面类型补做一次解析（放在函数里，避免被 TS 的收窄误判） */
  function bootstrapPage(): void {
    if (pageKind === 'thread') scheduleThreadParse();
    queueVidScan();
  }

  installFetchHook();
  installXhrHook();
  watchRoute();
  syncContext();
  watchThreadScripts();
  watchVideos();
  watchTitleElement();

  diag(
    'hook.ready',
    `kind=${pageKind} convId=${convId || '-'} ua=${navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome'} online=${navigator.onLine}`,
  );

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      syncContext();
      bootstrapPage();
    });
    window.addEventListener('load', () => {
      syncContext();
      bootstrapPage();
    });
  } else {
    bootstrapPage();
  }
})();
