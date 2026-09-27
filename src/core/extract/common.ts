/**
 * 抽取层公共逻辑：把各来源（SSE / chain / thread）解析出的 `RawMedia`
 * 统一收敛成 `MediaDraft`。
 *
 * 这是「上游重复条目」对策的核心：上游对同一个视频会 push 出 6~8 条独立记录
 * （download_url 原文 + 3 个猜测式变体 + 多清晰度 base64 + 封面图 + vid 三步 API 结果），
 * 本项目把它们**全部收进同一个 MediaDraft 的 variants**，再用稳定指纹决定它归属哪个条目。
 */

import {
  CHAIN_FALLBACK_API_KEY,
  CHAIN_VID_DURATION_KEY,
  IMG_DIMS_SUBOBJECTS,
  IMG_PREVIEW_PATH,
  IMG_RAW_PATH,
  IMG_THUMB_PATH,
  VID_DOWNLOAD_PATH,
  VID_MODEL_PATH,
  VID_RAW_PATH,
  VID_THUMB_PATH,
  VIDEO_ID_KEYS,
  VIDEO_MODEL_DEFINITION_KEY,
  VIDEO_MODEL_LIST_KEY,
  VIDEO_MODEL_MAIN_URL_KEY,
  VIDEO_MODEL_QUALITY_KEY,
} from '../site-contract';
import { dedupeVariants, looksUnwatermarked, normalizeUrl, pathExt, rewriteVideoLr, sanitizeMediaUrl } from '../media-url';
import type { ConvKind, MediaDraft, MediaVariant, RawMedia } from '../types';

/** 变体优先级：越大越优先 */
export const RANK = {
  /** vid 三步 API 拿到的原始原片 */
  resolved: 120,
  /** 响应里直接给出的 ori_raw */
  raw: 100,
  /** 由水印地址改写而来的候选地址（DNR 也会做同样的改写） */
  candidate: 60,
  /** video_model 里的多清晰度地址 */
  quality: 40,
  /**
   * chain 响应里的 `fallback_api`（实测带水印、且在第三方域 `snssdk.com`）。
   * 排在 `quality` **之下**：同为「非原片候选」时，优先用豆包自己的清晰度地址。
   */
  fallback: 20,
  preview: 30,
  thumb: 10,
} as const;

export interface DraftContext {
  convId: string;
  convKind: ConvKind;
  convTitle: string;
}

/* --------------------------------------------------------------------------- */
/* 工具                                                                          */
/* --------------------------------------------------------------------------- */

