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
import { RANK, toDrafts, classifyResponseConv, collectConversationIds, readModelHints, readModelTimeline, type DraftContext, type ModelEvent } from '../core/extract';
import { extractChainRaw } from '../core/extract/chain';
import { extractSseRaw } from '../core/extract/sse';
import { extractThreadRaw, describeTitleFields, findShareInfo, parseFnArgs, shareTitle, FN_ARGS_SELECTOR } from '../core/extract/thread';
import { dedupeVariants, isUsableCover, mediaLookupKeys, mediaPathKey } from '../core/media-url';
import { modelBadgeOf, pickModelHintAt } from '../core/model-badge';
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
import { createVidResolver, formatVidStep, type VidResolveOutcome, type VidStepEvent } from '../core/vid-resolver';
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

  /**
   * vid → 「原片已超期」二次确认的复查定时器（2026-09-28 第十轮）。
   *
   * 首次「创作树里未见」不下结论，此后**每 10s 一轮重扫**（§27）：每轮由 resolver 用一棵新鲜的树
   * 判定；找到 → raw；资源还新（入库窗口内）→ 继续等；资源已不新且仍未见 → 超期。
   * 每个 vid 至多一个在飞定时器；切换会话 / 页面卸载时统一清掉（守则 4：低频、可停止）。
   */
  const recheckTimers = new Map<string, number>();
  /**
   * 重扫轮次上限：**30 轮 × 10s = 5min**（2026-09-29 第十四轮 §34，用户拍板：间隔固定 10s）。
   *
   * 之前的 8 轮是「逐轮退避到 60s」的形态（共覆盖 ~4.5min）—— 用户实测后要求**间隔固定在 10s、
   * 一直保持到 5 分钟**：粒度均匀，便于把「站点登记延迟」测准（轮次就是这个延迟的量尺）。
   * ⚠️ 成本可控的原因：整个等待期走的是**廉价路径**（吃 5min 索引 + 1 次 head 校验，
   * 见 `vidResolver` 的 `confirming` 判断），所以 30 轮 ≈ 30 个轻请求，而不是 30 次全量翻树。
   * ⚠️ 对**老资源**这条路径最多只用到 2 轮：第 2 轮（+20s）即到 20s 结论阈值 → 定案超期。
   * ⚠️ 30 轮用尽（5min）后不再有定时重扫，之后靠 chain 重放（正常约 60s 一次）与 F5 兜底。
   */
  const RECHECK_MAX_ROUNDS = 30;
  /**
   * 「最近一次在报文里读到的模型提示」（2026-09-29 第十四轮 §34）—— 诊断 + 兜底。
   *
   * 用于两处：① 写进 `draft.emit` 便于排查；② 给**没有报文文本**的路径兜底
   * （分享页 / DOM 扫描：拿不到时间线，只能退回这个记忆值）。
   * ⚠️ 实测模型信息**不在成片报文里**（在更早的输入消息 / 任务 ack 里），所以要记住；
   * 切会话时清空（避免把上一个会话的模型名安到新会话上）。
   * ⚠️ **逐条资源的药丸不走这里**，走时间线就近取用（`attachModelBadges`，§35.10）。
   */
  let modelHint: { label?: string; model?: string; tool?: string; at: number } | null = null;

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
   * `expired=true` 是**走完二次确认窗口后**的确定性结论：翻遍整棵创作树仍未见到该 vid
   * （原片已超期），重试无意义；`pendingConfirm=true` 是「首次未见、待复查」，不下结论
   * —— 也包括「资源刚生成、还等在站点入库窗口内」这一种（§33）。
   * `resourceAt` = 该资源自身的生成时刻（消息 `create_time`）：有了它，resolver 才能
   * 区分「刚生成还没入库」与「早已过期」（见 `LIMITS.VID_FRESH_RESOURCE_MS`）。
   */
  async function resolveVidWithDiag(
    vid: string,
    opts: { force?: boolean; confirmation?: boolean; resourceAt?: number } = {},
  ): Promise<VidResolveOutcome> {
    vidSteps.delete(vid);
    const outcome = await vidResolver.resolveDetailed(vid, {
      ...(opts.force ? { force: true } : {}),
      ...(opts.confirmation ? { confirmation: true } : {}),
      ...(opts.resourceAt === undefined ? {} : { resourceAt: opts.resourceAt }),
    });
    const steps = vidSteps.get(vid) ?? [];
    vidSteps.delete(vid);
    const failed = steps.find((step) => !step.ok);
    const suffix = opts.force ? '（重解析）' : '';
    let detail: string;
    if (outcome.url) {
      detail = `vid=${vid} → ok${suffix}（${steps.length} 步）`;
    } else if (outcome.expired) {
      detail = `vid=${vid} → 原片已超期${suffix}：${failed ? formatVidStep(failed) : '未产生步骤事件'}`;
    } else if (outcome.pendingConfirm) {
      detail = `vid=${vid} → 待复查${suffix}（树里未见、未到超期结论）：${failed ? formatVidStep(failed) : '未产生步骤事件'}`;
    } else {
      const cooldown = vidResolver.cooldownOf(vid);
      if (failed) {
        detail = `vid=${vid} → null${suffix}：${formatVidStep(failed)}${
          cooldown !== null ? `（进入失败退避 ${Math.round(cooldown / 1000)}s，期间不发请求）` : ''
        }`;
      } else if (cooldown !== null) {
        // 冷却期内的 chain 重放会走到这里短路 —— 不对站点发任何请求（§23.5）
        detail = `vid=${vid} → null${suffix}：网络失败退避中（剩 ${Math.round(cooldown / 1000)}s），本轮不发请求`;
      } else {
        detail = `vid=${vid} → null${suffix}：未产生步骤事件`;
      }
    }
    diag('vid.resolve', detail, { level: outcome.url ? 'info' : 'warn' });
    return outcome;
  }

  /* ------------------------------------------------------------------------- */
  /* 页面类型判定                                                               */
  /* ------------------------------------------------------------------------- */

  function detectKind(pathname: string = location.pathname, id: string = detectConvId()): PageKind {
    /*
     * ⚠️ 没有会话 ID 就不算会话页（2026-09-28 第十轮修正）。
     *
     * 豆包首页是 `/chat/`（带尾斜杠）——它会命中 `CHAT_PATH_PATTERN`，于是以前被判成
     * `kind=chat` + **空 convId**：弹窗的 `kind === 'none'` 闸门与页面徽标双双失效。
     * 现在改成与 `isLeaveScope` 同一条口径：先要求 convId（`local_*` 占位 ID 也算会话）。
     */
    if (!id) return 'none';
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
   * 给本批 raws **逐条**附上模型药丸文案（2026-09-30 §35.10 / §35.11）。
   *
   * 为什么必须逐条：**一个会话里可以换模型** —— 实测同一会话的两条视频分别出自
   * `Seedance 2.0`（21:38）与 `Seedance 2.0 Fast`（11:00），而模型提示**不在成片那批报文里**。
   * 旧实现把「最近一次读到的提示」整批粘上去 → 两条视频拿到同一个模型（用户实测报错）。
   *
   * 现在的做法：用本批报文里的**模型提示时间线**（每条提示都带自己所在消息的 `create_time`），
   * 按**本条资源自己的 `createdAt`**（同源的秒级时间）就近取用 —— 模型因此绑到了具体资源上。
   * 药丸文案的派生以**站点文案**为准（`label`），`tool` 不参与（见 `core/model-badge.ts`）。
   * `text` 缺失（thread / DOM 兜底路径没有报文）或时间线为空时，退回跨批记忆 `modelHint` 兜底。
   */
  function attachModelBadges(raws: RawMedia[], text?: string): void {
    const timeline: ModelEvent[] = text ? readModelTimeline(text) : [];
    for (const raw of raws) {
      if (raw.kind !== 'video') continue; // 模型提示来自视频生成任务，图片不适用
      const picked = timeline.length ? pickModelHintAt(timeline, raw.createdAt ?? null) : {};
      const badge = modelBadgeOf({
        label: picked.label ?? modelHint?.label,
        model: picked.model ?? modelHint?.model,
        tool: picked.tool ?? modelHint?.tool,
      })?.short;
      if (badge) raw.modelBadge = badge;
    }
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

  /**
   * 在页面里按「路径键」找这条资源对应的 DOM 媒体元素（**只读**）。
   *
   * 匹配依据（`docs/03` §17.10.1）：DOM 的媒体路径与报文候选地址**同源同路径**，只差结尾
   * 规格后缀与签名段 → 用 `mediaPathKey()` 取出的 `<hash>` 作匹配键。
   * ⚠️ 豆包消息列表是**懒渲染**的：没滚到的旧消息不在 DOM 里，找不到属正常（如实返回 null）。
   */
  function findMediaInPage(keys: Iterable<string>): HTMLElement | null {
    const wanted = new Set(keys);
    if (!wanted.size) return null;
    const nodes = document.querySelectorAll<HTMLElement>('img, video');
    for (const el of Array.from(nodes)) {
      const src =
        (el as HTMLImageElement).currentSrc || el.getAttribute('src') || el.getAttribute('poster') || '';
      const key = mediaPathKey(src);
      if (key && wanted.has(key)) return el;
    }
    return null;
  }

  /**
   * 取该元素所在媒体块里**站点自己的封面图**（实测 `img.cover-…`）。
   * 视频块里 `<video>` 与封面是**两个不同 hash 的资源**，所以只能靠「同一块」来找，不能靠键匹配。
   */
  function coverInSameBlock(el: HTMLElement): string | null {
    const block =
      el.closest('[class*="image-box-grid-item"], [class*="block-video"], [class*="video-hover-button-group"]') ??
      el.parentElement;
    const cover = block?.querySelector<HTMLImageElement>('img[class*="cover"]');
    const src = cover?.src || el.getAttribute('poster') || '';
    if (src) return src;
    return el.tagName === 'IMG' ? ((el as HTMLImageElement).currentSrc || el.getAttribute('src')) : null;
  }

  /**
   * 一次「像人一样」的点击（2026-09-28 第十轮）。
   *
   * ⚠️ 站点可能校验事件可信度（`isTrusted`）—— 那合成事件一律无效，这里只是**尽力**：
   * 成了就直接弹出豆包自己的预览，不成就让用户手点一下（目标已被滚到视口中央）。
   * 只 `dispatchEvent`，不覆盖站点处理器（守则 2）。
   */
  function humanClick(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const common = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    const fire = (type: string, extra: Record<string, unknown> = {}, Ctor: typeof MouseEvent = MouseEvent) => {
      try {
        el.dispatchEvent(new Ctor(type, { ...common, ...extra }));
      } catch {
        /* 某些构造器不接受某些字段，忽略 */
      }
    };
    const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    fire('pointerover', { ...pointer, buttons: 0 }, PointerEvent as unknown as typeof MouseEvent);
    fire('mouseover');
    fire('pointerenter', { ...pointer, buttons: 0 }, PointerEvent as unknown as typeof MouseEvent);
    fire('mouseenter');
    fire('mousemove');
    fire('pointerdown', { ...pointer, buttons: 1 }, PointerEvent as unknown as typeof MouseEvent);
    fire('mousedown');
    try {
      el.focus?.();
    } catch {
      /* 不可聚焦时忽略 */
    }
    fire('pointerup', { ...pointer, buttons: 0 }, PointerEvent as unknown as typeof MouseEvent);
    fire('mouseup');
    fire('click');
  }

  /**
   * 在页面里**定位这条资源**并尽力唤起豆包自己的预览（守则 2/3：只读 DOM + 派发事件，
   * 不注入任何元素/样式，也不覆盖站点处理器）。
   * 返回值 = 是否在 DOM 里找到了它（找不到多半是「消息还没滚到、未渲染」）。
   */
  function locateAndPreview(keys: string[]): boolean {
    const el = findMediaInPage(keys);
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      /* 老浏览器忽略 */
    }
    humanClick(el);
    return true;
  }

  /**
   * 在页面里按「路径键」找回这条资源、取它的封面图（**只读**，2026-09-28 第十轮）。
   *
   * 为什么需要：卡片封面的两个站点来源是「链式报文的 `video_thumb`」与「创作树的 `node_cover`」。
   * 对**原片已超期**的旧作品，vid 早已不在创作树里，报文那条也没给 → 卡片只剩灰底；
   * 但页面里其实还挂着站点自己渲染的**带水印封面**（实测 `img.cover-u1rIsU…`）。
   * ⚠️ 只**读** URL 交给弹窗自己加载：不注入元素、不改样式、不点击。
   * ⚠️ 边界：只覆盖**当前已渲染**的媒体（懒渲染，滚不到的旧消息不在 DOM 里）。
   */
  function domCoverFor(draft: MediaDraft): string | null {
    const keys = mediaLookupKeys(draft.variants.map((variant) => variant.url));
    if (!keys.length) return null;
    const el = findMediaInPage(keys);
    return el ? coverInSameBlock(el) : null;
  }

  /** 给「站点两个来源都没给封面」的草稿补一次 DOM 回读 */
  function fillCoversFromDom(drafts: MediaDraft[]): { filled: MediaDraft[]; missing: MediaDraft[] } {
    const filled: MediaDraft[] = [];
    const missing: MediaDraft[] = [];
    for (const draft of drafts) {
      if (draft.cover) continue;
      const cover = domCoverFor(draft);
      if (cover) {
        draft.cover = cover;
        filled.push(draft);
      } else {
        missing.push(draft);
      }
    }
    return { filled, missing };
  }

  /**
   * 封面回读的**有界重试**：chain 响应常常早于页面把媒体渲染出来（差几百毫秒），
   * 首次回读可能扑空。按 0.4s / 1.2s / 3s 各再试一次（有界、可停止，守则 4），
   * 命中就补发一条带 cover 的同指纹草稿 —— `upsertDrafts` 的 `existing.cover || draft.cover`
   * 会把空封面填上，state 取优先级高者、不会回退。
   */
  function scheduleCoverRetry(drafts: MediaDraft[]): void {
    let pending = drafts;
    for (const delay of [400, 1200, 3000]) {
      window.setTimeout(() => {
        if (!pending.length || pageKind === 'none') return;
        const current = pending.filter((draft) => draft.convId === (convId || 'unknown'));
        if (!current.length) return;
        const { filled, missing } = fillCoversFromDom(current);
        pending = missing;
        if (!filled.length) return;
        diag('page.cover', `页面回读补齐 ${filled.length} 条封面（仍缺 ${missing.length}）`);
        postToWindow(envelope('page', MSG.MediaCaptured, filled));
      }, delay);
    }
  }

  /**
   * 拼 `draft.emit` 的模型诊断尾巴。读不到就返回空串 —— **不编造**。
   *
   * 两类信息要分清（2026-09-30 §35.10）：
   *   · `model=` / `tool=` = **跨批记忆里的最近一次提示**（原始值，排查用，带着它的批次时刻）；
   *   · `badges=` = **本批各条资源实际写入的药丸文案**（逐条计算，同一批里可能各不相同 ——
   *     这正是「一个会话里换过模型」的可观测证据）。
   */
  function modelTag(badges: string[]): string {
    const parts: string[] = [];
    if (modelHint?.label) parts.push(`text=${modelHint.label}`);
    if (modelHint?.model) parts.push(`model=${modelHint.model}`);
    if (modelHint?.tool) parts.push(`tool=${modelHint.tool}`);
    if (badges.length) {
      const counts = new Map<string, number>();
      for (const badge of badges) counts.set(badge, (counts.get(badge) ?? 0) + 1);
      parts.push(`badges=${[...counts].map(([badge, n]) => (n > 1 ? `${badge}×${n}` : badge)).join(',')}`);
    }
    if (!parts.length) return '';
    const hhmmss = modelHint ? new Date(modelHint.at).toTimeString().slice(0, 8) : '';
    return ` ${parts.join(' ')}${hhmmss ? `（最近一次提示取自 ${hhmmss} 的报文）` : ''}`;
  }

  /**
   * 读本批报文的模型提示并记住（§34）。
   *
   * ⚠️ 实测「模型」信息**不在成片那一批报文里** —— `chat_ability.ability_param.model`
   * 在**用户输入消息**那批、`ext.ai_creation_tool_list[].req_key` 在**生成任务 ack** 那批，
   * 所以这里必须记住最近一次读到的值（按字段合并，别用后一批把前一批冲掉），
   * 由 `modelTag()` 在 `draft.emit` 里标注来源时刻。
   * 纯诊断：读写都不影响解析与入库；切会话时清空（见 `syncContext`）。
   */
  function noteModelHints(text: string): void {
    const hints = readModelHints(text);
    if (!hints.label && !hints.model && !hints.tool) return;
    modelHint = {
      label: hints.label ?? modelHint?.label,
      model: hints.model ?? modelHint?.model,
      tool: hints.tool ?? modelHint?.tool,
      at: Date.now(),
    };
  }

  function emitDrafts(drafts: MediaDraft[]): void {
    if (!drafts.length || pageKind === 'none') return;
    const filtered = config.skipThumbOnly ? drafts.filter((draft) => draft.state !== 'thumb') : drafts;

    /*
     * 封面补齐：站点来源（链式报文的 `video_thumb`、创作树的 `node_cover`）都没有封面时，
     * 在**页面里按路径键回读**一次（典型场景 = 「原片已超期」的旧作品：vid 早已不在创作树里，
     * 但页面里仍挂着站点自己的带水印封面）。
     */
    const { missing } = fillCoversFromDom(filtered);
    if (missing.length) scheduleCoverRetry(missing);

    /*
     * `cover=` 是 2026-09-28 加的诊断：卡片缩略图显示不出来时，一眼就能区分
     * 「站点没给缩略图、页面里也回读不到」与「有 URL 但加载 403（签名/防盗链）」。
     * 行尾的模型信息见 `modelTag()`：`badges=` 是本批**逐条**算出来的药丸文案（§35.10）。
     */
    diag(
      'draft.emit',
      `in=${drafts.length} out=${filtered.length} skipThumbOnly=${config.skipThumbOnly} cover=${
        filtered.filter((draft) => draft.cover).length
      }/${filtered.length} kinds=${filtered.map((draft) => `${draft.kind}:${draft.state}`).join(',')}${modelTag(
        filtered
          .map((draft) => draft.meta.modelBadge)
          .filter((badge): badge is string => Boolean(badge)),
      )}`,
      { level: filtered.length ? 'info' : 'warn' },
    );
    if (!filtered.length) return;

    postToWindow(envelope('page', MSG.MediaCaptured, filtered));

    for (const draft of filtered) {
      if (draft.vid) void enrichWithResolvedVid(draft);
    }
  }

  /**
   * 「树里首次未见」后的**轮次式重扫**（2026-09-28 §27；2026-09-29 §34 定为**固定 10s × 30 轮**）。
   *
   * 成因见 `LIMITS.VID_EXPIRED_CONFIRM_MS` / `VID_FRESH_RESOURCE_MS`：站点创作树对**刚生成的
   * 视频有提交延迟**（观测上界样本：10.19s / 11.7s / 34s / 50s，§33 实测 >100s，分布未知）
   * ——「首次未见」不足以判定超期。
   * 每轮间隔固定 `VID_RECHECK_INTERVAL_MS`（10s），至多 `RECHECK_MAX_ROUNDS`（30 轮 = 5min）；
   * 每轮带 `confirmation` 绕过失败冷却（§26），由 resolver 判定：
   * 找到 → 正常入库（raw）；资源仍新（入库窗口内）→ 继续「解析中」不下结论；
   * 资源已不新且仍未见 → 落「原片已超期」。
   * 轮次本身也是延迟区间的测量仪器（每次未中收窄下界、命中给出上界，全程留痕诊断）。
   * 切会话 / 切上下文统一清掉（守则 4：低频、可停止）。
   */
  function scheduleTreeRecheck(vid: string, draft: MediaDraft, round: number): void {
    if (recheckTimers.has(vid)) return;
    const delay = LIMITS.VID_RECHECK_INTERVAL_MS;
    diag(
      'vid.recheck',
      `vid=${vid} → ${Math.round(delay / 1000)}s 后第 ${round}/${RECHECK_MAX_ROUNDS} 轮重扫（新作品等待站点登记进创作树）`,
    );
    const timer = window.setTimeout(() => {
      recheckTimers.delete(vid);
      // 用户已经切走 → 这次复查没有意义（切回时会重新走 chain 解析）
      if (draft.convId !== (convId || 'unknown')) return;
      void enrichWithResolvedVid(draft, { confirmation: true, round });
    }, delay);
    recheckTimers.set(vid, timer);
  }

  function cancelRechecks(): void {
    recheckTimers.forEach((timer) => clearTimeout(timer));
    recheckTimers.clear();
  }

  /** 用 vid 三步 API 的结果补一条高清原片变体，再次上报（同指纹 → 走 upsert 合并） */
  async function enrichWithResolvedVid(
    draft: MediaDraft,
    recheck: { confirmation: boolean; round: number } = { confirmation: false, round: 0 },
  ): Promise<void> {
    const vid = draft.vid;
    if (!vid) return;
    const { url, expired, pendingConfirm } = await resolveVidWithDiag(vid, {
      ...(recheck.confirmation ? { confirmation: true } : {}),
      /*
       * 资源自身的生成时刻（消息 `create_time`，见踩坑 19）—— 让 resolver 能区分
       * 「刚生成、站点还没入库」与「早已过期」：前者不下超期结论（§33）。
       * 拿不到就照旧（年龄未知 → 只看确认阈值）。
       */
      ...(draft.meta?.createdAt === undefined ? {} : { resourceAt: draft.meta.createdAt }),
    });
    if (!url) {
      /*
       * 确定性失败（2026-09-27 Finding C）：翻遍整棵「我的创作」树**且走过结论阈值**
       * 仍未见到该 vid —— 站点对创作记录有保存期限，原片永远取不到了。通知 bg 把条目落成
       * 「原片已超期」，取代过去「永远解析中」的挂死状态（网络失败不走这里，仍是可重试的 pending）。
       */
      if (expired && draft.convId === (convId || 'unknown')) {
        postToWindow(
          envelope('page', MSG.LibraryExpire, { convId: draft.convId, fingerprint: draft.fingerprint, vid }),
        );
        return;
      }
      /*
       * 树里首次未见（2026-09-28 第十轮）= 这是刚生成的作品，站点还没把它登记进创作树：
       * 条目保持 `pending`（界面就是保底的「解析中」），进入轮次式重扫（§27），
       * 直到站点登记进创作树（→ raw）或资源「不再新」后仍未见（→ 超期）。
       *
       * ⚠️ 2026-09-29 §33：**只要资源还在入库窗口内，就没有「超期」这个结局** ——
       * 站在这一支就说明 resolver 已判过年龄（`resourceAt`），我们只需继续排轮次等它入库。
       *
       * ⚠️ 不再为这条路径发任何额外草稿（原 `emitAwaitCommit` 已删，2026-09-29 §30）：
       * 它当时只为打 `meta.awaitingCommit` 让卡片显示「新作品入库中」，而那个标签**无法按需
       * 验证**（触发条件是与站点提交速度的竞态）且会被误读成故障 —— 用户拍板去掉，
       * 此期间统一用保底的「解析中」。
       */
      if (pendingConfirm) {
        const next = recheck.confirmation ? recheck.round + 1 : 1;
        if (next <= RECHECK_MAX_ROUNDS) scheduleTreeRecheck(vid, draft, next);
        return;
      }
      /*
       * 不下结论的失败（2026-09-28 §26）：确认轮次本身也可能撞上软限流 —— 轮次未用尽就排下一轮
       * （仍带 `confirmation` 绕过冷却）；用尽后交回冷却 + chain 重放的自然恢复节奏。
       */
      if (recheck.confirmation && recheck.round < RECHECK_MAX_ROUNDS) {
        scheduleTreeRecheck(vid, draft, recheck.round + 1);
      }
      return;
    }
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
    /*
     * 作品生成时间（2026-09-28 第十轮）：**消息时间优先，创作树时间兜底**。
     *
     * 草稿若已带上消息的 `create_time`（图片 / 视频都有，且与网页显示一致），就以它为准；
     * 只有当草稿没有时，才用 vid 三步 API 顺带取回的创作树节点 `create_time` 补上
     * （树只保留约三个月，旧作品与图片都不在树里 —— 所以它只是兜底）。
     * 站点不给就都不写：界面上该条目显示不出时间，排序时排在末尾，而不是编一个。
     */
    if (meta.createdAt === undefined && resolvedMeta?.createdAt !== undefined) {
      meta.createdAt = resolvedMeta.createdAt;
    }
    /*
     * 封面兜底（2026-09-28 第十轮）：链式报文里的 `video_thumb` 缺失或签名过期时，
     * 用 vid 三步 API 顺带带回的**创作树封面图**（`node_cover`）顶上 ——
     * 卡片缩略图就用站点自己的带水印封面（省流量、与站点显示一致，不抓原片帧）。
     * `upsertDrafts` 的合并是 `existing.cover || draft.cover`，所以后到的兜底值能补上空封面。
     */
    const treeCover = vidResolver.coverOf(vid);
    const cover = draft.cover || treeCover || null;
    const enriched: MediaDraft = {
      ...draft,
      meta,
      cover,
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
    // 模型提示（§34）：**必须在 `raws` 为空时也读** —— 实测模型信息正是在没有 creation 的那几批里
    noteModelHints(text);
    diag(
      'parse.sse',
      `len=${text.length} hasCreationBlock=${hasCreationBlock} raws=${raws.length}`,
      raws.length ? {} : { level: 'warn', text: sample(text, 'creation_block') },
    );
    if (!raws.length) return;
    // 模型药丸（§35.10）：按**本条资源自己的生成时刻**从本批时间线里就近取值
    attachModelBadges(raws, text);
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
    // 模型提示（§34）：必须在 `raws` 为空时也读（见 handleSse 同处注释）
    noteModelHints(text);
    diag(
      'parse.chain',
      `len=${text.length} hasMainUrl=${hasMainUrl} raws=${raws.length} vidHit=${vidHit} fallbackOnly=${fallbackOnly}`,
      raws.length ? {} : { level: 'warn', text: sample(text, 'main_url') },
    );
    if (!raws.length) return;
    // 模型药丸（§35.10）：按**本条资源自己的生成时刻**从本批时间线里就近取值
    attachModelBadges(raws, text);
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
    // 模型药丸（§35.10）：分享页这条路径没有报文文本 → 走跨批记忆兜底（读不到就不显示）
    attachModelBadges(raws);
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

    if (raws.length) {
      // 模型药丸（§35.10）：DOM 兜底路径只有记忆可用（读不到就不显示）
      attachModelBadges(raws);
      emitDrafts(toDrafts(raws, draftContext()));
    }
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
    const id = detectConvId();
    const kind = detectKind(location.pathname, id);
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
      // ③ 「原片已超期」二次确认的复查定时器一并作废（它们的目标 vid 属于上一个会话）
      cancelRechecks();
      // ④ 模型提示也要清（§34）：它是「上一个会话里那个模型」的，安到新会话上就是假数据
      modelHint = null;
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
      void resolveVidWithDiag(vid, { force: true }).then((outcome) => {
        postToWindow(envelope('page', MSG.VidResolved, { reqId, vid, url: outcome.url }));
      });
    }

    // 资源库点了「预览」→ 在页面里定位这条资源、尽力唤起豆包自己的预览（2026-09-28 第十轮）
    if (env.type === MSG.PreviewLocate) {
      const payload = env.payload as { reqId?: string; keys?: string[] } | undefined;
      const reqId = payload?.reqId ?? '';
      const keys = Array.isArray(payload?.keys) ? payload.keys : [];
      const found = locateAndPreview(keys);
      diag(
        'page.preview',
        `定位请求 keys=${keys.length} → ${found ? '已滚动并派发点击' : '页面里没找到（可能未渲染）'}`,
        { level: found ? 'info' : 'warn' },
      );
      postToWindow(envelope('page', MSG.PreviewLocated, { reqId, found }));
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
