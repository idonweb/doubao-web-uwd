/**
 * 弹窗 —— **单窗口：弹窗即资源库**。
 *
 * ## 第五轮（2026-09-26）：两级窗口合并
 *   - 删除 360px 设置视图与「打开资源库 / ← 返回设置」跳转，弹窗打开即资源库（720×594），
 *     `ui/library/*`（含 iframe 内嵌方案）已整体删除；
 *   - **计数只出现一次**：原「视频 / 图片 / 合计」大数字块删除，计数并入可点击的筛选 chips；
 *     会话行原本重复的「N 项」同步删除，只留「更新时间 · 合并重复数」；
 *   - **会话信息二合一**：原「状态卡（状态点 + 文案 + 徽标 + URL）」与「资源库会话头
 *     （徽标 + 会话名 + 合并重复）」合并为一张会话卡 —— 会话名与徽标各只出现一次；
 *   - **唯一开关收掉**：`skipThumbOnly` 恒为开启（配置字段保留，界面不再暴露），
 *     底部只留一行状态说明；设置视图因此再无存在必要；
 *   - **删除搜索栏**：资源库已收敛到单会话（上限 99 条），检索价值低；
 *   - **全选**改为「勾选框 + 全选」文字按钮，放在原搜索栏的位置（工具条右侧）；
 *   - **诊断入口**从底部提示行的行内文字链，改为底部状态条右侧的独立按钮。
 *
 * ## 第五轮补充（同日 22:45）—— 头部与操作收敛
 *   - **删除「清空列表」**：与「全选 → 移除」功能重复；
 *   - **头部空出来的位置**放两个按钮：**深浅色切换**（写 `theme` 显式值）与
 *     **GitHub 仓库入口**（`REPO_URL` 尚未回填 → 置灰，发布后填上即可）；
 *   - 曾短暂加过一个「重新解析」按钮（`page:rescan` 链路），**同日删除**：
 *     实测**不按 F5 就不可能重放历史报文**，按了也没用，见下。
 *
 * ## 第五轮补充之二（同日 23:05）—— 删除「刷新」与「移除」
 *   - **删除「重新解析」按钮**（含 `page:rescan` 整条链路）：页面侧能重读的只有
 *     「分享页内联结构 + DOM 视频的 vid」，而**历史资源依赖站点的 SSE / chain 报文**，
 *     不 F5 就不可能重放 —— 按钮点了没有实际效果，属于误导，故整体删除；
 *   - **删除「移除」**（卡片上的单条移除 + 批量条上的移除）：既然「清解析结果」这件事
 *     不 F5 就无法真正重置（重新解析会把同一素材再写回来），这个操作本身没有意义，
 *     不如直接 F5 刷新页面。随之删除 `library:remove` / `library:clear` 两条协议、
 *     `api.removeFromLibrary` / `api.clearLibrary`、`bg` 的两个 case 与
 *     `core/library-store.ts` 的 `removeItems()` / `clearLibrary()`。
 *     卡片动作因此只剩「下载 / 复制」；批量条只剩「下载 / 复制」。
 *
 * ## 未改动的口径
 *   - 资源库只显示**当前激活对话**（bg 已按会话裁剪并回传 `scope`）；
 *   - 页面侧**彻底零干预**：不注入任何元素（含 `<style>`）、不改样式、不拦截点击；
 *     所有无水印下载统一由这里提供；
 *   - 四种页面状态、深浅主题、批量操作、去重与签名自愈逻辑一律不变。
 */

import './popup.css';

import { AUTHOR_BILI_NAME, AUTHOR_BILI_UID, EXT_NAME, REPO_URL } from '../../core/constants';
import { displayConvTitle, queryLibrary, type Library } from '../../core/library-store';
import { mediaLookupKeys } from '../../core/media-url';
import {
  getState,
  listLibrary,
  locateInPage,
  onConfigChanged,
  onLibraryChanged,
  onProgress,
  openDebugPage,
  patchConfig,
  requestDownload,
} from '../shared/api';
import {
  STATE_TAG,
  copyText,
  esc,
  fmtBytes,
  fmtClock,
  fmtDuration,
  itemMetaLine,
  itemTimeLabel,
  openExtensionManager,
  resolveTheme,
  stateTagLabel,
  stateTagTitle,
  toast,
  watchSystemTheme,
} from '../shared/dom';
import { icon, type IconName } from '../shared/icons';
import { isDoubaoHostUrl } from '../../core/site-contract';
import type { ConvScope, DownloadProgress, MediaItem, PageInfo, PageKind, StateResponse } from '../../core/types';

