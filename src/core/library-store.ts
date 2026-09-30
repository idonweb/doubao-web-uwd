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
 * 只保留指定会话的条目。切换会话时调用 → **资源库 == 当前会话**。
 * 无变化时原样返回（便于调用方用 `next !== library` 判断是否需要落盘）。
 * 会话 ID 为空时不做裁剪（拿不到会话时不该销毁既有数据）。
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
export function rekeyConv(library: Library, fromConvId: string, toConvId: string): Library {
  if (!fromConvId || !toConvId || fromConvId === toConvId) return library;
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
    'label',
    'createdAt',
    'modelBadge',
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
     */
    const primaryChanged =
      existing.primary !== primary.url && normalizeUrl(existing.primary) !== normalizeUrl(primary.url);
    if (primaryChanged && draft.meta.size === undefined) delete nextMeta.size;

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
