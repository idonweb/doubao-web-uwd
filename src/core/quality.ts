/**
 * 清晰度标签：由**原片的真实宽高**推导。
 *
 * 为什么要有这个模块（`docs/03` §12.7）：卡片上原先显示的 `1080p` 来自
 * `video_model.video_list[].definition` —— 那是**候选地址**的清晰度，而实际下载的
 * `primary` 是 vid 三步 API 换来的原片（`RANK.resolved`），两者根本不是同一个文件，
 * 于是出现「标签说 1080p、下到的是 720p」。
 *
 * 修法与第六轮 `dimsPreview` 同一条原则：**标签必须描述用户真正拿到的那个文件**。
 * 因此清晰度只从 vid 三步 API `download_infos[0]` 带回的原片宽高推导。
 */

/**
 * 认得的清晰度档位（按**短边**匹配）。
 *
 * 只做**精确匹配**、不做就近取整：实测站点只给 720P 一档，若将来出现
 * 非标尺寸（如 1024×576），宁可不给标签、只显示真实宽高，也不猜一个档位上去。
 */
const QUALITY_TIERS = [2160, 1440, 1080, 720, 480, 360] as const;

/**
 * 真实宽高 → 清晰度标签（`1280×720` → `720P`）。
 *
 * 用短边而非高度：竖版视频（`720×1280`）与横版是同一档。
 * 尺寸缺失或不是已知档位时返回 `undefined` —— 调用方据此只显示「无水印原片」。
 */
export function qualityFromDims(width?: number, height?: number): string | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined;
  const shortSide = Math.min(width, height);
  const tier = QUALITY_TIERS.find((value) => value === shortSide);
  return tier ? `${tier}P` : undefined;
}