const rootEl = document.getElementById('app');
if (!rootEl) throw new Error('#app 不存在');
const root: HTMLElement = rootEl;

let state: StateResponse | null = null;
let library: Library = {};
let scope: ConvScope | null = null;
let progress: DownloadProgress | null = null;
let errorText = '';
const selected = new Set<string>();
let downloadActive = false;

/* --------------------------------------------------------------------------- */
/* UI 偏好（本设备持久化；不放进 chrome.storage，避免与业务数据混在一起）          */
/* --------------------------------------------------------------------------- */

type Filter = 'all' | 'video' | 'image';
type Sort = 'newest' | 'oldest' | 'largest';

interface UiPrefs {
  view: 'grid' | 'list';
  sort: Sort;
  filter: Filter;
}

const PREFS_KEY = 'uwd:ui';

function loadPrefs(): UiPrefs {
  const fallback: UiPrefs = { view: 'grid', sort: 'newest', filter: 'all' };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<UiPrefs>) };
  } catch {
    return fallback;
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 忽略 */
  }
}

const prefs = loadPrefs();

/* --------------------------------------------------------------------------- */
/* 渲染                                                                          */
/* --------------------------------------------------------------------------- */

interface BadgeSpec {
  cls: string;
  text: string;
  icon: IconName;
}

const PAGE_BADGE: Record<PageKind, BadgeSpec> = {
  chat: { cls: 'b-chat', text: '对话页', icon: 'chat' },
  thread: { cls: 'b-thread', text: '分享链接页', icon: 'link' },
  none: { cls: 'b-none', text: '非豆包页面', icon: 'image' },
};

/**
 * 「豆包站内 · 非对话页」（2026-09-27 用户要求）：豆包首页（新建对话未输入）这类
 * 在豆包域内、但插件能抓取的对话页 / 分享页都还没出现的情形 —— 不能说成「非豆包页面」。
 * 域名判定用 `isDoubaoHostUrl`（站点契约，与 bg 的 `isDoubaoUrl` 同源）。
 */
const BADGE_DOUBAO_NONCONV: BadgeSpec = { cls: 'b-none', text: '豆包非对话页', icon: 'image' };

/** 「豆包页待刷新」：页面确实是豆包页，只是内容脚本还没注入 —— 不能说成「非豆包页面」 */
const STALE_BADGE: BadgeSpec = { cls: 'b-warn', text: '豆包页面', icon: 'clock' };

/** 徽标选择：kind=none 时按「是否在豆包域内」细分（`docs/03` §15.6） */
function pageBadge(page: PageInfo | undefined): BadgeSpec {
  const kind = page?.kind;
  if (kind === 'chat' || kind === 'thread') return PAGE_BADGE[kind];
  return isDoubaoHostUrl(page?.url) ? BADGE_DOUBAO_NONCONV : PAGE_BADGE.none;
}

const KIND_LABEL: Record<string, string> = { video: '视频', image: '图片' };

function currentConfig() {
  return state?.config ?? { skipThumbOnly: true, theme: 'system' as const };
}

function convName(): string {
  return displayConvTitle(scope?.title || state?.page.title || '');
}

function statusLine(): { dot: string; text: string; ready: boolean } {
  if (errorText) return { dot: 'off', text: '无法连接扩展后台', ready: false };
  if (!state) return { dot: 'off', text: '正在读取页面状态…', ready: false };
  if (state.stale) return { dot: 'warn', text: '页面需刷新后生效', ready: false };
  if (state.page.kind === 'none') return { dot: 'off', text: '未检测到豆包对话或分享页面', ready: false };
  return { dot: 'ok', text: '已就绪 · 自动解析中', ready: true };
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '') || '—';
}

function sumSize(items: MediaItem[]): string {
  return fmtBytes(items.reduce((acc, item) => acc + (item.meta.size ?? 0), 0)) || '—';
}

interface ViewData {
  items: MediaItem[];
  deduped: number;
  counts: { total: number; video: number; image: number };
}

