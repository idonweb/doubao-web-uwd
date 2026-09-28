/**
 * 媒体 URL 归一化 / 水印改写 / 变体挑选 —— 全部为纯函数，可直接单测。
 *
 * 职责边界：本文件是「水印改写的唯一实现」。
 * 上游把同一件事写了三遍（DNR 静态规则 / inject.js 改 DOM / content.js 打标记），
 * 本项目的 DNR 规则由 `buildDnrRules()` 在**构建期**从同一份契约生成。
 */

import {
  CORS_INJECT_HOST_FILTERS,
  COVER_INJECT_HOST_FILTERS,
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

/**
 * 媒体 URL 的**路径键** —— 用于把资源库条目匹配回**页面里的 DOM 媒体元素**（2026-09-28 第十轮）。
 *
 * 实测依据（`docs/03` §17.10.1）：页面里 `<video src>` 与我们报文里的候选地址是
 * **同源同路径**的，只差结尾的规格后缀与签名段：
 *   · 报文（候选）`https://v26-vdl.doubao.com/<签名>/video/tos/cn/tos-cn-v-9ecd54/<hash>/?a=…&lr=…`
 *   · 页面（DOM）`https://….doubao.com/…/video/tos/cn/tos-cn-v-9ecd54/<hash>/`
 *   · 图片：`…/rc_gen_image/<hash>.jpeg~tplv-a9rns2rl98-image_raw.png` ↔ `…/<hash>.jpg~tplv-…-image.png`
 * 所以取「去掉查询、去掉 `~tplv-` 之后的后缀、去掉扩展名」的最后一段路径当作匹配键 —— `<hash>`。
 *
 * 返回值：长度 ≥ 8 的最后一段路径（像真哈希才认）；否则 null（**宁缺勿假**，不用短段乱匹配）。
 */
export function mediaPathKey(url: string): string | null {
  if (!url) return null;
  const withoutQuery = stripQuery(url.replace(/\\+$/, '')).replace(/\\/g, '');
  // 去掉站点规格后缀（`~tplv-…`）；水印/无水印各版本共用同一段哈希
  const tplv = withoutQuery.indexOf('~tplv-');
  const path = tplv >= 0 ? withoutQuery.slice(0, tplv) : withoutQuery;
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const key = last.replace(/\.[A-Za-z0-9]{2,5}$/, '');
  return key.length >= 8 ? key : null;
}

/**
 * 从一组地址里收集**页面匹配键**（去重、保序）—— 供「在页面里定位这条资源」用。
 *
 * 调用方把条目的所有地址（`primary` + 各 `variants` + 封面）丢进来即可；
 * 拿不到键的地址（短路径段、非 URL、`vid:` 这类指纹）自动跳过，不会污染匹配。
 */
export function mediaLookupKeys(urls: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const key = mediaPathKey(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 规范化：用于「同一资源」判定。协议 + 域名大小写 + 结尾斜杠一并抹平。 */export function normalizeUrl(url: string): string {
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
 * 生成 declarativeNetRequest 静态规则。**唯一来源**是 site-contract.ts。
 *
 * ⚠️ 2026-09-28 第十轮：**删掉了全部「改写类」规则**（图片水印后缀重定向、`logo_type` 移除、
 * `lr` 改写，原 id 1~7）。原因是实测到它们**把站点自己的签名图打成了 403**：
 *   页面请求 `…~tplv-a9rns2rl98-video_dsz_watermark_1_6.png`（豆包渲染的旧视频封面）
 *   → 被规则重定向成 `…~tplv-a9rns2rl98-video_cover.jpeg`
 *   → 而 `p11-flow-imagex-sign.byteimg.com` 这类域是**带签名**的，路径一改签名即失效 → **403**。
 * 而「改 URL 去水印」本身早已失效（站点把水印烧进了转码流，见 SESSION_CONTEXT 关键约束 3），
 * 本插件下载用的是 `get_download_info` 给的原片地址，**从不依赖这些改写** ——
 * 留着只会破坏站点自己的封面与播放，因此整体移除。
 *
 * 现在只剩两类「注入类」规则（都不改 URL）：
 *   · 视频 CDN 注入 CORS 响应头（取流方案 B 的 fetch+blob 需要）
 *   · 视频 CDN / 封面域注入 Referer 请求头（下载防盗链 + 弹窗里的封面图）
 */
export function buildDnrRules(): DnrRule[] {
  const rules: DnrRule[] = [];
  let id = 1;

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

  for (const filter of COVER_INJECT_HOST_FILTERS) {
    /*
     * 封面 / 缩略图防盗链（2026-09-28 第十轮）：弹窗是扩展页，发出的图片请求 Referer 是
     * `chrome-extension://…`，这些图片域会 403 → 卡片只剩灰底占位。补上站点 Referer 即可。
     * 只加 Referer / Origin，不加 CORS 响应头（封面是 `<img>`，不需要跨域读取）。
     *
     * ℹ️ `xmlhttprequest` 是 2026-09-28 补的：background 侧「实测文件字节数」
     * （`Range: bytes=0-0` 读 `Content-Range`）也发到这些图片域，同样需要站内 Referer，
     * 否则会被防盗链挡成 403 → 体积测不出来。
     */
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
        resourceTypes: ['image', 'xmlhttprequest'],
      },
    });
  }

  return rules;
}

/** 供背景脚本做「安装时清理遗留键」使用 */
export function legacyKeys(): readonly string[] {
  return LEGACY_STORAGE_KEYS;
}