/** 安全按路径取值 */
export function getPath(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  /*
   * 2026-09-27 实测（探针采样，`docs/03` §12）：站点给数字**不稳定** ——
   * 同一个 vid 的多条报文里 `width` 一会儿是 `384`（number）、一会儿是 `"384"`（字符串）。
   * 严格只认 number 会把字符串那批全部丢掉，这里统一放宽为「纯数字字符串也可」。
   */
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 该来源给出的 `raw` 是否可信为「站点原始原片」。
 * 只有 sse / chain / thread 的 `raw` 来自 `video.video_ori_raw.url`；
 * `dom` 的 `raw` 是本地对播放地址改写 `lr` 猜出来的（实测已不能去水印）。
 */
const TRUSTED_ORIGINS = ['sse', 'chain', 'thread'];

export function isTrustedOrigin(origin: RawMedia['origin']): boolean {
  return typeof origin === 'string' && TRUSTED_ORIGINS.includes(origin);
}

/** base64 解码（兼容 URL-safe 变体与缺失 padding） */
export function decodeBase64(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

/**
 * 宽容 JSON 解析：站点存在**多层转义**的 JSON 字符串字段。
 *
 * 实测（`docs/03` §2）：`chain/single` 响应里的 `video_model` 在原始报文中长这样 ——
 * `\\\"main_url\\\"`（3 个反斜杠 + 引号），即外层 JSON 解一次之后，
 * 拿到的仍是一个**被转义过的 JSON 文本**（`{\"video_list\":...}`）。
 * 直接 `JSON.parse` 会失败，必须先反转义再解析。
 *
 * 实现：最多迭代 4 轮「尝试解析 → 反转义」，覆盖 1~3 层转义；
 * 只有当字符串确实以 `{` / `[` 开头时才尝试，避免把普通 URL 当 JSON。
 */
export function parseLooseJson(value: unknown): unknown {
  let cur: unknown = value;
  for (let round = 0; round < 4; round += 1) {
    if (typeof cur !== 'string') return cur;
    const text = cur.trim();
    if (!text) return undefined;
    if (text[0] !== '{' && text[0] !== '[') return undefined;
    try {
      cur = JSON.parse(text);
      continue;
    } catch {
      // 反转义一层：\" → "、\\ → \、\/ → /
      const unescaped = text.replace(/\\(["\\/])/g, '$1');
      if (unescaped === text) return undefined;
      cur = unescaped;
    }
  }
  return cur;
}

/* --------------------------------------------------------------------------- */
/* creation → RawMedia（SSE / chain / thread 三条来源共用）                        */
/* --------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------- */
/* creation → RawMedia（SSE / chain / thread 三条来源共用）                        */
/* --------------------------------------------------------------------------- */

/**
 * 单个 creation → RawMedia（video 优先于 image，因为视频的封面也是 image 结构）。
 *
 * 注意：site-contract 里的字段路径都是**以 creation 为根**的完整路径
 * （`['video','video_thumb','url']`），所以统一对 `creation` 求值，
 * 而不是对已经下钻过的 `video` / `image` 对象求值。
 *
 * `origin` 必须由调用方给出 —— 它不只是排查标签，`toDraft` 会用它判断
 * 这条 `raw` 是站点给的原片（sse/chain/thread）还是本地猜测（dom）。
 */
export function rawFromCreation(creation: unknown, origin: RawMedia['origin']): RawMedia | null {
  if (!isObject(creation)) return null;

  const video = creation.video;
  if (isObject(video)) {
    const model = getPath(creation, VID_MODEL_PATH);
    const raw: RawMedia = {
      kind: 'video',
      origin,
      thumb: asString(getPath(creation, VID_THUMB_PATH)),
      raw: asString(getPath(creation, VID_RAW_PATH)),
      vid: pickVideoId(video),
      downloadUrl: asString(getPath(creation, VID_DOWNLOAD_PATH)),
      videoModel: typeof model === 'string' ? model : undefined,
      fallbackApi: asString(video[CHAIN_FALLBACK_API_KEY]),
      // chain 用 video_duration，SSE / thread 用 duration（实测两套并存）
      duration: asNumber(video.duration) ?? asNumber(video[CHAIN_VID_DURATION_KEY]),
      width: asNumber(video.width),
      height: asNumber(video.height),
      size: asNumber(video.size),
    };
    if (
      raw.thumb !== undefined ||
      raw.raw !== undefined ||
      raw.downloadUrl !== undefined ||
      raw.vid !== undefined ||
      raw.videoModel !== undefined ||
      raw.fallbackApi !== undefined
    ) {
      return raw;
    }
  }

  const image = creation.image;
  if (isObject(image)) {
    /*
     * 2026-09-27 实测（探针采样，`docs/03` §12）：`image` 顶层**没有** width / height，
     * 宽高在 `image_ori_raw / image_ori / image_preview / image_thumb` 各子对象里
     * （全部一致，如 2720×1520）。按「质量最高优先」从子对象取；
     * 顶层的 `image.width` 若站点将来给出，也保留作末位候选。
     * `size` 整个对象树里都不存在（站点不给），读不到就让它缺省 —— 由界面显示「—」。
     */
    let width: number | undefined;
    let height: number | undefined;
    let size: number | undefined;
    for (const key of IMG_DIMS_SUBOBJECTS) {
      const sub = image[key];
      if (!isObject(sub)) continue;
      width = width ?? asNumber(sub.width);
      height = height ?? asNumber(sub.height);
      size = size ?? asNumber(sub.size);
      if (width !== undefined && height !== undefined && size !== undefined) break;
    }
    const raw: RawMedia = {
      kind: 'image',
      origin,
      thumb: asString(getPath(creation, IMG_THUMB_PATH)),
      preview: asString(getPath(creation, IMG_PREVIEW_PATH)),
      raw: asString(getPath(creation, IMG_RAW_PATH)),
      width: width ?? asNumber(image.width),
      height: height ?? asNumber(image.height),
      size: size ?? asNumber(image.size),
    };
    if (raw.thumb !== undefined || raw.preview !== undefined || raw.raw !== undefined) return raw;
  }

  return null;
}

/** 按 `VIDEO_ID_KEYS` 候选顺序取第一个非空的视频 id（`vid` 或 `video_id`） */
export function pickVideoId(video: Record<string, unknown>): string | undefined {
  for (const key of VIDEO_ID_KEYS) {
    const value = asString(video[key]);
    if (value) return value;
  }
  return undefined;
}

/* --------------------------------------------------------------------------- */
/* video_model 解析                                                             */
/* --------------------------------------------------------------------------- */

export interface VideoModelEntry {
  key: string;
  url: string;
  label?: string;
  quality?: string | number;
}

/**
 * 解析 video_model 内嵌 JSON，取出各清晰度的 main_url（base64）。
 *
 * ⚠️ 这里**必须用 `parseLooseJson`**：`chain/single` 响应里的 video_model
 * 实测被多层转义（`docs/03` §2），直接 `JSON.parse` 会失败。
 */
export function parseVideoModel(modelValue: unknown): VideoModelEntry[] {
  const model = parseLooseJson(modelValue);
  if (!isObject(model)) return [];
  const list = model[VIDEO_MODEL_LIST_KEY];
  const entries: VideoModelEntry[] = [];

  const push = (key: string, def: unknown) => {
    if (!isObject(def)) return;
    const mainUrl = asString(def[VIDEO_MODEL_MAIN_URL_KEY]);
    if (!mainUrl) return;
    const decoded = decodeBase64(mainUrl) ?? mainUrl;
    entries.push({
      key,
      url: decoded,
      label: asString(def[VIDEO_MODEL_DEFINITION_KEY]),
      quality: def[VIDEO_MODEL_QUALITY_KEY] as string | number | undefined,
    });
  };

  if (Array.isArray(list)) {
    list.forEach((def, i) => push(String(i), def));
  } else if (isObject(list)) {
    for (const [key, def] of Object.entries(list)) push(key, def);
  }
  return entries;
}

/* --------------------------------------------------------------------------- */
/* 指纹                                                                          */
/* --------------------------------------------------------------------------- */

/**
 * 稳定指纹（施工守则 8）：
 *   视频 → 豆包自带的 vid（同一视频永远同一个 vid）
 *   图片 → 无水印原片 URL 去掉查询参数后的路径
 *
 * ⚠️ [实测修正 `docs/03` P1-4] **视频指纹绝不退化到封面图**。
 * 首轮联调里指纹变成了分享短链图 `aka.doubaocdn.com/s/<token>` ——
 * 那是「封面换一次就变成另一条记录」的重复源。
 * 视频只有在拿不到 vid 时才退到原片 / 下载地址（都是稳定路径）。
 */
export function computeFingerprint(raw: RawMedia): string {
  if (raw.kind === 'video') {
    if (raw.vid) return `vid:${raw.vid}`;
    return 'vurl:' + normalizeUrl(raw.raw || raw.downloadUrl || '');
  }
  const base = raw.raw || raw.preview || raw.thumb || '';
  return 'iurl:' + normalizeUrl(base);
}

/* --------------------------------------------------------------------------- */
/* RawMedia → MediaDraft                                                        */
/* --------------------------------------------------------------------------- */

/**
 * 视频变体。
 *
 * ⚠️ **`isRaw` 必须按「站点给出的原始地址」判定，不能按「我们自己改写后的地址」判定。**
 * 首轮联调的假条目就是这么来的：把 `lr=video_gen_watermark_dyn` 改写成
 * `lr=video_gen_no_watermark` 之后再看，地址「看起来」就是无水印的了，
 * 于是标成「无水印原片」——而实测证明**改写 lr 并不能真的去掉水印**（`docs/03` P0-2）。
 */
function buildVideoVariants(raw: RawMedia): MediaVariant[] {
  const variants: MediaVariant[] = [];

  // 站点直接给出的 ori_raw：本身就是原片（只做规格化）
  if (raw.raw) {
    variants.push({ url: rewriteVideoLr(raw.raw), label: '无水印原片', rank: RANK.raw, isRaw: true });
  }

  if (raw.downloadUrl) {
    const isRaw = looksUnwatermarked(raw.downloadUrl);
    const url = sanitizeMediaUrl(raw.downloadUrl, 'video');
    const changed = url !== raw.downloadUrl;
    variants.push({
      url,
      label: isRaw ? '无水印原片' : changed ? '候选地址（参数改写）' : '原始下载地址',
      rank: isRaw ? RANK.raw : RANK.candidate,
      isRaw,
    });
  }

  for (const entry of parseVideoModel(raw.videoModel)) {
    const isRaw = looksUnwatermarked(entry.url);
    const url = rewriteVideoLr(entry.url);
    variants.push({
      url,
      label: entry.label || entry.key,
      rank: isRaw ? RANK.raw : RANK.quality,
      isRaw,
    });
  }

  if (raw.fallbackApi) {
    // 实测带 logo_type=video_gen_watermark_dyn，**不改写、也不算原片**，仅作末位候选
    variants.push({
      url: raw.fallbackApi,
      label: '备选播放源（带水印）',
      rank: RANK.fallback,
      isRaw: false,
    });
  }

  if (raw.thumb) {
    variants.push({ url: raw.thumb, label: '封面', rank: RANK.thumb, isRaw: false });
  }

  return variants;
}

function buildImageVariants(raw: RawMedia): MediaVariant[] {
  const variants: MediaVariant[] = [];
  if (raw.raw) {
    variants.push({
      url: sanitizeMediaUrl(raw.raw, 'image'),
      label: '无水印原片',
      rank: RANK.raw,
      isRaw: true,
    });
  }
  if (raw.preview) {
    variants.push({
      url: sanitizeMediaUrl(raw.preview, 'image'),
      label: '预览图',
      rank: RANK.preview,
      isRaw: false,
    });
  }
  if (raw.thumb) {
    variants.push({
      url: sanitizeMediaUrl(raw.thumb, 'image'),
      label: '缩略图',
      rank: RANK.thumb,
      isRaw: false,
    });
  }
  return variants;
}

/**
 * 单条 RawMedia → MediaDraft。返回 null 表示这条素材本身不构成一个资源条目。
 *
 * 关键过滤：**只有封面图的「视频」直接丢弃** —— 上游的成因 3 之一
 * 就是把视频封面图当成一条 video 记录 push 出去。
 */
export function toDraft(raw: RawMedia, ctx: DraftContext): MediaDraft | null {
  if (!raw || !raw.kind) return null;

  const variants = dedupeVariants(raw.kind === 'video' ? buildVideoVariants(raw) : buildImageVariants(raw));
  if (!variants.length) return null;

  const hasRaw = variants.some((v) => v.isRaw);

  if (raw.kind === 'video') {
    // 只有封面、且拿不到 vid 也拿不到播放地址 → 它是图片，不是视频条目
    const playable = variants.some((v) => v.rank > RANK.thumb);
    if (!playable && !raw.vid) return null;

    /*
     * J3（用户拍板 2026-09-26）：**拿不到 vid、也没有站点直接给的 ori_raw 的历史资源不入库。**
     * 依据：DOM 兜底那条「改写 lr 猜地址」在当前站点已不能去水印（docs/03 P0-2），
     * 入库只会产生一条标着「无水印原片」实际带水印的假条目 —— 宁缺勿假。
     */
    const genuine = Boolean(raw.vid) || (isTrustedOrigin(raw.origin) && Boolean(raw.raw));
    if (!genuine) return null;
  } else if (!hasRaw && !raw.preview && !raw.thumb) {
    return null;
  }

  const cover = raw.thumb || raw.preview || null;

  const state: MediaDraft['state'] = hasRaw ? 'raw' : raw.vid ? 'pending' : 'thumb';

  const primaryVariant = variants.find((v) => v.isRaw) ?? variants[0];

  /*
   * ⚠️ 这里**不给视频写清晰度标签**（`docs/03` §12.7）。
   *
   * 原先取的是 `RANK.quality` 那条变体的 label —— 它来自 `video_model.video_list[].definition`，
   * 描述的是**那个候选地址**的规格，而 `primary`（用户真正下载的）是 vid 三步 API 的原片，
   * 两者不是同一个文件，于是实机上出现「卡片写 1080p、下到的是 720p」。
   * 真实清晰度改由 `page/hook.ts` 拿到原片宽高后用 `qualityFromDims()` 回填。
   */
  const meta: MediaDraft['meta'] = {
    ext: raw.kind === 'video' ? 'mp4' : pathExt(primaryVariant.url, 'png'),
  };
  if (raw.width !== undefined) meta.width = raw.width;
  if (raw.height !== undefined) meta.height = raw.height;
  if (raw.duration !== undefined) meta.duration = raw.duration;
  if (raw.size !== undefined) meta.size = raw.size;
  /*
   * 视频的 width / height 来自报文里 video 对象 —— 实测（`docs/03` §12）那是
   * **预览转码流**的规格（384×216），不是原片规格；打上来源标记，
   * 界面显示成「预览 384×216」，避免与「720p」清晰度标签互相矛盾。
   * 图片的宽高来自 image_ori_raw 子对象，是真实规格，不打标记。
   */
  if (raw.kind === 'video' && meta.width !== undefined && meta.height !== undefined) {
    meta.dimsPreview = true;
  }

  const draft: MediaDraft = {
    convId: ctx.convId,
    convKind: ctx.convKind,
    convTitle: ctx.convTitle,
    kind: raw.kind,
    fingerprint: computeFingerprint(raw),
    variants,
    cover,
    meta,
    state,
  };
  if (raw.vid) draft.vid = raw.vid;
  return draft;
}

export function toDrafts(raws: RawMedia[], ctx: DraftContext): MediaDraft[] {
  const out: MediaDraft[] = [];
  for (const raw of raws) {
    const draft = toDraft(raw, ctx);
    if (draft) out.push(draft);
  }
  return out;
}
