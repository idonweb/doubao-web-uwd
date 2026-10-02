/** UI 侧对 background 的调用封装（全部走 core/messaging 信封，禁止裸传字符串） */

import { MSG } from '../../core/constants';
import type { DiagRecord } from '../../core/diagnostics';
import { onRuntimeMessage, sendToBg } from '../../core/messaging';
import { onStateChanged } from '../../core/storage';
import type {
  Config,
  DiagChangedPayload,
  DownloadProgress,
  DownloadRequest,
  LibraryResponse,
  LibrarySyncPayload,
  LibraryRequest,
  StateRequest,
  StateResponse,
} from '../../core/types';

export async function getState(request?: StateRequest): Promise<StateResponse> {
  return sendToBg<StateResponse>(MSG.StateGet, request);
}

export async function patchConfig(patch: Partial<Config>): Promise<Config> {
  const res = await sendToBg<{ ok: boolean; config: Config }>(MSG.ConfigPatch, patch);
  return res.config;
}

export async function listLibrary(request?: LibraryRequest): Promise<LibraryResponse> {
  return sendToBg<LibraryResponse>(MSG.LibraryList, request);
}

export async function requestDownload(request: DownloadRequest): Promise<{ ok: boolean; queued: number; error?: string }> {
  return sendToBg<{ ok: boolean; queued: number; error?: string }>(MSG.DownloadMany, request);
}

/* --------------------------------------------------------------------------- */
/* 诊断（真机联调）                                                              */
/* --------------------------------------------------------------------------- */

export async function getDiag(): Promise<DiagRecord[]> {
  const res = await sendToBg<{ records: DiagRecord[] }>(MSG.DiagGet);
  return res.records ?? [];
}

export async function clearDiag(): Promise<void> {
  await sendToBg(MSG.DiagClear);
}

export function onDiagChanged(handler: (info: DiagChangedPayload) => void): () => void {
  return onRuntimeMessage((env) => {
    if (env.type !== MSG.DiagChanged) return undefined;
    handler((env.payload ?? {}) as DiagChangedPayload);
    return undefined;
  });
}

/** 打开诊断页（真机联调用；不常驻任何入口） */
export function openDebugPage(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('ui/debug.html') });
}

/* --------------------------------------------------------------------------- */
/* 订阅                                                                          */
/* --------------------------------------------------------------------------- */

export function onProgress(handler: (progress: DownloadProgress) => void): () => void {
  return onRuntimeMessage((env) => {
    if (env.type !== MSG.DownloadProgress) return undefined;
    handler(env.payload as DownloadProgress);
    return undefined;
  });
}

/**
 * 订阅「当前标签页槽」的资源库变化（2026-10-02 §38）。
 *
 * ⚠️ 不能再订阅 `storage.onChanged` 的 `library`：那已经是**分槽结构**（tabId → 槽），
 * 而 UI（扩展页）没有 tabId。bg 在写槽后会主动广播「当前槽」，弹窗是单例，直接采用即可。
 */
export function onLibrarySync(handler: (payload: LibrarySyncPayload) => void): () => void {
  return onRuntimeMessage((env) => {
    if (env.type !== MSG.LibrarySync) return undefined;
    const payload = env.payload as LibrarySyncPayload | undefined;
    if (payload && payload.library && typeof payload.convId === 'string') handler(payload);
    return undefined;
  });
}

export function onConfigChanged(handler: (config: Config) => void): () => void {
  return onStateChanged((change) => {
    if (change.config) handler(change.config);
  });
}

/**
 * 在页面里定位这条资源并尽力唤起豆包自己的预览（2026-09-28 第十轮）。
 *
 * `keys` = `mediaLookupKeys()` 产出的**路径 hash**（条目的 primary / variants / 封面都能给）。
 * 返回 `found`：页面 DOM 里是否找到了它 —— 豆包消息列表是**懒渲染**的，
 * 没滚到的旧消息不在 DOM 里，此时如实返回 false，由弹窗提示用户先滚动加载。
 */
export async function locateInPage(keys: string[]): Promise<{ found: boolean; error?: string }> {
  return sendToBg<{ found: boolean; error?: string }>(MSG.PreviewLocate, { keys });
}
