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
  /**
   * 字节 —— **描述的是当前 `primary` 那个文件**。
   *
   * ⚠️ 2026-10-02 §39：它「属于谁」由 `sizeFor` 决定，两者必须成对读。
   */
  size?: number;
  /**
   * **体积归属标记**（2026-10-02 §39，修实机「`3.0 MB` 少了『预览』二字」）：
   * `'raw'` = 这个数字是**无水印原片**的字节数；`'preview'` = 带水印候选流（点下载此刻拿到的那个文件）。
   * 缺省**一律按 `'preview'` 处理**（保守：宁可多标「预览」，也不把候选流的体积谎称成原片）。
   *
   * 为什么需要它：`primary` 从候选流切到原片是**异步**的（vid 三步 API ~1s），而体积实测要 ~0.7s ——
   * 实测结果可能在切换**之后**才写回，于是「候选流的数字」被记在「已经是原片」的条目上；
   * 旧实现只能靠 `primaryIsRaw()` 现场推断，正好把这种数字**误判成原片体积**
   * （实机：卡片写 `3.0 MB` + 「无水印原片」，而真原片是 `7.1 MB`，见 `docs/03` §39）。
   * 有了本标记，标签随数字走，任何写入路径都不可能再错标。
   */
  sizeFor?: 'raw' | 'preview';
  /** 清晰度标签 */
  label?: string;
  /**
   * 模型标识（2026-09-30 第十五轮）：卡片缩略图左下角的「模型药丸」，如 `SD-2.5` / `2.0-Fast`。
   *
   * 来源 = 报文里的模型提示（`site-contract` §2.5）经 `core/model-badge.ts` 折算。
   * ⚠️ 该提示**不在成片那批报文里**（在更早的输入消息 / 任务 ack 里），页面侧是按
   * 「emit 时刻记住的值」快照的（`page/hook.ts::modelHint`）—— 同一会话里换过模型时，
   * 相邻资源的标签理论上可能串味（极窄窗口，代价换「不为此多拉报文」）。
   * 读不到 / 认不出时为 `undefined`：**界面不显示药丸，也不编造模型名**。
   * ⚠️ 与 `RawMedia.videoModel`（`video_model` 内嵌 JSON，指转码规格）无关，别混。
   */
  modelBadge?: string;
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
   * 备选播放源。两个来源，语义一致（都是「带水印的第二条播放地址」）：
   *   · chain 响应的 `fallback_api`（实测带 `logo_type=video_gen_watermark_dyn`）；
   *   · `/video-sharing` 分享接口的 `play_info.backup`（2026-10-02 第十六轮，`site-contract` §2.7）。
   * 实测两者都**永远不是原片**，只作末位候选。
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
   * 📌 2026-10-02：`/video-sharing` 分享页（`site-contract` §2.7）也记 `'thread'` ——
   * 它同样是**站点给出的**分享数据，且页面类型本来就判成 `thread`。
   */
  origin?: 'sse' | 'chain' | 'thread' | 'dom';
  /**
   * 模型药丸文案（2026-09-30 §35.10）—— **由页面侧在解析后写入**：
   * 拿本条资源自己的 `createdAt` 去模型提示时间线里就近取提示，再折算成药丸文案
   * （`core/model-badge.ts::pickModelHintAt / modelBadgeOf`）。
   * `toDraft` 只负责把它搬进 `meta.modelBadge`；取不到时缺省（界面不显示药丸，不编造）。
   * 只对视频有意义（模型提示来自视频生成任务）。
   */
  modelBadge?: string;
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
  /**
   * 该条目所在的**标签页槽**（2026-10-02 §38）。自愈重解析要把新地址写回这个槽 ——
   * 库是多槽的，光有 `itemId`（槽内键）定位不到。内联下载（只有 url）时缺省。
   */
  slotTabId?: number;
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
  /** 资源库条数 —— §38 起 = **当前标签页槽**的条数（不再含别的标签页） */
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

/**
 * `diag:changed` 广播的载荷 —— 诊断页据此实时刷新环境卡片。
 *
 * 为什么要捎带这两样：诊断页自己去发 `state:get` / `library:list` 问，每次都会让 bg
 * 向豆包页发 `tab:query`，从而往诊断缓冲里写 `bg.state` / `content.query` / `page.query`
 * ——三条都是**非关键**记录（`isKeepEvent` 只认 `hook.` / `net.` / `parse.`），
 * 每秒问一次就足以把 `vid.*` / `bg.upsert` 这些真正要看的记录挤出保留水位（`docs/03` §28.3）。
 * 广播本来就是库变化与解析过程的副产物，顺手带上快照，观察者就不必再扰动被测对象。
 */
export interface DiagChangedPayload {
  /** 当前诊断记录条数 */
  count?: number;
  /** 资源库条数（与 `library:list` 的 `Object.keys(library).length` 同源） */
  lib?: number;
  /** 当前会话作用域快照；`null` = 已无激活会话（离开会话已清库） */
  scope?: ConvScope | null;
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
  /**
   * ⚠️ 第四轮起就**已经裁剪过**，2026-10-02 §38 起裁剪范围 = **请求方标签页的槽**：
   * 槽内只留该标签页的当前会话（`retainConv` 语义不变），别的标签页的槽互不干扰。
   */
  library: Record<string, MediaItem>;
  config: Config;
  /** 当前激活会话（该标签页的）；拿不到（非豆包页 / 内容脚本未注入）时为 null */
  scope: ConvScope | null;
}

/**
 * `library:list` 的入参（2026-10-02 §38）。
 *
 * 与 `state:get` 同一套「报告目标」语义：弹窗（活动标签页就是用户在看的那页）不传即可；
 * **诊断页必须传 `follow: true`** —— 它自己就是 active tab，不跟随的话拿到的是「诊断页那个
 * 不存在的槽」（永远是空库）。
 */
export interface LibraryRequest {
  tabId?: number;
  follow?: boolean;
}

/**
 * `library:sync`（bg → UI）：**当前标签页槽**的资源库快照（2026-10-02 §38）。
 *
 * UI 没有 tabId（扩展页不在标签页里），所以库的实时刷新由 bg 主动推；
 * `convId` 用于让 UI 自行校验这条广播与它当前显示的会话是否一致。
 */
export interface LibrarySyncPayload {
  convId: string;
  library: Record<string, MediaItem>;
}
