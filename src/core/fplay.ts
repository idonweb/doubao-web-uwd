/**
 * 分享页「无水印视频」—— fplay 改写 + qAAB 解密。**全部是纯函数 / 纯异步函数**（配 vitest 单测）。
 *
 * 契约来源见 `site-contract` §2.9（实测记录 `docs/03` §47.9~§47.11）。一句话链路：
 *
 *   fallback_api（`/thread/` 页面里就有；`/video-sharing` 要先调 `get_video_model`）
 *     → buildFplayUrl(quality)   ← 删 logo_type/force_fids，再设 codec_type
 *     → GET  → readFplayKeySeed() / readFplayTokens()
 *     → decodeQaabToken()        ← AES-128-CBC + SHA-512 KDF（WebCrypto）
 *     → 明文直链（**带时效签名，只能现解现用，不许入库**）
 *
 * ⚠️ 失败一律返回空串 / null（**宁缺勿假**）—— 调用方据此回退，绝不猜一个地址出来。
 */

import {
  FPLAY_CODEC_HEAVY,
  FPLAY_CODEC_LIGHT,
  FPLAY_DROP_PARAMS,
  FPLAY_FORCE_FIDS_ORIGINAL,
  FPLAY_HOST_SUFFIX,
  FPLAY_KDF_SALT_HEX,
  FPLAY_KEY_SEED_KEY,
  FPLAY_PATH_PREFIX,
  FPLAY_RESPONSE_DATA_PATH,
  FPLAY_TOKEN_PREFIX,
  FPLAY_VIDEO_LIST_KEY,
  FPLAY_VIDEO_URL_KEYS,
} from './site-contract';

import type { ShareQuality } from './types';

/** 分享页可选的档位：轻量（默认）/ 高画质（原画质）—— 类型定义在 `types.ts`（跨模块共享） */
export type { ShareQuality };

/* --------------------------------------------------------------------------- */
/* 基础工具                                                                     */
/* --------------------------------------------------------------------------- */

/** 明确用 `ArrayBuffer` 兜底型：WebCrypto 的 `BufferSource` 只吃 `Uint8Array<ArrayBuffer>` */
type Bytes = Uint8Array<ArrayBuffer>;

function hexToBytes(hex: string): Bytes {
  const out = new Uint8Array(hex.length / 2) as Bytes;
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concatBytes(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length + b.length) as Bytes;
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * 宽松 base64 解码：站点这两处（token / key_seed）**可能**在 URL 里被换成 `-` `_`，
 * 也**可能**缺 `=` 填充 ⇒ 统一先归一化再补填充。解不出来返回 `null`。
 */
function base64Loose(text: unknown): Bytes | null {
  const input = String(text ?? '').trim();
  if (!input) return null;
  for (const candidate of [input, input.replace(/-/g, '+').replace(/_/g, '/')]) {
    const padded = candidate + '='.repeat((4 - (candidate.length % 4)) % 4);
    try {
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length) as Bytes;
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      /* 试下一种 */
    }
  }
  return null;
}

/** 字节是否全是可打印 ASCII 且以 http(s) 开头 —— 解密结果的「像不像直链」判据 */
function asciiUrl(bytes: Uint8Array | null): string {
  if (!bytes || !bytes.length) return '';
  for (const byte of bytes) {
    if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) return '';
  }
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  text = text.trim();
  return /^https?:\/\//i.test(text) ? text : '';
}

