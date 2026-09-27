/** 存储键、消息类型、限制值、默认配置 —— 除 site-contract 外的第二类集中常量 */

import type { Config } from './types';

export const EXT_NAME = '豆包无水印下载器';
export const EXT_SHORT_NAME = 'UWD';
/** 扩展显示版本（与 package.json 保持同步；manifest 版本在构建期由 package.json 注入） */
export const EXT_VERSION = '1.0.2';

/**
 * GitHub 仓库地址（2026-09-27 首发时回填）。
 *
 * 弹窗头部有一个图标按钮（第五轮 N7）：本常量为空时按钮置灰不可点，
 * 填上真实地址即自动启用 —— **不需要改任何 UI 代码**，这是当初把它做成常量的原因。
 */
export const REPO_URL = 'https://github.com/idonweb/doubao-web-uwd';

/**
 * 开发者信息（弹窗头部版本号下方展示，2026-09-27 用户要求）。
 *
 * 只存 uid，B 站主页链接由它拼出 —— 避免同一个数字在代码里出现两遍。
 * ⚠️ 署名与 `LICENSE` 里保留的上游作者（B站 Tps-pwd / 嗯哼de呀）是两回事：
 * 这里是**本重构版本的开发者**，上游署名仍须保留（GPL-3.0）。
 */
export const AUTHOR_BILI_UID = '400911';
export const AUTHOR_BILI_NAME = 'B站 @暮星河';

/** 存储 schema 版本，用于未来迁移 */
export const SCHEMA_VERSION = 1;

/** chrome.storage.local 的键（统一 uwd: 前缀，与上游命名彻底隔离） */
export const STORAGE = {
  schemaVersion: 'uwd:schemaVersion',
  config: 'uwd:config',
  library: 'uwd:library',
  /** 诊断记录（真机联调用；有界环形缓冲，不参与业务逻辑） */
  diag: 'uwd:diag',
} as const;

export const LIMITS = {
  /** 资源库上限，超出按 lastSeen 升序 FIFO 淘汰 */
  LIBRARY_MAX: 99,
  /** 下载并发（豆包限流未知，取保守值 1） */
  DOWNLOAD_CONCURRENCY: 1,
  /** 失败重试次数 */
  DOWNLOAD_RETRY: 1,
  /** SSE 读取超时（视频生成可能持续 3 分钟） */
  SSE_READ_TIMEOUT_MS: 180_000,
  /** vid 三步 API 单次请求超时 */
  VID_RESOLVE_TIMEOUT_MS: 20_000,
  /**
   * vid 解析结果的缓存有效期。
   *
   * ⚠️ 豆包返回的原片地址是**带签名的带时效 URL**（路径里含时间戳与签名段）。
   * 早期版本把解析结果**永久缓存**，导致「切走再切回（页面没重载，resolver 实例还在）」
   * 时拿到的是已经过期的地址 → 下载 403 → 界面显示「获取失败」。
   * 这里给缓存加一个保守的 TTL：过期即重新走三步 API 换新签名。
   */
  VID_RESOLVE_TTL_MS: 10 * 60_000,
  /**
   * 「我的创作」树索引的缓存有效期（2026-09-27 Finding C 修复）。
   *
   * node_info 是分页列表（图文混排、最新在前），一次翻页扫描建好的 key→node_id 索引
   * 可以在短时间内服务多个 vid，避免每个 vid 都重扫整棵树。索引过期 ≠ 数据过期：
   * 新创作会插到树的最前面，所以索引只做短 TTL 缓存；判定「原片已超期」前还会做
   * head 校验（第 1 页首条 key 是否变化）确保树没变过。
   */
  VID_INDEX_TTL_MS: 60_000,
  /** 单次发送给 background 的草稿上限（防超大消息） */
  DRAFT_BATCH_MAX: 40,
  /** 诊断：最多保留多少条记录 */
  DIAG_MAX_RECORDS: 400,
  /** 诊断：单条记录里原始文本的最大长度 */
  DIAG_MAX_TEXT: 6000,
  /** 诊断：整体最大字节数（超出从最旧的开始丢） */
  DIAG_MAX_BYTES: 900_000,
} as const;

