/**
 * 配置与资源库的持久化层（`chrome.storage.local`）。
 *
 * 设计要点（对应实施方案 §4.2）：
 * - 所有写入都经过本文件，统一触发 `chrome.storage.onChanged`，各界面订阅同一事件刷新，
 *   **不使用轮询**（施工守则 4）。
 * - 首启动写入 `schemaVersion`；**不迁移上游旧键**，但在 `onInstalled` 时**清理**它们。
 * - 归一化函数是纯函数，便于单测；带 `chrome` 调用的函数是薄壳。
 */

import { DEFAULT_CONFIG, SCHEMA_VERSION, STORAGE } from './constants';
import { LEGACY_STORAGE_KEYS, convIdFromUrl } from './site-contract';
import type { Config, MediaItem } from './types';

/** 一个**标签页槽**：该标签页的资源库（内部语义与第四轮完全一致 = 只管当前会话） */
export type Library = Record<string, MediaItem>;

/**
 * 资源库：**按标签页分槽**（2026-10-02 §38 多标签页修复）。
 *
 * 为什么必须分槽：第四轮定义的「资源库 == 当前激活会话、切走即清」在**单标签页**下完全正确，
 * 但存储是**全局单槽** —— 多标签页同时开着时，任何一个标签页的会话上报 / 弹窗取库都会
 * `retainConv()` 把**别的标签页**刚解析出来的条目删掉（实机：开三个豆包标签页来回切 →
 * 三边全空；诊断 `uwd-diag-1790925989845` 实证 14 次作用域翻转、20 条草稿被丢）。
 *
 * 现在的模型：`tabId → 槽`。**内层逻辑一字未改**（`retainConv` / `rekeyConv` /
 * `filterDraftsByConv` 照旧），只是作用范围从「全局」缩小到「一个标签页」——
 * 于是「切走即清」只清自己，别的标签页互不影响。
 * 槽的删除只发生在：**关标签页**、该标签页**离开会话**（导航到非会话页）、
 * 以及**浏览器重启后的对账**（旧 tabId 已失效）。
 */
export type LibrarySlots = Record<string, Library>;

export interface StateSnapshot {
  config: Config;
  library: LibrarySlots;
  schemaVersion: number;
}

/* --------------------------------------------------------------------------- */
/* 纯函数：归一化                                                               */
/* --------------------------------------------------------------------------- */

export function normalizeConfig(raw: unknown): Config {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const theme = src.theme;
  return {
    // ⚠️ 历史键一律忽略（不迁移、不继承）：
    //   - `replacePreview`（预览与下载改用无水印原片）—— 第三轮 K4 起被
    //     `showImageDownloadButton` 取代；
    //   - `showImageDownloadButton`（显示隐藏的图片下载按钮）—— 第四轮收尾时**整体删除**，
    //     因为该注入按钮从未生效，且早年注入在左下角时会遮挡豆包原生的图片下载入口。
    //   两者语义都已不存在，读到时直接丢弃即可（normalizeConfig 只取下面这几个键）。
    skipThumbOnly: typeof src.skipThumbOnly === 'boolean' ? src.skipThumbOnly : DEFAULT_CONFIG.skipThumbOnly,
    theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : DEFAULT_CONFIG.theme,
  };
}

function isMediaItem(value: unknown): value is MediaItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.convId === 'string' &&
    typeof v.fingerprint === 'string' &&
    (v.kind === 'video' || v.kind === 'image') &&
    typeof v.primary === 'string' &&
    Array.isArray(v.variants)
  );
}

/** 丢弃形状不完整的条目（例如上个版本残留或手工改坏的数据），保证 UI 永远不会读到脏数据 */
export function normalizeLibrary(raw: unknown): Library {
  if (!raw || typeof raw !== 'object') return {};
  const out: Library = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isMediaItem(value)) out[key] = value;
  }
  return out;
}

/**
 * 归一化**分槽资源库**：每个槽内部过一遍 `normalizeLibrary`（形状不对的条目丢弃、
 * 空槽丢掉）。槽键是 tabId 的字符串形式 —— 不做数字校验（`chrome.tabs` 的 id 是数字，
 * 但存储里只当字符串用，免得来回转换）。
 */
