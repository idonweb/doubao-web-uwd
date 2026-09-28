/** 存储键、消息类型、限制值、默认配置 —— 除 site-contract 外的第二类集中常量 */

import type { Config } from './types';

export const EXT_NAME = '豆包无水印下载器';
export const EXT_SHORT_NAME = 'UWD';
/** 扩展显示版本（与 package.json 保持同步；manifest 版本在构建期由 package.json 注入） */
export const EXT_VERSION = '1.1.0';

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
export const SCHEMA_VERSION = 2;
/*
 * 版本历史：
 *   1 —— 初版。
 *   2 —— 2026-09-28：图片体积改由 background 实测（`bg.size`），因此在 `migrate()` 里
 *        一次性清掉库里**图片条目**可能存在的旧体积（那一批来自报文里 image 子对象的 `size`，
 *        与真正可下载的文件不是同一个字节数：实机 378 KB ↔ 实际 3.81 MB 的 PNG）。
 *        清掉后由兜底实测重新量一遍 —— 不清理的话，合并（`metaMerge`）会让错数字永远粘住。
 */

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
  /**
   * 「实测文件字节数」的请求超时与每轮上限（2026-09-28 第十轮补丁）。
   *
   * 创作树里没有的条目（超期视频 / 超过约三个月的旧图片）拿不到节点 `size`，
   * 由 background 对条目 `primary` 发一次 `Range: bytes=0-0` 的 GET 读总长 ——
   * 只下 1 字节，但仍然是一次真实网络请求，所以：单次 8s 超时、每轮入库最多 6 条，
   * 且**同一条目在一个 background 生命周期内只测一次**（失败不重试，等 F5 重解析）。
   */
  SIZE_PROBE_TIMEOUT_MS: 8_000,
  SIZE_PROBE_MAX_PER_ROUND: 6,
  /**
   * 待测条目多于一屏时的**分批续跑间隔**（一次性定时器，不是轮询）。
   * 每轮都会把测过的 id 记进 `probedSizeIds`，所以续跑一定收敛到「没有候选」而停下。
   */
  SIZE_PROBE_CONTINUE_MS: 1_500,
  /**
   * 「原片已超期」的**二次确认窗口**（2026-09-28 第十轮）。
   *
   * ⚠️ 实测（`docs/03` §17）：站点创作树对**刚生成的视频存在提交延迟** —— 会话里已经能
   * 看到视频、生成完成消息也推送到了，但此刻查「我的创作」树会「翻到底仍未见」；
   * 实测 50 秒后同一个查询就能查到该 vid（树 148 → 149 条）。
   *
   * 因此「翻到底未见」**不能一次即定论**：首次未见只记录，窗口到点后**重新全量扫描**
   * 仍未见，才判定「原片已超期」并落负缓存。
   * 副作用（已知且接受）：真超期条目会晚一个窗口（约 30s）才显示「原片已超期」，
   * 期间保持「解析中」——与 J3 同一条原则：宁缺勿假，不给假结论。
   */
  VID_EXPIRED_CONFIRM_MS: 30_000,
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
   * bg → content → page：**在页面上定位这条资源并尽力唤起豆包自己的预览**（2026-09-28 第十轮）。
   *
   * 用户拍板的口径：插件不自己造播放器 —— 点资源库的「预览」就**调用豆包页面的同一功能**
   * （弹豆包自己的预览侧栏），插件只当「和豆包网页一样的功能入口」。
   * 做法：按 `mediaPathKey()` 的路径 hash 找到页面里的媒体元素 → 滚动到视口中央 →
   * **尽力**派发一次完整指针序列的点击（站点若校验事件可信度就点不动，那就靠用户手点一下，
   * 目标已经被滚到眼前）。页面侧**只读 DOM + 派发事件**，不注入任何元素/样式。
   */
  PreviewLocate: 'content:preview-locate',
  /** page → content：上一条的应答 `{ found }` */
  PreviewLocated: 'preview-located',
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