export const DEFAULT_CONFIG: Config = {
  skipThumbOnly: true,
  theme: 'system',
};

/** 消息类型（信封内 type 字段的唯一取值来源，禁止裸字符串散落业务代码） */
export const MSG = {
  /* ---- MAIN ↔ ISOLATED（window.postMessage） ---- */
  /** content → page：索取当前页面信息 */
  PageQuery: 'page-query',
  /** page → content：当前页面信息（page-query 的应答） */
  PageInfo: 'page-info',
  /** page → content：解析到一批媒体草稿 */
  MediaCaptured: 'media-captured',
  /** page → content：一条诊断记录 */
  PageDiag: 'page-diag',
  /** page → content → bg：当前激活会话变了（资源库按会话作用域裁剪的依据） */
  ConvScope: 'conv:scope',
  /** content → page：下发配置 */
  PageConfig: 'page-config',
  /** bg → content → page：要求重新解析某个 vid（签名地址过期后自愈用） */
  ReresolveVid: 'content:reresolve-vid',
  /** page → content：上一条的应答 */
  VidResolved: 'video-resolved',
  /**
   * page → content → bg：vid 的原片已超期（2026-09-27 Finding C 修复）。
   *
   * 页面侧翻遍整棵「我的创作」树仍未见到该 vid —— 站点对创作记录有保存期限，
   * 原片**永远**取不到了。这是确定性结论（不是网络失败），bg 据此把条目
   * 从「解析中」落成「原片已超期」（state=fail + meta.expired），不再永挂。
   */
  LibraryExpire: 'library:expire',

  /* ---- content ↔ bg（chrome.runtime.sendMessage） ---- */
  /** bg → content：索取当前页面信息（会再转问 MAIN world） */
  TabQuery: 'tab:query',
  /** content → bg：上报媒体草稿 */
  MediaAppend: 'media:append',
  /** bg → content：在页面上下文里 fetch + blob 下载（取流方案 B） */
  FetchBlob: 'content:fetch-blob',

  /* ---- UI ↔ bg ---- */
  StateGet: 'state:get',
  ConfigPatch: 'config:patch',
  LibraryList: 'library:list',
  DownloadOne: 'download:one',
  DownloadMany: 'download:many',
  DownloadRetry: 'download:retry',
  DownloadProgress: 'download:progress',

  /* ---- 诊断（真机联调） ---- */
  /** content → bg：追加诊断记录 */
  DiagAppend: 'diag:append',
  /** UI → bg：读取全部诊断记录 */
  DiagGet: 'diag:get',
  /** UI → bg：清空诊断记录 */
  DiagClear: 'diag:clear',
  /** bg → UI：诊断记录有更新 */
  DiagChanged: 'diag:changed',
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

/** 页面类型中文名（UI 展示用） */
export const PAGE_KIND_LABEL: Record<string, string> = {
  chat: '对话页',
  thread: '分享链接页',
  none: '非豆包页面',
};

/**
 * 会话名的**界面兜底文案**（第四轮 2026-09-26 用户拍板）。
 *
 * 拿不到真实会话标题时，界面上统一显示这一条 —— 用户明确不要 `豆包对话 <id8>` 那种带 ID 的写法。
 * ⚠️ 它**只用于展示**：绝不写进资源库（`retitleConv` 会拒收弱标题），
 * 所以「还没解析到标题」这件事始终可重试、不会被假标题永久盖住。
 */
export const DEFAULT_CONV_TITLE = '豆包-AI 智能助手';

/** 资源库状态标签（UI 展示用） */
export const STATE_LABEL: Record<string, string> = {
  raw: '无水印原片',
  thumb: '仅缩略图',
  pending: '解析中',
  fail: '获取失败',
};

/** 取流方案：A = chrome.downloads + DNR 注入 Referer；B = content 内 fetch + blob（回退） */
export const DOWNLOAD_STRATEGY: 'auto' | 'downloads' | 'blob' = 'auto';