/** 按路径取值（只走对象/数组，不做任何猜测） */
function readPath(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/* --------------------------------------------------------------------------- */
/* ① 是不是一条可用的 fallback_api                                              */
/* --------------------------------------------------------------------------- */

/**
 * 只接受「https + `*.snssdk.com` + `/video/fplay/` 开头」的地址。
 *
 * ⚠️ **必须校验**：这个值来自报文，万一站点把它换成别的域，我们就等于拿用户身份去请求陌生地址。
 */
export function isFplayUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === FPLAY_HOST_SUFFIX || host.endsWith(`.${FPLAY_HOST_SUFFIX}`);
    return parsed.protocol === 'https:' && trusted && parsed.pathname.startsWith(FPLAY_PATH_PREFIX);
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------- */
/* ② 改写请求：删 logo_type / force_fids，再按档位设 codec_type                  */
/* --------------------------------------------------------------------------- */

/**
 * 按档位改写 `fallback_api`。
 *
 * - `light`（默认）：`codec_type=1` —— 轻量无水印，体积与站点带水印档相当；
 * - `heavy`：`codec_type=5` + `force_fids=base64("original")` —— 原画质无水印（体积随片源）。
 *
 * ⚠️ 两种都必须**先把 `logo_type` / `force_fids` 删掉**再设值：实测留着旧值会把档位钉回默认档。
 * 非法输入返回 `null`（调用方回退）。
 */
export function buildFplayUrl(fallbackApi: unknown, quality: ShareQuality): string | null {
  if (!isFplayUrl(fallbackApi)) return null;
  const url = new URL(fallbackApi as string);
  url.protocol = 'https:';
  for (const key of FPLAY_DROP_PARAMS) url.searchParams.delete(key);
  if (quality === 'heavy') {
    url.searchParams.set('codec_type', FPLAY_CODEC_HEAVY);
    url.searchParams.set('force_fids', FPLAY_FORCE_FIDS_ORIGINAL);
  } else {
    url.searchParams.set('codec_type', FPLAY_CODEC_LIGHT);
  }
  return url.toString();
}

/* --------------------------------------------------------------------------- */
/* ③ 读响应：key_seed 与待解密的 token                                          */
/* --------------------------------------------------------------------------- */

/** 从 fplay 响应里取 `key_seed`（拿不到返回空串） */
export function readFplayKeySeed(payload: unknown): string {
  const data = readPath(payload, FPLAY_RESPONSE_DATA_PATH);
  const seed = readPath(data, [FPLAY_KEY_SEED_KEY]);
  return typeof seed === 'string' ? seed.trim() : '';
}

/**
 * 从 fplay 响应里取**全部**待解密 token（`main_url` 在前、`backup_url_1` 在后）。
 *
 * `video_list` 实测可能是对象（键为序号）或数组 —— 两种都吃；去重、过滤空值。
 */
export function readFplayTokens(payload: unknown): string[] {
  const data = readPath(payload, FPLAY_RESPONSE_DATA_PATH);
  const rawList = readPath(data, [FPLAY_VIDEO_LIST_KEY]);
  const entries: unknown[] = Array.isArray(rawList)
    ? rawList
    : rawList && typeof rawList === 'object'
      ? Object.values(rawList as Record<string, unknown>)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    for (const key of FPLAY_VIDEO_URL_KEYS) {
      const token = (entry as Record<string, unknown>)[key];
      if (typeof token !== 'string' || !token || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

/* --------------------------------------------------------------------------- */
/* ④ qAAB 解密                                                                  */
/* --------------------------------------------------------------------------- */

/**
 * 把 qAAB token 解成明文直链。**解不出来返回空串。**
 *
 * 算法（`site-contract` §2.9 的盐 + 开源同款）：
 * ```
 *   seed     = base64_loose(key_seed)
 *   first    = SHA-512(seed)
 *   material = SHA-512(first ‖ SALT)          // SALT = FPLAY_KDF_SALT_HEX，64 字节
 *   key, iv  = material[0:16], material[16:32]
 *   payload  = token[4:]  （前 4 字节 = a8 00 01 00 时剥掉；否则整段）
 *   AES-128-CBC 解密 → 可打印 ASCII 且以 http(s) 开头 ⇒ 直链
 * ```
 *
 * ⚠️ WebCrypto 的 AES-CBC **强制校验 PKCS7 填充**：样本都带填充（实测可解）；
 *    万一将来出现**无填充**的 token，这里会抛错 → 返回空串 → 调用方回退（不做「关掉填充校验」的兜底，
 *    那需要自写 AES，不值得为一种没见过的形态引入）。
 */
export async function decodeQaabToken(token: unknown, keySeed: unknown): Promise<string> {
  const data = base64Loose(token);
  const seed = base64Loose(keySeed);
  if (!data || !seed || !seed.length) return '';

  const prefixMatched = FPLAY_TOKEN_PREFIX.every((byte, i) => data[i] === byte);
  const payload = prefixMatched ? data.slice(FPLAY_TOKEN_PREFIX.length) : data;
  if (!payload.length || payload.length % 16 !== 0) return '';

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return '';

  try {
    const first = new Uint8Array(await subtle.digest('SHA-512', seed));
    const material = new Uint8Array(await subtle.digest('SHA-512', concatBytes(first, hexToBytes(FPLAY_KDF_SALT_HEX))));
    const key = await subtle.importKey('raw', material.slice(0, 16), { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: material.slice(16, 32) }, key, payload));
    return asciiUrl(plain);
  } catch {
    return '';
  }
}

/**
 * 一步到位：从 fplay 响应里**依次尝试**每个 token，返回第一个能解出的直链。
 * 全部解不出返回空串。
 */
export async function pickFplayUrl(payload: unknown, keySeed?: string): Promise<string> {
  const seed = keySeed || readFplayKeySeed(payload);
  if (!seed) return '';
  for (const token of readFplayTokens(payload)) {
    const url = await decodeQaabToken(token, seed);
    if (url) return url;
  }
  return '';
}