function viewData(): ViewData {
  /*
   * 非会话页闸门（2026-09-27 第八轮，防御层）：没有激活会话就没有条目。
   * 即使库里残留上个会话的条目（清库消息丢失等极端情况），也绝不在这里显示 ——
   * 「状态行说未检测到豆包对话或分享页面、列表却有视频」的自相矛盾不允许出现（`docs/03` §15）。
   * 副作用修正：chips 计数来自 `statsOf(全库)`，此前在 none 页会显示上个会话的数字。
   */
  if (!state || state.page.kind === 'none') {
    return { items: [], deduped: 0, counts: { total: 0, video: 0, image: 0 } };
  }
  // 单会话视图：groupBy 固定 'conv'（只有一个分组），这里直接把它摊平。
  const result = queryLibrary(library, { filter: prefs.filter, query: '', sort: prefs.sort, groupBy: 'conv' });
  const group = result.groups[0];
  return { items: group?.items ?? [], deduped: group?.deduped ?? 0, counts: result.counts };
}

/**
 * 模型药丸（2026-09-30 第十五轮）—— **视频卡片缩略图左下角**，位置在「时长」与「格式」之间。
 *
 * 文案是简称（`SD-2.5` / `2.0-Fast`…），由报文里的模型提示折算（`core/model-badge.ts`）；
 * 只有读出提示的条目才有这个药丸，读不到就不显示 —— **不编造模型名**。
 * 悬停给出该简称的含义。模型提示来自更早批次的报文，具体原始值见诊断页。
 */
function modelPill(item: MediaItem): string {
  const badge = item.meta.modelBadge;
  if (!badge) return '';
  return `<span class="pill pill-model" title="本次生成使用的模型：${esc(badge)}">${esc(badge)}</span>`;
}

/**
 * 模型药丸 · **列表视图**（2026-09-30 用户要求补）—— 列表行内、动作按钮**左边**。
 *
 * 与网格视图同一个值（`meta.modelBadge`），只是位置不同：网格视图在缩略图左下角（放得下三个药丸），
 * 列表视图缩略图仅 52px，故挪到卡片行里、按钮组之前。两处按视图二选一显示，不会重复出现。
 */
function listModelPill(item: MediaItem): string {
  const badge = item.meta.modelBadge;
  if (!badge) return '';
  return `<span class="list-model" title="本次生成使用的模型：${esc(badge)}">${esc(badge)}</span>`;
}