export function normalizeLibrarySlots(raw: unknown): LibrarySlots {
  if (!raw || typeof raw !== 'object') return {};
  const out: LibrarySlots = {};
  for (const [tabKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const slot = normalizeLibrary(value);
    if (Object.keys(slot).length) out[tabKey] = slot;
  }
  return out;
}

/**
 * **v2 → v3 迁移**（单库 → 分槽）：把旧的全局库按「仍开着的豆包标签页 URL」**尽力归位**。
 *
 * 归位规则：条目 `convId` 与某个打开着的标签页 URL 反推出的会话一致 → 放进那个槽；
 * 没有标签页承载它 → **丢弃**（该会话此刻没被浏览，条目会由页面重新解析恢复：
 * 对话页 chain 重放 ~10s，分享页需要 F5 一次）。
 * 纯函数（标签页清单由调用方注入），便于单测。
 */
export function slotsFromLegacyLibrary(
  library: Library,
  tabs: ReadonlyArray<{ tabId: number; url: string }>,
): LibrarySlots {
  const out: LibrarySlots = {};
  const byConv = new Map<string, string>();
  for (const tab of tabs) {
    const convId = convIdFromUrl(tab.url);
    if (convId && !byConv.has(convId)) byConv.set(convId, String(tab.tabId));
  }
  for (const [id, item] of Object.entries(library)) {
    const tabKey = byConv.get(item.convId);
    if (!tabKey) continue;
    (out[tabKey] ??= {})[id] = item;
  }
  return out;
}

export function normalizeSchemaVersion(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : SCHEMA_VERSION;
}

/**
 * schema v1 → v2 的一次性清理：**丢掉库里图片条目的 `meta.size`**（2026-09-28）。
 *
 * 缘由：图片体积原先可能来自报文里 image 子对象的 `size`，而那个数字与「真正能下载到的文件」
 * **不是同一个字节数**（实机反例：卡片 378 KB ↔ 实际下载 3.81 MB 的 PNG）。现在图片体积
 * 只由 background 实测 `primary` 得到；旧值必须先清掉 —— 否则后续合并（`metaMerge` 只覆盖
 * 「有值」的字段，而新草稿不再带 size）会让错数字永远粘住。
 *
 * 纯函数，便于单测。视频条目**不动**（创作树节点的 `size` 已验证与落盘原片一致）。
 */
export function dropStaleImageSizes(library: Library): { library: Library; changed: boolean } {
  let changed = false;
  const next: Library = { ...library };
  for (const [id, item] of Object.entries(next)) {
    if (item.kind !== 'image' || item.meta.size === undefined) continue;
    const meta = { ...item.meta };
    delete meta.size;
    next[id] = { ...item, meta };
    changed = true;
  }
  return { library: next, changed };
}

/* --------------------------------------------------------------------------- */
/* chrome.storage 薄壳                                                          */
/* --------------------------------------------------------------------------- */

function area(): chrome.storage.StorageArea {
  return chrome.storage.local;
}

export async function readState(): Promise<StateSnapshot> {
  const data = (await area().get([STORAGE.config, STORAGE.library, STORAGE.schemaVersion])) as Record<string, unknown>;
  return {
    config: normalizeConfig(data[STORAGE.config]),
    library: normalizeLibrarySlots(data[STORAGE.library]),
    schemaVersion: normalizeSchemaVersion(data[STORAGE.schemaVersion]),
  };
}

export async function readConfig(): Promise<Config> {
  const data = (await area().get(STORAGE.config)) as Record<string, unknown>;
  return normalizeConfig(data[STORAGE.config]);
}

export async function readLibrarySlots(): Promise<LibrarySlots> {
  const data = (await area().get(STORAGE.library)) as Record<string, unknown>;
  return normalizeLibrarySlots(data[STORAGE.library]);
}

export async function writeConfig(config: Config): Promise<void> {
  await area().set({ [STORAGE.config]: config });
}

export async function patchConfig(patch: Partial<Config>): Promise<Config> {
  const current = await readConfig();
  const next = normalizeConfig({ ...current, ...patch });
  await writeConfig(next);
  return next;
}

export async function writeLibrarySlots(slots: LibrarySlots): Promise<void> {
  await area().set({ [STORAGE.library]: slots });
}

/**
 * 安装 / 启动时的迁移与清理。
 * - 补写 schemaVersion
 * - **v1 → v2**：清掉库里图片条目的旧体积（见 `dropStaleImageSizes`），改由实测重新量
 * - **v2 → v3**：**单库 → 按标签页分槽**（§38 多标签页修复）—— 旧条目按仍开着的
 *   豆包标签页 URL 尽力归位（见 `slotsFromLegacyLibrary`），归不上的丢弃（会重新解析）
 * - 清掉上游遗留键（不迁移其内容，只释放配额）
 * 幂等，可被多个上下文重复调用。
 */
export async function migrate(): Promise<void> {
  const data = (await area().get([STORAGE.schemaVersion, STORAGE.config, STORAGE.library, ...LEGACY_STORAGE_KEYS])) as Record<
    string,
    unknown
  >;

  // 存的是原始值（`normalizeSchemaVersion` 会把「缺失」也归成当前版本，判不出升级）
  const storedVersion = typeof data[STORAGE.schemaVersion] === 'number' ? (data[STORAGE.schemaVersion] as number) : null;

  const writes: Record<string, unknown> = {};
  if (normalizeSchemaVersion(data[STORAGE.schemaVersion]) !== SCHEMA_VERSION || data[STORAGE.schemaVersion] === undefined) {
    writes[STORAGE.schemaVersion] = SCHEMA_VERSION;
  }
  if (data[STORAGE.config] === undefined) writes[STORAGE.config] = DEFAULT_CONFIG;
  if (data[STORAGE.library] === undefined) writes[STORAGE.library] = {};

  // 升级路径：v1 先清图片旧体积（v2 的语义），再统一进 v3 的分槽结构
  if (storedVersion !== null && storedVersion < SCHEMA_VERSION) {
    let legacy = normalizeLibrary(data[STORAGE.library]);
    if (storedVersion < 2) {
      const cleaned = dropStaleImageSizes(legacy);
      legacy = cleaned.library;
      if (cleaned.changed) console.info('[UWD] schema v1→v2：已清掉图片条目的旧体积（改由实测重新量）');
    }
    const tabs = await queryDoubaoTabs();
    const slots = slotsFromLegacyLibrary(legacy, tabs);
    writes[STORAGE.library] = slots;
    const kept = Object.values(slots).reduce((sum, slot) => sum + Object.keys(slot).length, 0);
    console.info(
      `[UWD] schema <3 → v3：资源库改为按标签页分槽，旧条目归位 ${kept} 条` +
        `（未归位的已丢弃，会由页面重新解析恢复；分享页需 F5 一次）`,
    );
  }

  if (Object.keys(writes).length) await area().set(writes);

  const staleLegacy = LEGACY_STORAGE_KEYS.filter((key) => data[key] !== undefined);
  if (staleLegacy.length) {
    await area().remove([...staleLegacy]);
    console.info('[UWD] 已清理上游遗留存储键:', staleLegacy.join(', '));
  }
}

/** 收集当前打开着的豆包页（迁移归位用；拿不到标签页信息时返回空清单 = 全部丢弃） */
async function queryDoubaoTabs(): Promise<Array<{ tabId: number; url: string }>> {
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.doubao.com/*', '*://*.dola.com/*'] });
    const out: Array<{ tabId: number; url: string }> = [];
    for (const tab of tabs) {
      if (typeof tab.id === 'number' && tab.url) out.push({ tabId: tab.id, url: tab.url });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 订阅 storage 变更。回调里只给出**真正变化**的字段。
 * 返回取消订阅函数。
 *
 * ⚠️ 2026-10-02 §38：`library` 现在是**分槽结构**（tabId → 槽），UI 侧没有 tabId
 * （它只知道「当前活动标签页」），所以**库的实时刷新不再走这条通道** ——
 * 改由 bg 主动广播「当前槽」（`MSG.LibrarySync`，见 `ui/shared/api.ts::onLibrarySync`）。
 * 这里仍保留 `library` 字段仅供 bg 同步自己的缓存。
 */
export function onStateChanged(
  handler: (change: { config?: Config; library?: LibrarySlots; schemaVersion?: number }) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'local') return;
    const out: { config?: Config; library?: LibrarySlots; schemaVersion?: number } = {};
    if (changes[STORAGE.config]) out.config = normalizeConfig(changes[STORAGE.config].newValue);
    if (changes[STORAGE.library]) out.library = normalizeLibrarySlots(changes[STORAGE.library].newValue);
    if (changes[STORAGE.schemaVersion]) out.schemaVersion = normalizeSchemaVersion(changes[STORAGE.schemaVersion].newValue);
    if (Object.keys(out).length) handler(out);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
