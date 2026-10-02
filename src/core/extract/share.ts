/**
 * **视频分享页**（`/video-sharing`）解析 —— **纯函数**（2026-10-02 第十六轮）。
 *
 * 数据来源：站点路由 loader 的 `POST /creativity/share/get_video_share_info`
 * （契约与实测形状见 `site-contract` §2.7）。注意它**不在** chain / SSE 上，
 * 页面自身的报文里没有这条数据，所以是独立的一路。
 *
 * 产出的一条 `RawMedia` 只有「带水印播放地址 + 备用地址 + 封面 + 宽高 + vid」：
 *   · `downloadUrl` = `play_info.main` —— 实测 `lr=video_gen_watermark_dyn`，**不是原片**；
 *     `buildVideoVariants` 会照既有规则把它标成「候选地址（参数改写）」（`isRaw: false`），
 *     于是条目状态停在 `pending`，最终由既有链路给出「原片不可得」（分享页口径）；
 *   · `fallbackApi` = `play_info.backup` —— 同为带水印转码流，语义与 chain 的 `fallback_api`
 *     完全一致（都是「备选播放源（带水印）」），因此**复用同一个字段**，不新增类型；
 *   · `thumb` = `play_info.poster_url` —— 站点自己的带水印封面；
 *   · `width` / `height` = `play_info.width/height`（实测 720×1280，描述的就是**这个可下载文件**）——
 *     `toDraft` 会给视频宽高打 `dimsPreview` 标记，界面上显示成「**预览 720×1280**」
 *     （2026-10-02 用户拍板：这样显示没问题，比什么都不显示更有信息量）；
 *   · `vid` = **URL 里的 `video_id`**（响应里没有 vid）。必须有它：视频指纹要用
 *     （`vid:<x>` 稳定，退化成 URL 会随 CDN 调度漂移），且万一这是**本账号自己的作品**，
 *     既有的三步 API 还能换来真原片（原片只对作品所属账号开放）。
 *   · `origin` 记 `'thread'` —— 它是**站点给出的**分享页数据，与 `/thread/` 同一档可信度；
 *     `'dom'` 那一档专指「本地改写 `lr` 猜地址」，不是这里。
 *
 * ⚠️ `definition`（实测 `"720p"`）**仍然不取**：清晰度标签（`meta.label`）只允许描述
 * 「最终下载的那个文件」，而这个条目的 `primary` 在 vid 解析成功后可能换成**另一个文件**
 * （本账号作品 → 真原片），此时沿用旧标签就会重演「卡片写 1080p、下到的是 720p」（`docs/03` §12.7）。
 */

import {
  SHARE_PLAY_BACKUP_KEY,
  SHARE_PLAY_HEIGHT_KEY,
  SHARE_PLAY_INFO_PATH,
  SHARE_PLAY_MAIN_KEY,
  SHARE_PLAY_WIDTH_KEY,
  SHARE_POSTER_KEY,
} from '../site-contract';
import { asNumber, asString, getPath, isObject } from './common';
import type { RawMedia } from '../types';

/**
 * 分享信息响应 → `RawMedia[]`（0 或 1 条）。
 *
 * `payload` 是**整个响应体**（`{ code, msg, data: { play_info: … } }`）。
 * `vid` 由调用方从 URL 的 `video_id` 传入（响应里没有这个字段）。
 * 数据缺失（结构变了 / 没有播放地址）→ 返回空数组：**宁缺勿假**，绝不拿封面当视频入库。
 */
export function extractVideoShareRaw(payload: unknown, vid = ''): RawMedia[] {
  const playInfo = getPath(payload, [...SHARE_PLAY_INFO_PATH]);
  if (!isObject(playInfo)) return [];

  const main = asString(playInfo[SHARE_PLAY_MAIN_KEY]);
  if (!main) return [];

  const raw: RawMedia = { kind: 'video', origin: 'thread', downloadUrl: main };
  if (vid) raw.vid = vid;

  const backup = asString(playInfo[SHARE_PLAY_BACKUP_KEY]);
  if (backup) raw.fallbackApi = backup;

  const poster = asString(playInfo[SHARE_POSTER_KEY]);
  if (poster) raw.thumb = poster;

  /*
   * 宽高：站点给的就是**这个可下载文件**的规格（实测 720×1280 / `definition: "720p"`）。
   * 交给 `toDraft` 走通用路径（它会打 `dimsPreview` 标记 → 界面「预览 720×1280」，用户已拍板接受）。
   * 站点数字字段形态不稳定（可能是字符串），一律经 `asNumber()`。
   */
  const width = asNumber(playInfo[SHARE_PLAY_WIDTH_KEY]);
  const height = asNumber(playInfo[SHARE_PLAY_HEIGHT_KEY]);
  if (width !== undefined) raw.width = width;
  if (height !== undefined) raw.height = height;

  return [raw];
}
