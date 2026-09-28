/** 全局数据模型（对应实施方案 §4） */

export type MediaKind = 'video' | 'image';

/** raw = 已拿到无水印原片；thumb = 只解析到封面/缩略图；pending = 解析中；fail = 获取失败 */
export type MediaState = 'raw' | 'thumb' | 'pending' | 'fail';

/** 会话类型：对话页 / 分享链接页 */
export type ConvKind = 'chat' | 'thread';

/** 页面类型：对话页 / 分享链接页 / 非豆包页 */
export type PageKind = ConvKind | 'none';

/**
 * 当前激活会话（第四轮新增）。
 *
 * 资源库的作用域就是它：**只针对当前激活的对话本身**。
 * 页面脚本在会话切换时上报（`conv:scope`），background 据此把资源库裁剪为当前会话，
 * 并利用 `title` 刷新该会话下已有条目的标题。
 */
export interface ConvScope {
  convId: string;
  /** **真实**标题；尚未解析到时为空串（界面侧用 `displayConvTitle()` 兜底显示） */
  title: string;
  kind: PageKind;
}

export interface MediaVariant {
  url: string;
  /** '无水印原片' | '1080p' | '封面' | '缩略图' | '无水印（参数改写）' */
  label: string;
  /** 越大越优先，用于挑选 primary */
  rank: number;
  /** 是否无水印原片 */
  isRaw: boolean;
}

export interface MediaMeta {
  /** 'mp4' | 'png' | 'jpeg' | 'webp' */
  ext: string;
  mime?: string;
  width?: number;
  height?: number;
  /**
   * 宽高的**来源标记**（2026-09-27 第六轮）：`true` = 来自 chain / SSE 报文里
   * video 对象的 width / height —— 实测那是**预览转码流**的规格（如 384×216），
   * 不是原片规格，界面要显示成「预览 384×216」。
   * vid 三步 API 若从 `download_infos[0]` 带回原片规格，会覆盖宽高并把本标记置 `false`。
   * 图片的宽高（来自 `image_ori_raw` 子对象）是真实规格，**不**置此标记。
   */
  dimsPreview?: boolean;
  /** 秒 */
  duration?: number;
  /** 字节 */
  size?: number;
  /** 清晰度标签 */
  label?: string;
  /**
   * 原片已超期（2026-09-27 Finding C 修复；2026-09-28 第十轮改为**弱结论**）。
   *
   * `true` = 页面侧已**翻遍整棵「我的创作」树**（且走完 30s 二次确认窗口）仍未找到该 vid ——
   * 站点对创作记录有保存期限（实测约三个月：6.23 的原片可解析、5 月的 vid 已清除）。
   * ⚠️ 它是弱结论：一旦拿到原片（`raw` 草稿）就会被清掉 —— 站点创作树对刚生成的视频有提交延迟。
   */
  expired?: boolean;
  /**
   * 作品的**真实生成时间**（毫秒 epoch，2026-09-28 第十轮新增）。
   *
   * 来源 = 站点创作树节点的 `create_time`（**秒级** Unix，求值时 ×1000）。
   * 它是资源库「最新 / 最早」的排序依据 —— 此前用的是 `lastSeen`（插件最后一次处理该条目的
   * 本地时刻），会把「刚被判超期」这种本地事件误当成「资源最新」。
   * ⚠️ 拿不到（vid 不在创作树里：已超期 / 尚未提交）时为 `undefined` —— **不编造**，
   * 排序时一律排在有真时间的条目之后。
   */
  createdAt?: number;
}

export interface MediaItem {
  /** 主键 = `${convId}::${fingerprint}` */
  id: string;
  convId: string;
  convKind: ConvKind;
  convTitle: string;
  /** 视频用 vid；图片用规范化后的原片 URL */
  fingerprint: string;
  kind: MediaKind;
  state: MediaState;
  variants: MediaVariant[];
  /** 当前下载地址（rank 最高的 isRaw 变体；无则 rank 最高者） */
  primary: string;
  /** 列表缩略图 */
  cover: string | null;
  meta: MediaMeta;
  firstSeen: number;
  lastSeen: number;
}

/** 页面侧解析出的草稿：还没落库，由 library-store 按指纹 upsert */
export interface MediaDraft {
  convId: string;
  convKind: ConvKind;
  convTitle: string;
  kind: MediaKind;
  fingerprint: string;
  variants: MediaVariant[];
  cover: string | null;
  meta: MediaMeta;
  state: MediaState;
  /** 视频才有：用于异步换取高清无水印原片 */
  vid?: string;
}

