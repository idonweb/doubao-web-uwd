/**
 * 资源库仓储 —— **纯函数**，全部可单测。
 *
 * 这里是「上游重复条目」的对策落点（对应 SESSION_CONTEXT 的三层对策）：
 *   ① 主键换成稳定指纹：`${convId}::${fingerprint}`（视频用 vid、图片用原片 URL）
 *   ② 写入一律 upsert：命中已有 id 只合并 variants、更新 lastSeen
 *   ③ 同一资源的多个 URL 变体归并进同一个条目，不再各成一条
 */

import { DEFAULT_CONV_TITLE, LIMITS } from './constants';
import { dedupeVariants, normalizeUrl, pickPrimaryVariant } from './media-url';
import { isGenericDocTitle } from './title';
import type { LibraryGroup, LibraryQuery, MediaDraft, MediaItem, MediaKind, MediaState, Stats } from './types';

export type Library = Record<string, MediaItem>;

/** state 优先级：数字越大越「好」，合并时取大者 */
const STATE_RANK: Record<MediaState, number> = { raw: 3, pending: 2, thumb: 1, fail: 0 };

export function itemId(convId: string, fingerprint: string): string {
  return `${convId}::${fingerprint}`;
}

/* --------------------------------------------------------------------------- */
/* 会话作用域（2026-09-26 第四轮）                                                */
/*                                                                             */
/* 用户口径：**资源库只针对「当前激活的对话本身」** —— 切走即清空其它会话、        */
/* 每次激活会话都重启解析流程。为此需要三个纯函数：裁剪、改名、过滤草稿。           */
/* --------------------------------------------------------------------------- */

/**
 * 是否为「兜底会话标题」。
 *
 * `page/hook.ts::deriveTitle()` 在拿不到真实标题时会退到 `豆包对话 <convId 前 8 位>`。
 * 这个兜底值一旦被写进条目就永远粘住（历史是 `existing.convTitle || draft.convTitle`，
 * 真实标题后来也升不上去），实机表现就是资源库里一直显示「豆包对话 38443981」。
 * 因此需要一个纯函数把「兜底」与「真实」区分开。
 */
const FALLBACK_TITLE_RE = /^豆包对话(?:\s+[0-9A-Za-z_-]{1,12})?$/;

export function isFallbackTitle(title: string | undefined | null): boolean {
  const text = (title ?? '').trim();
  if (!text) return true;
  return FALLBACK_TITLE_RE.test(text);
}

/**
 * 「弱标题」= 界面兜底值（`豆包对话 <id8>`）**或**站点通用名（`豆包 - 字节跳动旗下 AI 智能助手`）。
 * 两者都不携带任何对话信息，因此：既可以被真实标题覆盖，也不应该在界面上原样显示。
 */
export function isWeakTitle(title: string | undefined | null): boolean {
  return isFallbackTitle(title) || isGenericDocTitle(title ?? '');
}

/**
 * 界面显示用的会话名：真实标题优先，拿不到（或只有弱标题）就统一显示
 * `DEFAULT_CONV_TITLE`（「豆包-AI 智能助手」，第四轮用户拍板，不再带会话 ID）。
 *
 * ⚠️ 兜底**只用于展示** —— 页面侧不产生兜底标题、`retitleConv()` 也只接受真实标题，
 * 这样「还没解析到标题」这件事始终可见（可以重试），而不是被一个假标题永久盖住。
 */
export function displayConvTitle(title: string | undefined | null): string {
  const text = (title ?? '').trim();
  if (text && !isWeakTitle(text)) return text;
  return DEFAULT_CONV_TITLE;
}

/** 标题合并策略：真实标题可以覆盖弱标题，弱标题永远不覆盖已有的标题 */
function pickConvTitle(base: string, incoming: string): string {
  if (!incoming) return base;
  if (!base) return incoming;
  if (isWeakTitle(base) && !isWeakTitle(incoming)) return incoming;
  return base;
}

