/**
 * 媒体 URL 归一化 / 水印改写 / 变体挑选 —— 全部为纯函数，可直接单测。
 *
 * 职责边界：本文件是「水印改写的唯一实现」。
 * 上游把同一件事写了三遍（DNR 静态规则 / inject.js 改 DOM / content.js 打标记），
 * 本项目的 DNR 规则由 `buildDnrRules()` 在**构建期**从同一份契约生成。
 */

import {
  CORS_INJECT_HOST_FILTERS,
  DOWNLOAD_REFERER,
  HOST_DOLA,
  HOST_IMAGE_CDN_SUFFIXES,
  HOST_SHARE_SHORTLINK_SUFFIX,
  IMAGE_SUFFIX_REWRITES,
  LEGACY_STORAGE_KEYS,
  LOGO_TYPE_PARAM,
  LOGO_TYPE_VALUE,
  LR_DOLA_CLEAN,
  LR_NO_WATERMARK,
  LR_WATERMARK_DOLA_RE,
  LR_WATERMARK_RE,
  THUMB_HINTS,
  WATERMARK_HINTS,
} from './site-contract';
import type { MediaKind, MediaVariant } from './types';

/* ============================================================================
 * 基础 URL 工具
 * ========================================================================== */

/** 去掉 query / hash，只保留路径部分（用于指纹与映射表键） */
export function stripQuery(url: string): string {
  if (!url) return '';
  const q = url.indexOf('?');
  const h = url.indexOf('#');
  let end = url.length;
  if (q >= 0) end = Math.min(end, q);
  if (h >= 0) end = Math.min(end, h);
  return url.slice(0, end);
}

/** 规范化：用于「同一资源」判定。协议 + 域名大小写 + 结尾斜杠一并抹平。 */
export function normalizeUrl(url: string): string {
  if (!url) return '';
  let out = stripQuery(url).trim();
  // 协议相对地址
  if (out.startsWith('//')) out = 'https:' + out;
  // 域名大小写不敏感
  const m = out.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/]+)(.*)$/);
  if (m) out = m[1].toLowerCase() + m[2].toLowerCase() + (m[3] || '');
  return out;
}

export function getHost(url: string): string {
  const m = url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : '';
}

/** 主机名是否属于某个域名后缀（含其子域） */
function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** 是否属于列出的域名后缀之一 */
export function isHostIn(host: string, suffixes: readonly string[]): boolean {
  if (!host) return false;
  return suffixes.some((suffix) => hostMatches(host, suffix));
}

/**
 * 该地址能否用作列表封面。
 *
 * [实测修正 `docs/03` P1-4] 首轮联调里 `cover` 取到了分享短链图
 * `aka.doubaocdn.com/s/<token>` —— 卡片缩略图加载失败，且污染了指纹。
 * 判定：必须是 http(s)、必须落在图片 CDN 域内、**排除分享短链域**。
 */
export function isUsableCover(url: string): boolean {
  if (!url || !/^https?:/i.test(url)) return false;
  const host = getHost(url);
  if (!host) return false;
  if (hostMatches(host, HOST_SHARE_SHORTLINK_SUFFIX)) return false;
  return isHostIn(host, HOST_IMAGE_CDN_SUFFIXES);
}

export function pathExt(url: string, fallback = 'png'): string {
  const path = stripQuery(url);
  const m = path.match(/\.([A-Za-z0-9]{2,5})$/);
  if (!m) return fallback;
  const ext = m[1].toLowerCase();
  if (ext === 'jpeg') return 'jpeg';
  return ext;
}

/* ============================================================================
 * 水印判定与改写
 * ========================================================================== */

/** 是否像「带水印」的媒体地址 */
export function isWatermarked(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return WATERMARK_HINTS.some((h) => lower.includes(h));
}

/** 是否像缩略图 / 封面（不含原片） */
export function isThumbLike(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return THUMB_HINTS.some((h) => lower.includes(h.toLowerCase()));
}

/** 图片水印后缀族 → 无水印后缀（命中多条时逐条应用，幂等） */
export function rewriteImageSuffix(url: string): string {
  let out = url;
  for (const rule of IMAGE_SUFFIX_REWRITES) {
    if (rule.test.test(out)) out = rule.apply(out);
  }
  return out;
}

/** 视频 lr 参数改写：doubao 走 video_gen_no_watermark，dola 走 unwatermarked */
export function rewriteVideoLr(url: string, host = ''): string {
  if (!url) return url;
  const target = host || getHost(url);
  if (target.includes(HOST_DOLA)) {
    return url.replace(LR_WATERMARK_RE, LR_DOLA_CLEAN).replace(LR_WATERMARK_DOLA_RE, LR_DOLA_CLEAN);
  }
  return url.replace(LR_WATERMARK_RE, LR_NO_WATERMARK);
}

/** 移除动态水印参数 logo_type（仅当取值命中契约值时改写） */
export function stripLogoType(url: string): string {
  if (!url || !url.includes(`${LOGO_TYPE_PARAM}=${LOGO_TYPE_VALUE}`)) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete(LOGO_TYPE_PARAM);
    return u.toString();
  } catch {
    return url
      .replace(new RegExp(`[?&]${LOGO_TYPE_PARAM}=${LOGO_TYPE_VALUE}`), '')
      .replace(/\?&/, '?')
      .replace(/\?$/, '');
  }
}