function cardHtml(item: MediaItem): string {
  const tag = STATE_TAG[item.state];
  const isSel = selected.has(item.id);
  const cover = item.cover
    ? `<img src="${esc(item.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : '';
  /*
   * 真实生成时间（2026-09-28 第十轮）：站点的 `create_time`。同一份文案渲染两次 ——
   *   ① 缩略图**左上角**的药丸（网格视图用，与左下角「时长 / 格式」药丸同一套视觉语言）；
   *   ② 卡片副信息行的前缀（列表视图用：缩略图只有 52px，放不下药丸）。
   * 两处由 CSS 按 `.grid-2` / `.list-mode` 二选一显示，不会重复出现。
   */
  const when = itemTimeLabel(item);
  const whenPill = when
    ? `<span class="pill thumb-when" title="作品真实生成时间">${esc(when)}</span>`
    : '';
  const whenMeta = when ? `<span class="meta-when">${esc(when)} · </span>` : '';
  /*
   * 「原片不可得 / 已超期」时给标签加悬停说明（2026-09-28）：标签本身只说结论，
   * 原因（原片只对作品所属账号开放 / 可能超出站点保存期）放在 title 里，不占卡片版面。
   */
  const tagTitle = stateTagTitle(item);

  return `<article class="card ${isSel ? 'sel' : ''}" data-id="${esc(item.id)}">
    <div class="thumb">
      ${cover}
      <span class="ph" ${cover ? 'hidden' : ''}>${icon(item.kind === 'video' ? 'play' : 'image')}</span>
      ${whenPill}
      <div class="thumb-ov">
        ${item.meta.duration ? `<span class="pill">${esc(fmtDuration(item.meta.duration))}</span>` : ''}
        ${modelPill(item)}
        <span class="pill ${item.kind === 'video' ? 'pill-fmt' : 'pill-fmt-img'}">${esc((item.meta.ext || 'bin').toUpperCase())}</span>
      </div>
      <div class="ck">${icon('check')}</div>
    </div>
    <div class="card-body">
      <div class="card-tags"><span class="tag ${tag.cls}"${tagTitle ? ` title="${esc(tagTitle)}"` : ''}>${icon(tag.icon)}${esc(stateTagLabel(item))}</span></div>
      <div class="card-meta" title="${esc(item.primary)}">${whenMeta}${esc(itemMetaLine(item))}</div>
      ${listModelPill(item)}
      <div class="card-actions">
        <button class="act" data-act="dl" data-id="${esc(item.id)}" title="下载无水印原片">${icon('dl')}下载</button>
        <button class="act" data-act="cp" data-id="${esc(item.id)}" title="复制无水印原片地址">${icon('copy')}复制</button>
        <button class="act" data-act="pv" data-id="${esc(item.id)}" title="在豆包页面上定位它，并唤起豆包自己的预览">${icon('play')}预览</button>
      </div>
    </div>
  </article>`;
}

/** 头部：品牌 + 全局动作（主题切换 / GitHub / 扩展管理页） */
function headHtml(): string {
  const dark = resolveTheme(currentConfig().theme) === 'dark';
  return `<header class="hd">
    <div class="hd-logo">${icon('logo')}</div>
    <div class="hd-title">
      <h1>${esc(EXT_NAME)}</h1>
      <p>doubao-web-uwd · v${esc(state?.version ?? '1.0.0')}</p>
    </div>
    <div class="hd-actions">
      <button class="icon-btn" data-act="toggle-theme"
        title="${dark ? '切换到浅色模式' : '切换到深色模式'}">${icon(dark ? 'sun' : 'moon', 'ic-sm')}</button>
      <button class="icon-btn" data-act="open-repo" ${REPO_URL ? '' : 'disabled'}
        title="${REPO_URL ? '打开 GitHub 仓库' : 'GitHub 仓库（发布后回填 REPO_URL 即可启用）'}">${icon('github', 'ic-sm')}</button>
      <button class="icon-btn" data-act="ext-manager" title="打开浏览器扩展管理页">${icon('gear', 'ic-sm')}</button>
    </div>
  </header>`;
}

/**
 * 会话卡：状态 + 会话名 + 页面类型 + URL + 合并重复数 + 更新时间。
 * 它是原来「弹窗状态卡」与「资源库会话头」的合并 —— 会话名与徽标在这里只出现一次。
 */
function sessHtml(items: MediaItem[], deduped: number): string {
  const { dot, text, ready } = statusLine();
  const page = state?.page;
  const badge = state?.stale ? STALE_BADGE : pageBadge(page);
  const latest = items.length ? Math.max(...items.map((item) => item.lastSeen)) : 0;

  return `<section class="sess">
    <span class="dot ${dot}"></span>
    <div class="sess-body">
      <div class="sess-l1">
        <span class="st-text">${esc(text)}</span>
        <span class="badge ${badge.cls}">${icon(badge.icon)}${esc(badge.text)}</span>
        ${ready ? `<span class="conv-title" title="${esc(convName())}">${esc(convName())}</span>` : ''}
      </div>
      <div class="sess-l2">
        <span class="st-url" title="${esc(page?.url ?? '')}">${esc(shortUrl(page?.url ?? ''))}</span>
        ${
          ready && deduped > 0
            ? `<span class="sep">·</span><span class="conv-dedup">${icon('merge', 'ic-sm')}合并 ${deduped} 条重复</span>`
            : ''
        }
        ${latest ? `<span class="sep">·</span><span class="conv-meta">${esc(fmtClock(latest))} 更新</span>` : ''}
      </div>
    </div>
  </section>`;
}

/** 工具条：筛选 chips（唯一计数）+ 全选（勾选框样式）+ 排序 + 视图 */
function toolsHtml(counts: ViewData['counts'], items: MediaItem[]): string {
  const chips = (['all', 'video', 'image'] as Filter[])
    .map((key) => {
      const count = key === 'all' ? counts.total : key === 'video' ? counts.video : counts.image;
      const label = key === 'all' ? '全部' : `${icon(key === 'video' ? 'play' : 'image', 'ic-sm')}${KIND_LABEL[key]}`;
      return `<button class="chip ${prefs.filter === key ? 'on' : ''}" data-filter="${key}">${label}<span class="n">${count}</span></button>`;
    })
    .join('');

  // 全选三态：未选 / 部分选中（横杠）/ 全选（勾）；作用范围 = 当前筛选结果
  const allSel = items.length > 0 && items.every((item) => selected.has(item.id));
  const someSel = items.some((item) => selected.has(item.id));
  const selall = counts.total
    ? `<button class="selall ${allSel ? 'on' : someSel ? 'some' : ''}" data-selall="1"
        title="${allSel ? '取消全选' : `全选${prefs.filter === 'all' ? '当前列表' : '当前筛选下的'} ${items.length} 项`}"
      ><span class="box">${allSel ? icon('check') : someSel ? '<i class="dash"></i>' : ''}</span>全选</button>`
    : '';

  return `<div class="tools">
    <div class="chips">${chips}</div>
    <div class="tb-right">
      ${selall}
      <select class="sel" data-role="sort" title="排序方式">
        <option value="newest" ${prefs.sort === 'newest' ? 'selected' : ''}>最新</option>
        <option value="oldest" ${prefs.sort === 'oldest' ? 'selected' : ''}>最早</option>
        <option value="largest" ${prefs.sort === 'largest' ? 'selected' : ''}>最大</option>
      </select>
      <div class="vw">
        <button class="${prefs.view === 'grid' ? 'on' : ''}" data-view="grid" title="网格">${icon('grid', 'ic-sm')}</button>
        <button class="${prefs.view === 'list' ? 'on' : ''}" data-view="list" title="列表">${icon('list', 'ic-sm')}</button>
      </div>
    </div>
  </div>`;
}

function emptyHtml(): string {
  if (errorText) {
    return `<div class="empty">
      <div class="empty-ic">${icon('alert')}</div>
      <h3>无法连接扩展后台</h3>
      <p>请尝试在扩展管理页重新加载本插件，或稍后重试。</p>
    </div>`;
  }
  if (state?.stale) {
    return `<div class="empty">
      <div class="empty-ic">${icon('refresh')}</div>
      <h3>等待页面刷新</h3>
      <p>插件已启用，但当前豆包页尚未注入脚本。按 F5 刷新后会自动开始解析无水印资源。</p>
    </div>`;
  }
  if (!state || state.page.kind === 'none') {
    return `<div class="empty">
      <div class="empty-ic">${icon('image')}</div>
      <h3>未检测到豆包对话或分享页面</h3>
      <p>资源库只显示<b>当前激活对话</b>解析到的资源。打开豆包对话页或分享链接页后会自动开始解析。</p>
    </div>`;
  }
  if (!Object.keys(library).length) {
    return `<div class="empty">
      <div class="empty-ic">${icon('image')}</div>
      <h3>当前会话暂无资源</h3>
      <p>在「${esc(convName())}」里生成视频或图片后，无水印资源会自动出现在这里。</p>
    </div>`;
  }
  return `<div class="empty">
    <div class="empty-ic">${icon('search')}</div>
    <h3>没有匹配的资源</h3>
    <p>当前会话里没有这个类型的资源，切换回「全部」看看。</p>
  </div>`;
}

/**
 * 底部左侧：下载中显示进度，其余时候显示**开发者信息**（2026-09-28 第十一轮调整）。
 *
 * 原先这里是常驻说明「只收录无水印原片 · 未解析到原片的条目不会入库」—— 该说明已不符合现况
 * （现在的结论是「原片已超期 / 原片不可得」这类如实状态，另见卡片标签），故撤掉；
 * 开发者信息从**头部移到这里**（头部只留品牌 + 版本 + 三个全局动作）。
 */
function footLeftHtml(): string {
  if (progress && (progress.total || progress.running)) {
    const finished = progress.done + progress.failed;
    const percent = progress.total ? Math.round((finished / progress.total) * 100) : 0;
    const label =
      progress.running > 0
        ? `下载中 ${Math.min(finished + 1, progress.total)}/${progress.total}`
        : progress.failed > 0
          ? `完成 ${progress.done} 项 · 失败 ${progress.failed} 项`
          : `已下载 ${progress.done} 项`;
    return `<span class="ft-prog"><span>${esc(label)}</span><span class="bar"><i style="width:${percent}%"></i></span></span>`;
  }
  const authorText = `开发者：${AUTHOR_BILI_NAME}（uid ${AUTHOR_BILI_UID}）`;
  return `<span class="ft-author" title="${esc(authorText)}">开发者：<a href="https://space.bilibili.com/${esc(AUTHOR_BILI_UID)}" target="_blank" rel="noreferrer">${esc(AUTHOR_BILI_NAME)}</a>（uid ${esc(AUTHOR_BILI_UID)}）</span>`;
}

function render(): void {
  document.documentElement.dataset.theme = resolveTheme(currentConfig().theme);

  const { items, deduped, counts } = viewData();
  const selectedItems = Object.values(library).filter((item) => selected.has(item.id));

  root.innerHTML = `
    ${headHtml()}
    ${sessHtml(items, deduped)}
    ${toolsHtml(counts, items)}
    <div class="list">
      ${items.length ? `<div class="grid-wrap ${prefs.view === 'list' ? 'list-mode' : 'grid-2'}">${items.map(cardHtml).join('')}</div>` : emptyHtml()}
    </div>
    ${
      selected.size
        ? `<div class="batch">
            <span class="batch-info">已选 <b>${selected.size}</b> 项 · <span class="batch-sum">${sumSize(selectedItems)}</span></span>
            <button class="btn sm ghost" data-act="clear-sel">取消</button>
            <button class="btn sm primary" data-act="dl">${icon('dl', 'ic-sm')}下载</button>
            <button class="btn sm" data-act="batch-copy">${icon('copy', 'ic-sm')}复制</button>
          </div>`
        : ''
    }
    <footer class="ft">
      ${footLeftHtml()}
      <button class="link-btn" data-act="debug" title="解析不到资源时，打开诊断页取证">${icon('term', 'ic-sm')}诊断</button>
    </footer>`;

  root.querySelectorAll<HTMLImageElement>('.list img').forEach((img) => {
    img.addEventListener('error', () => img.remove());
  });
}

/* --------------------------------------------------------------------------- */
/* 数据刷新                                                                      */
/* --------------------------------------------------------------------------- */

async function refreshState(): Promise<void> {
  try {
    state = await getState();
    errorText = '';
  } catch (error) {
    errorText = String((error as Error)?.message ?? error);
  }
}

async function refreshLibrary(): Promise<void> {
  try {
    // `library:list` 在 background 侧会先对齐一次会话作用域再取库，
    // 所以这里的 library / scope 一定是「当前激活会话」的。
    const response = await listLibrary();
    library = response.library;
    scope = response.scope ?? null;
    if (state) state.config = response.config;
    pruneSelection();
  } catch {
    /* 后台未就绪时保持原数据 */
  }
}

/** 会话切换会清空其它会话的记录 → 选中集合里可能留有已消失的 id */
function pruneSelection(): void {
  for (const id of [...selected]) {
    if (!library[id]) selected.delete(id);
  }
}

/* --------------------------------------------------------------------------- */
/* 交互                                                                          */
/* --------------------------------------------------------------------------- */

function toggleSelect(ids: string[], value?: boolean): void {
  if (!ids.length) return;
  const shouldSelect = value ?? !ids.every((id) => selected.has(id));
  for (const id of ids) {
    if (shouldSelect) selected.add(id);
    else selected.delete(id);
  }
  render();
}

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;

  const view = target.closest<HTMLElement>('[data-view]');
  if (view) {
    prefs.view = view.dataset.view === 'list' ? 'list' : 'grid';
    savePrefs();
    render();
    return;
  }

  const filter = target.closest<HTMLElement>('[data-filter]');
  if (filter) {
    prefs.filter = (filter.dataset.filter as Filter) ?? 'all';
    savePrefs();
    render();
    return;
  }

  // 全选 = 当前筛选下的全部条目
  if (target.closest<HTMLElement>('[data-selall]')) {
    toggleSelect(viewData().items.map((item) => item.id));
    return;
  }

  const act = target.closest<HTMLElement>('[data-act]');
  if (act) {
    event.stopPropagation();
    const action = act.dataset.act ?? '';
    const id = act.dataset.id;
    const selectedIds = [...selected];

    switch (action) {
      case 'dl':
        void runDownload(id ? [id] : selectedIds);
        return;
      case 'cp':
        void runCopy(id ? [id] : selectedIds);
        return;
      case 'pv': {
        const item = id ? viewData().items.find((entry) => entry.id === id) : undefined;
        if (item) void runPreview(item);
        return;
      }
      case 'batch-copy':
        void runCopy(selectedIds);
        return;
      case 'clear-sel':
        selected.clear();
        render();
        return;
      case 'toggle-theme':
        void toggleTheme();
        return;
      case 'open-repo':
        openRepo();
        return;
      case 'ext-manager':
        openExtensionManager();
        return;
      case 'debug':
        openDebugPage();
        return;
      default:
        return;
    }
  }

  // 其余点击落在卡片上 → 切换选中
  const card = target.closest<HTMLElement>('.card');
  if (card?.dataset.id) toggleSelect([card.dataset.id]);
});

root.addEventListener('change', (event) => {
  const target = event.target as HTMLSelectElement;
  if (target.dataset.role !== 'sort') return;
  prefs.sort = (target.value as Sort) ?? 'newest';
  savePrefs();
  render();
});

/* --------------------------------------------------------------------------- */
/* 动作                                                                          */
/* --------------------------------------------------------------------------- */

async function runDownload(ids: string[]): Promise<void> {
  if (!ids.length) {
    toast('请先选择资源', true);
    return;
  }
  const result = await requestDownload({ ids });
  if (!result.ok) {
    toast(result.error ?? '下载失败', true);
    return;
  }
  selected.clear();
  render();
  toast(`已加入下载队列：${result.queued} 项`);
}

async function runCopy(ids: string[]): Promise<void> {
  if (!ids.length) {
    toast('请先选择资源', true);
    return;
  }
  const urls = ids.map((id) => library[id]?.primary).filter((url): url is string => Boolean(url));
  if (!urls.length) {
    toast('没有可复制的地址', true);
    return;
  }
  const ok = await copyText(urls.join('\n'));
  toast(ok ? `已复制 ${urls.length} 条原片地址` : '复制失败', !ok);
}

/**
 * 「预览」：在**页面**里定位这条资源，并尽力唤起豆包自己的预览（2026-09-28 第十轮）。
 *
 * 用户拍板的口径：插件不自己造播放器 —— 资源库的「预览」就是**调用豆包页面的同一功能**
 * （弹豆包自己的预览侧栏），插件只当「和豆包网页一样的功能入口」。
 * 页面侧做法：按路径 hash 找到媒体元素 → 滚动到视口中央 → 尽力派发一次完整指针序列的点击
 * （站点若校验事件可信度就点不动，那时目标已在眼前，用户手点一下即可）。
 * 定位失败（豆包消息列表懒渲染，旧消息没滚到就不在 DOM 里）→ 如实提示，不假装成功。
 */
async function runPreview(item: MediaItem): Promise<void> {
  const keys = mediaLookupKeys([
    item.primary,
    item.cover ?? '',
    ...item.variants.map((variant) => variant.url),
  ]);
  if (!keys.length) {
    toast('这条资源没有可用于定位的地址', true);
    return;
  }
  const res = await locateInPage(keys);
  if (res.found) {
    window.close(); // 让出画面给豆包的预览侧栏
    return;
  }
  toast(res.error ? `定位失败：${res.error}` : '未能在页面里定位到它（旧消息要滚动加载后才会出现）', true);
}

/** 深浅色切换（写 `theme` 显式值；不再跟随系统，点一下就固定住） */
async function toggleTheme(): Promise<void> {
  const next = resolveTheme(currentConfig().theme) === 'dark' ? 'light' : 'dark';
  if (state) state.config = { ...state.config, theme: next };
  render();
  try {
    const config = await patchConfig({ theme: next });
    if (state) state.config = config;
  } catch {
    toast('主题保存失败', true);
  }
  render();
}

/** GitHub 仓库入口（`REPO_URL` 回填前按钮置灰，见 core/constants.ts） */
function openRepo(): void {
  if (!REPO_URL) return;
  void chrome.tabs.create({ url: REPO_URL });
}

/* --------------------------------------------------------------------------- */
/* 订阅                                                                          */
/* --------------------------------------------------------------------------- */

onLibraryChanged((next) => {
  library = next;
  pruneSelection();
  render();
});

onConfigChanged((config) => {
  if (state) state.config = config;
  render();
});

onProgress((next) => {
  progress = next;
  render();
  if (next.running > 0) {
    downloadActive = true;
    return;
  }
  if (downloadActive && next.total > 0 && next.done + next.failed >= next.total) {
    downloadActive = false;
    if (next.failed > 0) toast(`完成 ${next.done} 项，失败 ${next.failed} 项`, true);
    else toast(`已下载 ${next.done} 项`);
  }
});

watchSystemTheme(() => currentConfig().theme, render);

/* --------------------------------------------------------------------------- */
/* 启动                                                                          */
/* --------------------------------------------------------------------------- */

void (async () => {
  await Promise.all([refreshState(), refreshLibrary()]);
  render();
})();