/**
 * 只保留指定会话的条目 → **资源库（一个标签页的槽）== 该标签页当前会话**。
 * 无变化时原样返回（便于调用方用 `next !== library` 判断是否需要落盘）。
 * 会话 ID 为空时不做裁剪（拿不到会话时不该销毁既有数据）。
 *
 * ⚠️ 2026-10-02 §38 多标签页修复后，本函数的作用范围从「全局资源库」缩小到
 * **一个标签页的槽**（见 `types.ts::LibrarySlots`）：语义一字未改，
 * 只是「切走即清」从此只清**这一个标签页**，不再波及别的标签页（那是实机 bug 的根因）。
 * 跨标签页的删除只发生在：关标签页（`tabs.onRemoved`）、该标签页离开会话
 * （`tabs.onUpdated` / `kind=none` 自报）、以及浏览器重启后的对账。
 */
export function retainConv(library: Library, convId: string): Library {
  if (!convId) return library;
  const next: Library = {};
  let changed = false;
  for (const [id, item] of Object.entries(library)) {
    if (item.convId === convId) next[id] = item;
    else changed = true;
  }
  return changed ? next : library;
}

/**
 * 是否为「离开会话」的作用域上报：豆包域内的**非会话页**（首页 `/chat`、无会话 ID 的页面）。
 *
 * 2026-09-27 第八轮新增。L1 的语义补角：资源库 == 当前激活会话 ——
 * 之前只定义了「切走即清空」，没定义「离开到非会话页」算什么，
 * 结果 bg 永远不知道用户已离开会话，上个会话的条目残留进库
 * （实测：豆包首页的弹窗在「未检测到豆包对话或分享页面」状态下显示上一会话的视频，`docs/03` §15）。
 *
 * bg 收到后应**清空资源库 + 置空作用域**；回到任何会话时 chain 历史重拉会照常恢复
 * （与「切走即清空、回来靠重解析」同一语义，实测可恢复）。
 * ⚠️ `local_*` 占位会话**不是**离开 —— 它仍是会话，由 `rekeyConv` 接手（第七轮）。
 */
export function isLeaveScope(scope: { convId?: string; kind?: string }): boolean {
  if (scope.kind === 'none') return true;
  return !scope.convId?.trim();
}

/**
 * 把 `fromConvId` 会话下的所有条目**重键**到 `toConvId` 会话。
 *
 * 2026-09-27 第七轮新增。背景：新建会话时页面 URL 先是 `local_*` 占位 ID，
 * 提交首条消息后才 replaceState 成真实 ID —— 占位窗口期入库的条目 convId 是占位值，
 * 真实 ID 的 scope 到达时若直接 `retainConv()` 会把它们当「异会话」清掉（丢素材）。
 * 调用方（`bg::applyScope`）检测到「占位 → 真实」的会话切换时，先重键再裁剪。
 *
 * 指纹冲突（同一素材在两个会话 ID 下各有一条）时合并 variants / meta，保留更完整的。
 * 无占位条目时原样返回（便于调用方用 `next !== library` 判断是否需要落盘）。
 */
export function rekeyConv(library: Library, fromConvId: string, toConvId: string): Library {  if (!fromConvId || !toConvId || fromConvId === toConvId) return library;
  const next: Library = { ...library };
  let changed = false;
  for (const item of Object.values(library)) {
    if (item.convId !== fromConvId) continue;
    const targetId = itemId(toConvId, item.fingerprint);
    const existing = next[targetId];
    if (existing) {
      const variants = dedupeVariants([...existing.variants, ...item.variants]);
      const primary = pickPrimaryVariant(variants);
      next[targetId] = {
        ...existing,
        variants,
        primary: primary?.url ?? existing.primary,
        meta: metaMerge(existing.meta, item.meta),
        lastSeen: Math.max(existing.lastSeen, item.lastSeen),
      };
    } else {
      next[targetId] = { ...item, id: targetId, convId: toConvId };
    }
    delete next[item.id];
    changed = true;
  }
  return changed ? next : library;
}

