/** UI 侧对 background 的调用封装（全部走 core/messaging 信封，禁止裸传字符串） */

import { MSG } from '../../core/constants';
import type { DiagRecord } from '../../core/diagnostics';
import { onRuntimeMessage, sendToBg } from '../../core/messaging';
import { onStateChanged, type Library } from '../../core/storage';
import type {
  Config,
  DownloadProgress,
  DownloadRequest,
  LibraryResponse,
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

export async function listLibrary(): Promise<LibraryResponse> {
  return sendToBg<LibraryResponse>(MSG.LibraryList);
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

export function onDiagChanged(handler: () => void): () => void {
  return onRuntimeMessage((env) => {
    if (env.type !== MSG.DiagChanged) return undefined;
    handler();
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

export function onLibraryChanged(handler: (library: Library) => void): () => void {
  return onStateChanged((change) => {
    if (change.library) handler(change.library);
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
