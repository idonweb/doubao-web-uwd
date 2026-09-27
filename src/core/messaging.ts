/**
 * 跨上下文消息封装（对应实施方案 §5）。
 *
 * 硬性约束（施工守则 5）：**所有跨世界 / 跨页面消息必须走本文件**，
 * 统一 `{ v, src, type, payload }` 信封并做校验。
 * 上游的反例：popup 发 `set-enabled`、background 只认 `toggle-enabled`，消息无人处理 →
 * 总开关静默失效，且没有任何地方能发现。
 */

import type { Envelope, SrcTag } from './types-msg';

export const ENVELOPE_VERSION = 1;

const SRC_TAGS: readonly SrcTag[] = ['page', 'content', 'ui', 'bg'];

/** 构造信封。payload 为 undefined 时不写入该字段，保持信封最小化。 */
export function envelope<T = unknown>(src: SrcTag, type: string, payload?: T): Envelope<T> {
  const env: Envelope<T> = { v: ENVELOPE_VERSION, src, type };
  if (payload !== undefined) env.payload = payload;
  return env;
}

/** 严格校验：只认本扩展的信封形状。用于 window 通道（页面上可能有别的脚本在 postMessage）。 */
export function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === ENVELOPE_VERSION &&
    typeof v.type === 'string' &&
    v.type.length > 0 &&
    typeof v.src === 'string' &&
    (SRC_TAGS as readonly string[]).includes(v.src)
  );
}

/* ============================================================================
 * 通道一：MAIN world ↔ ISOLATED world（window.postMessage）
 * ========================================================================== */

export function postToWindow<T>(env: Envelope<T>, target: Window = window): void {
  target.postMessage(env, '*');
}

/** 订阅 window 通道消息，返回取消订阅函数。 */
export function onWindowMessage(handler: (env: Envelope<unknown>) => void): () => void {
  const listener = (event: MessageEvent) => {
    if (event.source !== window) return;
    if (!isEnvelope(event.data)) return;
    handler(event.data);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/* ============================================================================
 * 通道二：扩展内部（chrome.runtime.sendMessage）
 * ========================================================================== */

export function hasRuntime(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

export interface RuntimeHandler {
  (
    env: Envelope<unknown>,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | void;
}

/**
 * 订阅 runtime 消息。handler 返回 `true` 表示将异步回复。
 * 返回取消订阅函数。
 */
export function onRuntimeMessage(handler: RuntimeHandler): () => void {
  const listener = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    if (!isEnvelope(message)) return undefined;
    return handler(message, sender, sendResponse);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/** 向 background / 扩展页发消息。接收方不存在时抛错（调用方自行决定是否吞掉）。 */
export async function sendToBg<TRes = unknown>(
  type: string,
  payload?: unknown,
  src: SrcTag = 'ui',
): Promise<TRes> {
  if (!hasRuntime()) throw new Error('扩展上下文不可用');
  const env = envelope(src, type, payload);
  const res = (await chrome.runtime.sendMessage(env)) as TRes;
  return res;
}

/** 向指定标签页的 content script 发消息。无接收方时抛错。 */
export async function sendToTab<TRes = unknown>(
  tabId: number,
  type: string,
  payload?: unknown,
): Promise<TRes> {
  const env = envelope('bg', type, payload);
  return (await chrome.tabs.sendMessage(tabId, env)) as TRes;
}

/**
 * 尽力而为地发送，失败返回 null（用于「接收方可能不存在」的场景，
 * 例如探测内容脚本是否已注入 —— 这正是 popup「豆包页待刷新」状态的判定依据）。
 */
export async function trySendToTab<TRes = unknown>(
  tabId: number,
  type: string,
  payload?: unknown,
  timeoutMs = 800,
): Promise<TRes | null> {
  try {
    const env = envelope('bg', type, payload);
    return (await Promise.race([
      chrome.tabs.sendMessage(tabId, env) as Promise<TRes>,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ])) as TRes | null;
  } catch {
    return null;
  }
}

/** background 广播给所有扩展页（popup / 侧边栏）。没有接收方时静默失败。 */
export function broadcast(type: string, payload?: unknown): void {
  try {
    /*
     * ⚠️ MV3 无回调时 `chrome.runtime.sendMessage` 返回 Promise；弹窗未打开时
     * 它会**异步** reject（"Could not establish connection. Receiving end does not exist."）。
     * 同步 try/catch 接不住异步 reject，必须显式挂 .catch —— 否则每次广播都会在
     * service worker 里留下一条「Uncaught (in promise)」，Edge 的扩展错误页会报「发现问题」。
     */
    void Promise.resolve(chrome.runtime.sendMessage(envelope('bg', type, payload)) as Promise<void>).catch(() => {
      /* 没有打开任何扩展页 —— 这正是本函数「静默失败」的语义 */
    });
  } catch {
    /* 扩展上下文正在关闭等同步异常，忽略 */
  }
}

/** 从 payload 里安全取值（消息校验失败时返回 undefined，而不是让业务代码崩） */
export function payloadOf<T>(env: Envelope<unknown>): T | undefined {
  return env.payload as T | undefined;
}