/** 拿到真实会话标题后，把该会话下**所有**条目的标题一并刷新（解除「兜底标题粘住」） */
export function retitleConv(library: Library, convId: string, title: string): Library {
  // 只接受真实标题：弱标题（兜底值 / 站点通用名）写进去只会污染资源库
  if (!convId || !title || isWeakTitle(title)) return library;
  const next: Library = { ...library };
  let changed = false;
  for (const [id, item] of Object.entries(next)) {
    if (item.convId !== convId || item.convTitle === title) continue;
    next[id] = { ...item, convTitle: title };
    changed = true;
  }
  return changed ? next : library;
}

/**
 * 丢弃不属于当前会话的草稿。
 *
 * 成因：chain/single 的响应可能在「用户已切走」之后才到达，此时 `draftContext()`
 * 盖的是**新会话**的 convId，于是同一条素材会在两个会话下各存一份（实机的「重复记录」）。
 * 会话作用域下这些草稿本来就该丢。
 */
export function filterDraftsByConv(drafts: MediaDraft[], convId: string): MediaDraft[] {
  if (!convId) return drafts;
  return drafts.filter((draft) => draft.convId === convId);
}

export interface UpsertOptions {
  /** 资源库上限，默认 LIMITS.LIBRARY_MAX（超出按 lastSeen 升序 FIFO 淘汰） */
  max?: number;
  /** 「过滤掉纯缩略图项」：为 true 时只收录解析到无水印原片的条目 */
  skipThumbOnly?: boolean;
  /** 注入时间，便于测试 */
  now?: number;
}

export interface UpsertResult {
  library: Library;
  added: number;
  merged: number;
  skipped: number;
  evicted: number;
}

/** 变体合并：按 URL+label 去重，保留 rank 更高者 */
function mergeVariants(base: MediaItem['variants'], incoming: MediaItem['variants']): MediaItem['variants'] {
  return dedupeVariants([...base, ...incoming]);
}

/**
 * 资源属性合并（白名单）。
 *
 * ⚠️ **只放「描述那个可下载文件」的字段** —— 瞬态的子状态（如 `expired`）不在这里搬：
 * 它随 `state` 变化，由 `upsertDrafts` 显式接管（见那里的说明）。
 *
 * `modelBadge`（2026-09-30 §35.11 起）**在白名单里**：它描述「这个文件是哪个模型生成的」，
 * 且取值已按**每条资源自己的生成时刻**从模型时间线就近取（§35.10），重放同一批报文结果稳定；
 * 进白名单才能让历史条目上早先算错的值被修正（否则 F5 / 切会话后错误标记永远粘着）。
 *
 * `sizeFor`（2026-10-02 §39）**必须和 `size` 同进白名单**：两者是同一个数字的两个部分
 * （数字 + 它属于哪个文件），只搬一半就会出现「3.0 MB 被当成原片体积」那种错标。
 */
