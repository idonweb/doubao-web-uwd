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
import { LEGACY_STORAGE_KEYS } from './site-contract';
import type { Config, MediaItem } from './types';

export type Library = Record<string, MediaItem>;

export interface StateSnapshot {
  config: Config;
  library: Library;
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
    library: normalizeLibrary(data[STORAGE.library]),
    schemaVersion: normalizeSchemaVersion(data[STORAGE.schemaVersion]),
  };
}

export async function readConfig(): Promise<Config> {
  const data = (await area().get(STORAGE.config)) as Record<string, unknown>;
  return normalizeConfig(data[STORAGE.config]);
}

export async function readLibrary(): Promise<Library> {
  const data = (await area().get(STORAGE.library)) as Record<string, unknown>;
  return normalizeLibrary(data[STORAGE.library]);
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

export async function writeLibrary(library: Library): Promise<void> {
  await area().set({ [STORAGE.library]: library });
}

/**
 * 安装 / 启动时的迁移与清理。
 * - 补写 schemaVersion
 * - **v1 → v2**：清掉库里图片条目的旧体积（见 `dropStaleImageSizes`），改由实测重新量
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

  if (storedVersion !== null && storedVersion < SCHEMA_VERSION) {
    const cleaned = dropStaleImageSizes(normalizeLibrary(data[STORAGE.library]));
    if (cleaned.changed) {
      writes[STORAGE.library] = cleaned.library;
      console.info('[UWD] schema v1→v2：已清掉图片条目的旧体积（改由实测重新量）');
    }
  }

  if (Object.keys(writes).length) await area().set(writes);

  const staleLegacy = LEGACY_STORAGE_KEYS.filter((key) => data[key] !== undefined);
  if (staleLegacy.length) {
    await area().remove([...staleLegacy]);
    console.info('[UWD] 已清理上游遗留存储键:', staleLegacy.join(', '));
  }
}

/**
 * 订阅 storage 变更。回调里只给出**真正变化**的字段。
 * 返回取消订阅函数。
 */
export function onStateChanged(
  handler: (change: { config?: Config; library?: Library; schemaVersion?: number }) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'local') return;
    const out: { config?: Config; library?: Library; schemaVersion?: number } = {};
    if (changes[STORAGE.config]) out.config = normalizeConfig(changes[STORAGE.config].newValue);
    if (changes[STORAGE.library]) out.library = normalizeLibrary(changes[STORAGE.library].newValue);
    if (changes[STORAGE.schemaVersion]) out.schemaVersion = normalizeSchemaVersion(changes[STORAGE.schemaVersion].newValue);
    if (Object.keys(out).length) handler(out);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