/** 抽取层（纯函数）的中间产物：一条 creation 里能看到的原始素材 */
export interface RawMedia {
  kind: MediaKind;
  thumb?: string;
  preview?: string;
  /** 无水印原片（来自站点的 `*_ori_raw.url`，或 DOM 层的本地猜测 —— 由 origin 区分） */
  raw?: string;
  vid?: string;
  downloadUrl?: string;
  /** 内嵌 JSON 字符串，内含 video_list[].main_url(base64) */
  videoModel?: string;
  /**
   * 备选播放源（chain 响应里的 `fallback_api`）。
   * 实测带 `logo_type=video_gen_watermark_dyn`，因此**永远不是原片**，只作末位候选。
   */
  fallbackApi?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  /**
   * 作品生成时间（**秒级** Unix，站点原样，2026-09-28 第十轮新增）。
   *
   * 来源 = 所在**消息**的 `create_time`（`MESSAGE_CREATE_TIME_KEY`，实测链：
   * `data.downlink_body.pull_singe_chain_downlink_body.messages[i].create_time`），
   * 与网页上每条生成结果下面显示的时间一致；旧作品即使不在创作树里也有。
   * ⚠️ 单位与站点一致（秒）；写进 `MediaMeta` 时统一换成**毫秒**（见 `siteTimeToMs()`）。
   */
  createdAt?: number;
  /**
   * 来源标签，便于排查：'sse' | 'chain' | 'thread' | 'dom'。
   * ⚠️ 语义上还承担一个判定职责：**只有 sse / chain / thread 的 `raw` 才算站点给出的原片**；
   * `dom` 的 `raw` 是本地改写猜测（实测已不能去水印），会被 `toDraft` 丢弃（J3：宁缺勿假）。
   */
  origin?: 'sse' | 'chain' | 'thread' | 'dom';
}

export interface Config {
  /**
   * 「过滤掉纯缩略图项」。
   *
   * ⚠️ 2026-09-26 第四轮收尾：原「显示隐藏的图片下载按钮」开关（`showImageDownloadButton`）
   * **已整体删除** —— 实测那个注入按钮从未生效，而它早年注入在左下角时还**遮挡**了豆包的
   * 原生图片下载入口（悬停操作行 `66 · ↻ · ⬇`）。现在页面侧**彻底零干预**：
   * 不注入任何元素（含 `<style>`）、不改任何样式、不拦截任何点击；
   * **所有无水印下载统一由弹窗资源库提供**，页面上隐藏的原生 ⬇ 由用户自行悬停使用。
   */
  skipThumbOnly: boolean;
  theme: 'system' | 'light' | 'dark';
}

export interface PageInfo {
  kind: PageKind;
  convId: string;
  title: string;
  url: string;
  /** 内容脚本是否已注入并应答 */
  injected: boolean;
}

export interface Stats {
  total: number;
  video: number;
  image: number;
  raw: number;
  thumb: number;
}

/** 资源库查询参数 */
export interface LibraryQuery {
  filter: 'all' | MediaKind;
  query: string;
  sort: 'newest' | 'oldest' | 'largest';
  groupBy: 'conv' | 'type';
}

export interface LibraryGroup {
  key: string;
  /** 分组维度：按会话 or 按类型 */
  kind: 'conv' | 'type';
  title: string;
  convId: string;
  convKind: ConvKind;
  items: MediaItem[];
  /** 会话内最近一次活动时间 */
  latest: number;
  /** 合并了多少条重复（变体归并数） */
  deduped: number;
}

/** 下载任务 */
export interface DownloadTarget {
  itemId: string;
  convId: string;
  url: string;
  ext: string;
  /**
   * 视频条目的 vid（从指纹 `vid:<x>` 中取出）。
   * 用途：原片地址是**带时效的签名 URL**，下载失败时靠它让页面重新解析一份新的。
   */
  vid?: string;
  /** 资源真实生成时间（毫秒 epoch，= `meta.createdAt`）；缺失 → 文件名时间位回退下载时刻 */
  createdAtMs?: number;
  /** 资源所属对话页标题（= `convTitle`）；弱标题 / 缺失 → 文件名标题位回退会话 ID */
  convTitle?: string;
}

export interface DownloadProgress {
  total: number;
  done: number;
  failed: number;
  running: number;
  /** 正在下载的条目 id */
  current: string | null;
  /** 最近一条错误信息 */
  lastError: string | null;
}

/* --------------------------------------------------------------------------- */
/* UI ↔ background 协议载荷                                                     */
/* --------------------------------------------------------------------------- */

/** `state:get` 的应答 */
export interface StateResponse {
  config: Config;
  page: PageInfo;
  /** 豆包页但内容脚本未注入（刚安装未刷新 / 刚被重新启用）→ 弹窗显示「页面需刷新后生效」 */
  stale: boolean;
  /** 当前会话的资源统计 */
  stats: Stats;
  /** 资源库总条数（不受当前会话限制） */
  libraryTotal: number;
  version: string;
  /** 当前下载队列进度 */
  progress: DownloadProgress;
}

/** `state:get` 的入参 */
export interface StateRequest {
  /** 指定要报告状态的标签页（诊断页用） */
  tabId?: number;
  /**
   * 允许「跟随最近一个豆包页」。
   * 只有诊断页会传 true —— 它自己就是 active tab，不跟随的话环境卡片永远显示 none。
   * popup / 侧边栏必须保持默认 false，否则用户在非豆包页打开弹窗会看到别的标签页的状态。
   */
  follow?: boolean;
}

/** `download:one` / `download:many` 的入参 */
export interface DownloadRequest {
  /** 资源库条目 id 列表（从 UI 触发） */
  ids?: string[];
  /** 页面内按钮触发的即时下载（不入库） */
  url?: string;
  ext?: string;
  convId?: string;
}

/** `library:list` 的应答 */
export interface LibraryResponse {
  /** ⚠️ 第四轮起：**已经按当前会话裁剪过**（资源库只针对当前激活的对话） */
  library: Record<string, MediaItem>;
  config: Config;
  /** 当前激活会话；拿不到（非豆包页 / 内容脚本未注入）时为 null */
  scope: ConvScope | null;
}