function metaMerge(base: MediaItem['meta'], incoming: MediaItem['meta']): MediaItem['meta'] {
  const out = { ...base };
  for (const key of [
    'ext',
    'mime',
    'width',
    'height',
    'dimsPreview',
    'duration',
    'size',
    'sizeFor',
    'label',
    'createdAt',
    'modelBadge',
    /*
     * `patch`（2026-10-03 §43）：**必须进白名单** —— 它描述「这个条目的无水印是怎么来的」
     * （站点原片 vs 两档互补重建），重放同一批报文结果稳定；漏了它，F5 / 切会话后
     * 条目会退回成「无水印原片」的口径，而实际上那张图的水印在左上。
     * ⚠️ `patchFail` **不在这里**：它不是「文件的描述」，而是**下载时的一次校验结果**，
     *     由 bg 显式设置/清除（`setPatchFail`），进白名单会被后续草稿反复覆盖。
     * ⚠️ `shareDlFail`（2026-10-03 §48.7）同理**不在这里**：分享直链「这一次没解出」
     *     也是下载时的一次结果，由 bg 显式设置/清除（`setShareFail`）。
     */
    'patch',
  ] as const) {
    const value = incoming[key];
    if (value !== undefined && value !== null && value !== '') {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * 批量 upsert。返回新对象（不原地修改传入的 library），便于 storage 层比较变更。
 */
export function upsertDrafts(library: Library, drafts: MediaDraft[], options: UpsertOptions = {}): UpsertResult {
  const max = options.max ?? LIMITS.LIBRARY_MAX;
  const skipThumbOnly = options.skipThumbOnly ?? false;
  const now = options.now ?? Date.now();

  const next: Library = { ...library };
  let added = 0;
  let merged = 0;
  let skipped = 0;

  for (const draft of drafts) {
    if (!draft.fingerprint) continue;
    const id = itemId(draft.convId, draft.fingerprint);
    const existing = next[id];

    if (!existing) {
      // 「过滤掉纯缩略图项」：新条目只解析到缩略图 → 不收（后续拿到原片时自然会插入）
      if (skipThumbOnly && draft.state === 'thumb') {
        skipped++;
        continue;
      }
      const variants = dedupeVariants(draft.variants);
      const primary = pickPrimaryVariant(variants);
      if (!primary) continue;
      next[id] = {
        id,
        convId: draft.convId,
        convKind: draft.convKind,
        convTitle: draft.convTitle,
        fingerprint: draft.fingerprint,
        kind: draft.kind,
        state: draft.state,
        variants,
        primary: primary.url,
        cover: draft.cover,
        meta: draft.meta,
        firstSeen: now,
        lastSeen: now,
      };
      added++;
      continue;
    }

    // 命中已有指纹 → 合并，绝不新增条目
    const variants = mergeVariants(existing.variants, draft.variants);
    const primary = pickPrimaryVariant(variants);
    if (!primary) continue;

    /*
     * 「原片已超期」是**可撤销的弱结论**（2026-09-28 第十轮）：
     *   · 站点的创作树对刚生成的视频有提交延迟，「翻到底未见」曾把新视频误判成超期
     *     （实测 50s 后就能解析出来）；因此**正证据必须能翻案** ——
     *     一旦草稿带来了原片（`draft.state === 'raw'`），就清掉 `expired` 并升为 raw。
     *   · 反之，chain 历史重放带来的 `pending` / `thumb` 草稿**不得**把已判定的条目升回
     *     「解析中」（否则每次 F5 都会在「解析中 ↔ 已超期」之间来回跳）。
     */
    const revived = existing.meta.expired === true && draft.state === 'raw';
    const nextState: MediaState = revived
      ? 'raw'
      : existing.meta.expired
        ? existing.state
        : STATE_RANK[draft.state] > STATE_RANK[existing.state]
          ? draft.state
          : existing.state;
    const nextMeta = metaMerge(existing.meta, draft.meta);
    if (revived) delete nextMeta.expired;
    /*
     * **`primary` 换成「另一个文件」⇒ 旧体积作废**（2026-09-28 实机踩到的坑）。
     *
     * 体积是「那个会被下载的文件」的属性：地址换了文件，旧的 `size` 就不再属于它。
     * 实机反例：卡片显示 378 KB（来自报文里 image 子对象的 `size` 字段），点下载实际拿到
     * 3.81 MB 的 PNG —— 数字与文件根本不是同一个东西。
     *
     * ⚠️ 判定必须用 **`normalizeUrl()` 归一化后**的地址：站点的原片地址是**带时效签名**的，
     * 每次重放签名段都会变 —— 那是「同一个文件的又一份签名」，不是换了文件
     * （早先按原始字符串比较，会把刚量到的体积一次次删掉，图片体积就再也留不住）。
     * ⚠️ 本次草稿自己带了 `size`（视频的创作树 `size` 与解析出的原片地址同批到达）则保留。
     * ⚠️ 2026-10-02 §37：删掉之后**不必等 F5** —— `bg` 的体积实测按「条目 + 归一化地址」
     * 记账（`core/size-probe.ts`），下一次入库就会对新地址重测（实机「体积过一会儿没了」
     * 的根因就是旧实现删了之后永不再测）。
     */
    const primaryChanged =
      existing.primary !== primary.url && normalizeUrl(existing.primary) !== normalizeUrl(primary.url);
    if (primaryChanged && draft.meta.size === undefined) {
      // 数字与它的归属标记**成对**作废（§39），否则会留下「有归属、没数字」的残影
      delete nextMeta.size;
      delete nextMeta.sizeFor;
    }

    next[id] = {
      ...existing,
      // ⚠️ 不能写成 `existing.convTitle || draft.convTitle` —— 那会让早期写进去的
      // 兜底标题（`豆包对话 <id8>`）**永远粘住**，真实标题再也不会被采纳。
      convTitle: pickConvTitle(existing.convTitle, draft.convTitle),
      state: nextState,
      variants,
      primary: primary.url,
      cover: existing.cover || draft.cover,
      meta: nextMeta,
      lastSeen: now,
    };
    merged++;
  }

  // FIFO 淘汰：按 lastSeen 升序删到上限
  let evicted = 0;
  const ids = Object.keys(next);
  if (ids.length > max) {
    ids
      .sort((a, b) => next[a].lastSeen - next[b].lastSeen)
      .slice(0, ids.length - max)
      .forEach((id) => {
        delete next[id];
        evicted++;
      });
  }

  return { library: next, added, merged, skipped, evicted };
}

/**
 * 直接把某个条目标记为失败（下载 1 次重试后仍失败时调用）。
 *
 * ⚠️ **不刷新 `lastSeen`**（2026-09-28 第十轮）：它是「插件最后一次处理该条目」的本地时刻，
 * 而「下载失败」不是资源出现的证据 —— 刷新它会让老资源在列表里往前跳。
 * 排序已改用 `meta.createdAt`（站点真实生成时间），因此原签名里的 `now` 入参一并移除。
 */
export function markFailed(library: Library, id: string): Library {
  const item = library[id];
  if (!item) return library;
  return { ...library, [id]: { ...item, state: 'fail' } };
}

/**
 * 把「原片已超期」落到条目上（2026-09-27 Finding C 修复；2026-09-28 第十轮改成可撤销）。
 *
 * 页面侧已**翻遍整棵「我的创作」树**（且走完二次确认窗口）仍未找到该 vid —— 站点对创作记录
 * 有保存期限（实测约三个月：6.23 的原片可解析、5 月的 vid 已清除），原片永远取不到了。
 * 与下载失败（`markFailed`）不同：条目除 `state='fail'` 外还带 `meta.expired`，界面据此显示
 * 「原片已超期」而不是「获取失败」，且后续 chain 重放的 pending 草稿不得把它升回「解析中」。
 *
 * ⚠️ **正证据优先**：条目已经拿到原片（`state === 'raw'`）时不打标 —— 说明这个 vid 明明能解析
 * （站点创作树的提交延迟会造成假超期），一次迟到的失败通知不该覆盖已经成立的事实。
 * 反过来，`upsertDrafts` 里 `raw` 草稿也会 `delete meta.expired` 把它撤销。
 * ⚠️ **不刷新 `lastSeen`**：判定超期是本地事件，不是「资源出现」，刷新它会扰乱列表时间轴
 * （原签名里的 `now` 入参已随之移除）。
 */
export function markExpired(library: Library, convId: string, fingerprint: string): Library {
  const id = itemId(convId, fingerprint);
  const item = library[id];
  if (!item || item.state === 'raw') return library;
  return { ...library, [id]: { ...item, state: 'fail', meta: { ...item.meta, expired: true } } };
}

/** 覆盖某个条目的 primary（例如 vid 三步 API 拿到更好的原片后） */
export function patchItem(library: Library, id: string, patch: Partial<MediaItem>): Library {
  const item = library[id];
  if (!item) return library;
  return { ...library, [id]: { ...item, ...patch } };
}

/**
 * 当前下载地址（`primary`）是不是**无水印原片**变体（2026-10-02 §37）。
 *
 * 用途：界面据此判断「卡片上的体积描述的是原片，还是带水印的候选流」——
 * 非原片时显示成「预览 3.1 MB」（用户 2026-10-02 拍板：先给预览体积，
 * 原片解析成功再切换成正确的原片体积）。
 *
 * ⚠️ 判定必须**按变体的 `isRaw`**，不能按 `state === 'raw'`：
 *   · 下载失败会把一个**原片**条目打成 `state='fail'`（`markFailed`），
 *     那它的体积仍然是原片的体积，不该被标成「预览」；
 *   · `state='thumb'` 的图片同理（体积量的是缩略图那个文件 → 标「预览」是对的）。
 * ⚠️ 比地址要**归一化**（`normalizeUrl`）：带时效签名的地址换一份签名仍是同一个文件。
 *   `primary` 本来就取自 `pickPrimaryVariant()`，所以正常情况下必能命中。
 */
export function primaryIsRaw(item: MediaItem): boolean {
  const key = normalizeUrl(item.primary);
  if (!key) return false;
  return item.variants.some((variant) => variant.isRaw && normalizeUrl(variant.url) === key);
}

/**
 * 「**原片已经就绪**」——体积归属与升级测量唯一的事实来源（2026-10-02 §39 追加）。
 *
 * 两个证据**任一成立**即算原片就绪：
 *   ① `state === 'raw'` —— 草稿层声明的「这条资源有原片」（`toDraft` 只在拿到 `isRaw` 变体时才给 raw，
 *      合并时 `STATE_RANK` 也保证它不会被降级）；
 *   ② `primaryIsRaw(item)` —— 当前下载地址确实是某个 `isRaw` 变体。
 *
 * ⚠️ 为什么必须两条合起来（实机 bug）：只用 ② 时，条目在「原片已解析、但 `variants`/`primary`
 * 的关系还没稳定」的窗口里会被判成「未就绪」→ **升级测量被跳过**，卡片就一直停在
 * 「预览 1.7 MB」（诊断 `bg.size` 可见 `原片 1 / 预览体积 2`，之后再无测量记录）。
 * 只用 ① 又会漏掉「下载失败（`markFailed` 把 state 打成 fail）」但其实手里是原片的情况。
 */
export function rawReady(item: MediaItem): boolean {
  return item.state === 'raw' || primaryIsRaw(item);
}

/**
 * 这个条目的体积「**属于谁**」（2026-10-02 §39）—— UI 据此决定要不要标「预览」。
 *
 * 判据：**显式标记优先**（`meta.sizeFor`，由写入方随数字一起落库），缺省一律当 `'preview'`
 * （保守：宁可多标「预览」，也不把候选流的体积谎称成原片）。
 *
 * ⚠️ 为什么不直接用 `primaryIsRaw()` 现场推断（§39 的实机 bug 正是这么来的）：
 * `primary` 切到原片是异步的，而体积实测要 ~0.7s —— 二者赛跑时，**候选流的数字**会被写进
 * 「已经是原片」的条目里，现场推断就会把那个数字当成原片体积显示（实机：`3.0 MB` 对 `7.1 MB`）。
 * 标记随数字走之后，这种错标在结构上不可能再出现。
 */
export function sizeForOf(item: MediaItem): 'raw' | 'preview' {
  return item.meta.sizeFor === 'raw' ? 'raw' : 'preview';
}

/**
 * 给体积定归属：**原片已就绪 → `'raw'`，否则 → `'preview'`**（写库方唯一入口，§39 追加）。
 * 抽成函数是为了让「写标记」与「要不要升级测量」永远用同一把尺子（两处用不同判据正是本轮 bug 的成因）。
 */
export function sizeForNow(item: MediaItem): 'raw' | 'preview' {
  return rawReady(item) ? 'raw' : 'preview';
}

/**
 * 这条**视频**要不要走「站点播放源换无水印」（fplay 通路）—— 行为判据（2026-10-04 第三十五轮）。
 *
 * 满足三条才算：
 *   · `kind === 'video'`（图片没有这条路）；
 *   · `state !== 'raw'`（已经拿到原片的条目**必须**用原片，fplay 那个是预览家族，别降级）；
 *   · **分享页**（`convKind='thread'`）无条件成立；**对话页**要求 `meta.expired`
 *     （创作者本人的对话页里，只有创作树原片已被清除的老作品才需要补救）。
 *
 * 用途：`hasCopyableDirectLink`（复制置灰）、`popup` 的卡片「下载 / 原画」、bg 的下载分支。
 * ⚠️ 抽成函数是让这几处共用同一把尺子 —— 先前各写一套，改口径必然漏一处。
 *
 * 📌 **标签判据 = 本判据**（2026-10-04 §55 起，见 `stateTagOf`）—— 分享页条目不再等
 *    `meta.expired` 就标「无水印（分享页）」（否则要等三步链路翻树 + 20s 确认窗口，
 *    实机体感「下载已生效、标签还在解析中」）。⚠️ 只有**悬停说明**仍等 `meta.expired`。
 */
export function needsShareWatermark(item: MediaItem): boolean {
  if (item.kind !== 'video' || item.state === 'raw') return false;
  return item.convKind === 'thread' || item.meta.expired === true;
}

/**
 * 这条资源**有没有可直接复制的无水印直链**（2026-10-04 §52）。
 *
 * 两种情形**没有** —— 它们的 `primary` 都不是无水印文件，复制出去会被当成原片：
 *   ① **补角重建的图**（`meta.patch`）：无水印只存在于下载时的合成结果里；
 *   ② **要靠播放源换无水印的视频**（`needsShareWatermark()`）：分享页视频、以及对话页的超期视频，
 *      `primary` 是带水印的播放 / 预览档地址，还带时效签名；已解析回原片的照常有直链。
 *
 * ⚠️ 抽成函数是为了让**卡片「复制」置灰与批量条跳过共用同一把尺子**：原先两处各写一套
 * （卡片看页面类型、批量条漏了补角图片），实机上就出现「卡片明明置灰、批量条却照样复制」。
 * 改口径只改这里。⚠️ 用 `convKind` / `meta`（条目自己的属性）而**不是**当前页面类型 ——
 * 判据描述的是条目本身，与用户此刻正打开哪个页面无关。
 */
export function hasCopyableDirectLink(item: MediaItem): boolean {
  if (item.meta.patch) return false;
  return !needsShareWatermark(item);
}

/* --------------------------------------------------------------------------- */
/* 查询                                                                          */
/* --------------------------------------------------------------------------- */

export function emptyStats(): Stats {
  return { total: 0, video: 0, image: 0, raw: 0, thumb: 0 };
}

/** 统计（可限定某个会话） */
export function statsOf(library: Library, convId?: string): Stats {
  const stats = emptyStats();
  for (const item of Object.values(library)) {
    if (convId && item.convId !== convId) continue;
    stats.total++;
    if (item.kind === 'video') stats.video++;
    else stats.image++;
    if (item.state === 'raw') stats.raw++;
    if (item.state === 'thumb') stats.thumb++;
  }
  return stats;
}

function sizeOf(item: MediaItem): number {
  return item.meta.size ?? 0;
}

function matchesQuery(item: MediaItem, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const haystack = [item.convTitle, item.convId, item.fingerprint, item.id, item.meta.label ?? '']
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/**
 * 「最新 / 最早」的排序键（2026-09-28 第十轮改）：
 *
 * **站点给的真实生成时间优先**（`meta.createdAt`，来自创作树节点的 `create_time`）。
 * 此前用的是 `lastSeen`（插件最后一次处理该条目的本地时刻）—— 它有两个致命问题：
 *   ① 每次解析合并都会把它刷成同一瞬间（chain 重放 → 全表并列，排序退化成插入顺序）；
 *   ② `markFailed` / `markExpired` 也会刷它 —— 于是「刚被判超期」的老视频会被顶到列表最前
 *      （实机现象：两条 6.07 的老视频排在 9-27 刚生成的新视频前面）。
 *
 * ⚠️ 拿不到真实时间的（vid 不在创作树里：已超期 / 尚未提交）**不编造** —— 一律排在末尾，
 * 组内再按 `lastSeen` 倒序稳定。这样「新视频还没提交进树」的几十秒里它会暂时靠后，
 * 一旦解析成功拿到 `create_time` 立刻归位。
 */
function compareTime(a: MediaItem, b: MediaItem, dir: 1 | -1): number {
  const ka = a.meta.createdAt;
  const kb = b.meta.createdAt;
  if (ka === undefined && kb === undefined) return b.lastSeen - a.lastSeen;
  if (ka === undefined) return 1;
  if (kb === undefined) return -1;
  return (ka - kb) * dir;
}

function sortItems(items: MediaItem[], sort: LibraryQuery['sort']): MediaItem[] {
  const copy = [...items];
  if (sort === 'oldest') copy.sort((a, b) => compareTime(a, b, 1));
  else if (sort === 'largest') copy.sort((a, b) => sizeOf(b) - sizeOf(a) || b.lastSeen - a.lastSeen);
  else copy.sort((a, b) => compareTime(a, b, -1));
  return copy;
}

const KIND_TITLE: Record<MediaKind, string> = { video: '视频', image: '图片' };

export interface QueryResult {
  groups: LibraryGroup[];
  /** 全量统计（不受筛选影响，用于 chips 计数） */
  counts: Stats;
  /** 当前筛选后的条数 */
  filteredTotal: number;
}

/** 资源库查询：筛选 + 搜索 + 排序 + 分组（按会话 / 按类型） */
export function queryLibrary(library: Library, query: LibraryQuery): QueryResult {
  const all = Object.values(library);
  const counts = statsOf(library);

  let items = all;
  if (query.filter !== 'all') items = items.filter((i) => i.kind === query.filter);
  items = items.filter((i) => matchesQuery(i, query.query));

  const groups = new Map<string, LibraryGroup>();

  for (const item of items) {
    const key = query.groupBy === 'conv' ? item.convId : item.kind;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        kind: query.groupBy,
        title: query.groupBy === 'conv' ? item.convTitle || item.convId : KIND_TITLE[item.kind],
        convId: item.convId,
        convKind: item.convKind,
        items: [],
        latest: 0,
        deduped: 0,
      };
      groups.set(key, group);
    }
    group.items.push(item);
    // 「本组最新时间」：有站点真实生成时间就用它，否则退回 lastSeen（两者同为毫秒 epoch）
    group.latest = Math.max(group.latest, item.meta.createdAt ?? item.lastSeen);
  }

  const list = [...groups.values()].map((group) => {
    const sorted = sortItems(group.items, query.sort);
    let deduped = 0;
    let size = 0;
    for (const item of sorted) {
      if (item.variants.length > 1) deduped += item.variants.length - 1;
      size += sizeOf(item);
    }
    return { group: { ...group, items: sorted, deduped }, size };
  });

  if (query.sort === 'oldest') list.sort((a, b) => a.group.latest - b.group.latest);
  else if (query.sort === 'largest') list.sort((a, b) => b.size - a.size || b.group.latest - a.group.latest);
  else list.sort((a, b) => b.group.latest - a.group.latest);

  return { groups: list.map((entry) => entry.group), counts, filteredTotal: items.length };
}

/** 会话数（用于「超过 5 组自动折叠」） */
export function convCount(library: Library): number {
  return new Set(Object.values(library).map((i) => i.convId)).size;
}