/** 对任意媒体地址做「尽可能无水印化」改写，用于把候选地址规格化到同一形态 */
export function sanitizeMediaUrl(url: string, kind: MediaKind): string {
  if (!url) return '';
  let out = kind === 'image' ? rewriteImageSuffix(url) : rewriteVideoLr(url);
  out = stripLogoType(out);
  return out;
}

/** 猜测一条候选地址是否为「无水印原片」（用于 rank/isRaw 判定） */
export function looksUnwatermarked(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower.includes(LR_NO_WATERMARK)) return true;
  if (lower.includes(LR_DOLA_CLEAN)) return true;
  if (lower.includes('ori_raw')) return true;
  return !WATERMARK_HINTS.some((h) => lower.includes(h));
}

/* ============================================================================
 * 变体归并
 * ========================================================================== */

/**
 * 按「规范化 URL」去重并保序。
 *
 * 语义：同一个资源路径（忽略查询参数）只留一条 —— 这正是「上游把一个视频拆成 6~8 条记录」
 * 的对策之一。冲突时保留 rank 更高 / isRaw 更强者。
 */
export function dedupeVariants(variants: MediaVariant[]): MediaVariant[] {
  const map = new Map<string, MediaVariant>();
  for (const variant of variants) {
    if (!variant.url) continue;
    const key = normalizeUrl(variant.url) || variant.url;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, variant);
      continue;
    }
    if (variant.rank > prev.rank || (variant.rank === prev.rank && variant.isRaw && !prev.isRaw)) {
      map.set(key, variant);
    }
  }
  return [...map.values()].sort((a, b) => b.rank - a.rank);
}

/** 挑选当前下载地址：rank 最高的 isRaw 变体；没有则 rank 最高者 */
export function pickPrimary(variants: MediaVariant[]): string {
  return pickPrimaryVariant(variants)?.url ?? '';
}

export function pickPrimaryVariant(variants: MediaVariant[]): MediaVariant | null {
  if (!variants.length) return null;
  const raws = variants.filter((v) => v.isRaw);
  const pool = raws.length ? raws : variants;
  return pool.reduce((best, v) => (v.rank > best.rank ? v : best), pool[0]);
}

/* ============================================================================
 * DNR 规则生成（构建期调用，产出 dist/rules.json）
 * ========================================================================== */

export interface DnrRule {
  id: number;
  priority: number;
  action: Record<string, unknown>;
  condition: Record<string, unknown>;
}

/**
 * 生成 declarativeNetRequest 静态规则。
 * 与上游 rules.json 一一对应，但**唯一来源**是 site-contract.ts：
 *   id 1~5   → IMAGE_SUFFIX_REWRITES（图片水印后缀重定向）
 *   id 6     → logo_type 参数移除
 *   id 7     → lr=video_gen_watermark(_dyn)? → lr=video_gen_no_watermark
 *   id 8~10  → 视频 CDN 注入 CORS 响应头（每个 CDN 域一条）
 *   id 11~13 → 视频 CDN 注入 Referer 请求头（方案 §7.3 的取流方案 A 依赖它，待实测定案）
 */
export function buildDnrRules(): DnrRule[] {
  const rules: DnrRule[] = [];
  let id = 1;

  for (const rule of IMAGE_SUFFIX_REWRITES) {
    rules.push({
      id: id++,
      priority: 2,
      action: { type: 'redirect', redirect: { regexSubstitution: rule.dnrSubstitution } },
      condition: { regexFilter: rule.dnrPattern, resourceTypes: ['image'] },
    });
  }

  // 动态水印：移除 logo_type 参数
  rules.push({
    id: id++,
    priority: 2,
    action: {
      type: 'redirect',
      redirect: { transform: { queryTransform: { removeParams: [LOGO_TYPE_PARAM] } } },
    },
    condition: {
      urlFilter: `${LOGO_TYPE_PARAM}=${LOGO_TYPE_VALUE}`,
      resourceTypes: ['media'],
    },
  });

  // 视频 lr 参数改写
  rules.push({
    id: id++,
    priority: 2,
    action: { type: 'redirect', redirect: { regexSubstitution: `\\1${LR_NO_WATERMARK}` } },
    condition: {
      regexFilter: '(\\?.*)lr=video_gen_watermark(?:_dyn)?',
      resourceTypes: ['media'],
    },
  });

  for (const filter of CORS_INJECT_HOST_FILTERS) {
    // 视频 CDN 注入 CORS 响应头（上游已验证：绕过 blob 读取的跨域限制）
    rules.push({
      id: id++,
      priority: 2,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, OPTIONS' },
          { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
        ],
      },
      condition: {
        urlFilter: filter,
        resourceTypes: ['xmlhttprequest', 'media', 'other'],
      },
    });
  }

  for (const filter of CORS_INJECT_HOST_FILTERS) {
    // 下载防盗链：给 CDN 请求补上 Referer（方案 A 前置条件，P1 实测项）
    rules.push({
      id: id++,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: DOWNLOAD_REFERER },
          { header: 'Origin', operation: 'set', value: 'https://www.doubao.com' },
        ],
      },
      condition: {
        urlFilter: filter,
        resourceTypes: ['xmlhttprequest', 'media', 'other', 'image'],
      },
    });
  }

  return rules;
}

/** 供背景脚本做「安装时清理遗留键」使用 */
export function legacyKeys(): readonly string[] {
  return LEGACY_STORAGE_KEYS;
}
