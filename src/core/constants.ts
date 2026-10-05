/** 存储键、消息类型、限制值、默认配置 —— 除 site-contract 外的第二类集中常量 */

import type { Config } from './types';

export const EXT_NAME = '豆包无水印下载器';
export const EXT_SHORT_NAME = 'UWD';
/** 扩展显示版本（与 package.json 保持同步；manifest 版本在构建期由 package.json 注入） */
export const EXT_VERSION = '1.3.2';

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
export const SCHEMA_VERSION = 3;
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
  /** 资源库上限，超出按 lastSeen 升序 FIFO 淘汰 —— ⚠️ §38 起是**每个标签页槽**各自的上限 */
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
   * 「我的创作」树索引的缓存有效期（2026-09-27 Finding C 修复；2026-09-28 第十二轮 60s → 5min）。
   *
   * node_info 是分页列表（图文混排、最新在前），一次翻页扫描建好的 key→node_id 索引
   * 可以在短时间内服务多个 vid，避免每个 vid 都重扫整棵树。索引过期 ≠ 数据过期：
   * 新创作会插到树的最前面，所以索引只做 TTL 缓存；判定「原片已超期」前还会做
   * head 校验（第 1 页首条 key 是否变化）确保树没变过。
   *
   * ⚠️ 2026-09-28 第十二轮实机教训（`docs/03` §23.5）：tree 全量 = 8 页请求，60s TTL 意味着
   * 每 60s 就把同一棵账号级树重翻一遍；实测站点会对密集的 node_info 请求**软限流**
   * （200 + 空响应体）→ 解析整批失败且索引建不成 → 下次重试又重翻 → 死循环。
   * 放宽到 5 分钟：树的变化速率 ≈ 15 条/天，5 分钟内的旧索引足够新（head 校验仍兜底）。
   */
  VID_INDEX_TTL_MS: 5 * 60_000,
  /**
   * vid 解析**网络层失败**后的重试冷却（2026-09-28 第十二轮 §23.5）。
   *
   * 实测站点会对密集的 node_info 请求软限流（200 + 空响应体）；而 chain 报文约每 60s
   * 自动重放一次、每次都会重新触发解析 —— 若失败后立刻可重试，就会形成
   * 「重试 → 重翻 8 页树 → 仍被限流 → 索引建不成 → 再重试」的死循环，把限流喂着永不恢复，
   * 界面上表现为「永远解析中」。冷却期内 `resolve()` 直接短路（不发任何请求），
   * `force: true`（下载失败自愈）不受冷却限制；解析成功即清除冷却。
   */
  VID_RETRY_COOLDOWN_MS: 3 * 60_000,
  /**
   * 「实测文件字节数」的请求超时与每轮上限（2026-09-28 第十轮补丁；2026-10-02 §37 改「入库即测」）。
   *
   * 创作树里没有的条目（候选流 / 超期视频 / 超过约三个月的旧图片）拿不到节点 `size`，
   * 由 background 对条目 `primary` 发一次 `Range: bytes=0-0` 的 GET 读总长 ——
   * 只下 1 字节，但仍然是一次真实网络请求，所以：单次 8s 超时、每轮入库最多 6 条。
   *
   * ⚠️ 调度规则 2026-10-02 改版（用户拍板，见 `core/size-probe.ts` 文件头）：
   *   · **不再等「已定局」** —— 入库即测（`state=pending` 也测），界面先显示「预览体积」，
   *     原片解析成功后再由创作树真值覆盖；
   *   · **按「条目 + 归一化地址」记账**，地址换成另一个文件就允许重测；
   *   · 失败**只重试 `SIZE_PROBE_RETRY` 次**（用户拍板：1 次），仍失败等 F5 重解析，绝不轮询。
   */
  SIZE_PROBE_TIMEOUT_MS: 8_000,
  SIZE_PROBE_MAX_PER_ROUND: 6,
  /**
   * 单次体积探测失败后的**重试次数**（2026-10-02 §37，用户拍板：只重试 1 次）。
   *
   * 为什么需要：探测是一次真实网络请求，偶发失败（超时 / CDN 抖动 / 读不到头）会让卡片
   * 永久空着体积 —— 原实现甚至把失败也记成「测过」，连 F5 之外没有任何翻案机会。
   * 为什么不能多：与 vid 解析的失败冷却同一考量（踩坑 21）—— 无上限重试会把站点限流
   * 喂着永不恢复；1 次重试足够盖住偶发抖动，确定性失败（403 / 结构变化）留给 F5。
   */
  SIZE_PROBE_RETRY: 1,
  /** 失败重试前的等待（2s；给 CDN 抖动一点恢复时间，也不至于让用户等太久） */
  SIZE_PROBE_RETRY_DELAY_MS: 2_000,
  /**
   * 待测条目多于一屏时的**分批续跑间隔**（一次性定时器，不是轮询）。
   * 每轮都会把测过的 id 记进 `probedSizeIds`，所以续跑一定收敛到「没有候选」而停下。
   */
  SIZE_PROBE_CONTINUE_MS: 1_500,
  /**
   * 「升级补测」的**自触发延迟**（2026-10-02 §41，一次性定时器，不是轮询）。
   *
   * 背景（实机）：探测批次在飞期间创作树真值落库 → 迟到的预览实测曾把真值降级覆盖
   * （现由 `probeWriteBlocked` 拦下）；而「原片就绪但手里只有预览体积」的升级测量
   * 原本只挂在「下一次 upsert」上 —— 用户不动界面就没有下一次，卡片长期停在
   * 「预览 5.1 MB」（体感 ~39s 才翻正）。现在写回预览体积且条目已原片就绪时，
   * 主动排一次补测（1.5s 后，走同一套「条目 + 阶段 + 地址」记账与额度，有界收敛）。
   */
  SIZE_PROBE_UPGRADE_DELAY_MS: 1_500,
  /**
   * 「原片已超期」的**结论阈值**（首次「树里未见」后经过多久仍未见，才允许判超期）。
   *
   * ⚠️ 实测（docs/03 §17 / §26.5 / §27.1 / §29.1）：站点创作树对**刚生成的视频存在提交延迟** ——
   * 会话里已经能看到视频、生成完成消息也推送到了，但此刻查「我的创作」树会「翻到底仍未见」。
   * 观测样本（延迟上界）：50s（§17 粗样本）、34s（§26.5 粗样本）、11.7s（§27.1）、10.19s（§29.1）、
   * **>100s（§33 实机样本：21:38:27 生成 → 21:38:29 首次未见 → 21:38:51 误判超期，21:40:07 树仍未变）**。
   *
   * 「翻到底未见」**不能一次即定论**：首次未见只记录，此后**轮次式重扫**
   * （`VID_RECHECK_INTERVAL_MS` = **固定 10s**、至多 30 轮 = 5min，2026-09-28 拍板 / §34 定稿；
   * 同时充当延迟区间的测量仪器），
   * 经过本阈值仍未见才判定「原片已超期」并落负缓存 —— **前提是资源已经不新**（见下）。
   *
   * **20s（2026-09-29 用户拍板，§31）**：= **2 轮 10s 重扫**（每轮间隔 10s + 本轮翻树耗时 ~2.2s，
   * 故第 2 轮落在 +22~25s，已过阈值 → 定案）。原为 60s（观测上界 50s + 余量），
   * 用户实测认为「真超期条目等 60s 才出结论」太久，20s 足够。
   *
   * ⚠️ 本阈值**只对「已经不新」的资源有效** —— 20~50s 才提交的样本（§17 的 50s、§26.5 的 34s）
   * 会**先被误判成「原片已超期」**，且负缓存与正缓存同 TTL（`VID_RESOLVE_TTL_MS` = 10min），
   * 期间 chain 重放不会自动重查树，要等 F5 / 切会话才翻案。
   * 2026-09-29 §33 起由 **`VID_FRESH_RESOURCE_MS` 年龄闸门**兜住这一类（新作品不下超期结论）。
   * ⚠️ 2026-10-04 第三十六轮 §54 再收一步：**年龄已知且早已越过入库窗口**的资源
   * （对话页几个月前的老视频）**首次未见即定案**，根本不走本阈值 —— 这个 20s 等待
   * 只对「还新 / 年龄未知」的资源生效（老视频从此 ~2-3s 出「无水印（超期补救）」）。
   * ⚠️ 这段等待期界面**只显示保底的「解析中」**：曾试过的「新作品入库中」标签因触发条件是与
   * 站点提交速度的竞态（无法按需验证）已被整体删除（§30）。
   */
  VID_EXPIRED_CONFIRM_MS: 20_000,
  /**
   * 「新作品入库窗口」（毫秒）：资源的**真实生成时间**（消息 `create_time`，见踩坑 19）距今不足
   * 这个时长时，「创作树翻到底没有它」**一律不下「原片已超期」的结论**（2026-09-29 §33 修 Bug）。
   *
   * 成因（实机复现，`docs/03` §33）：21:38:27 生成完成的视频，消息 21:38:28 到达后开始查树，
   * 整棵树从头到尾都是 152 条、纹丝不动 —— 21:38:51（首次未见 +21.9s）就被判「原片已超期」，
   * 而到 21:40:07 树仍是 152 条。故「树里没有」当时**只说明站点还没登记**，20s 的确认阈值
   * 根本盖不住这个延迟（历史观测上界 50s，本条样本实测 > 100s）。
   *
   * 判定口径：**刚生成的作品缺树 = 站点入库延迟**（连弱结论都不该给，界面维持保底「解析中」）；
   * 只有**已经不新**的作品缺树才可能是「超出约三个月保存期」，才值得下超期结论。
   * 30min 的取法：远大于所有观测到的入库延迟（秒级~分钟级），又远小于保存期（月级）。
   * ⚠️ 取不到生成时间（`meta.createdAt` 缺失）时本闸门不生效，保持旧行为（宁缺勿假的反面例外，
   * 已在诊断文案里写明年龄未知）。
   */
  VID_FRESH_RESOURCE_MS: 30 * 60_000,
  /**
   * 「树里首次未见」后的重扫间隔（2026-09-28 用户拍板：10s 一轮，替代原 30s 一次性复查）。
   *
   * ⚠️ **固定 10s，不退避**（2026-09-29 第十四轮 §34，用户拍板）：配合同一轮次上限
   * （`page/hook.ts::RECHECK_MAX_ROUNDS = 30`）＝ **固定 10s × 30 轮 = 5min**。
   * 曾短暂试过「逐轮退避到 60s」（§33），用户实测后要求改回固定 10s —— 粒度均匀才好把
   * 「站点登记延迟」测准（轮次本身就是这个延迟的量尺）。
   * 成本可控的原因：等待期走**廉价路径**（吃 5min 索引 + 1 次 head 校验），
   * 所以 30 轮是 30 个轻请求，不是 30 次全量翻树。
   */
  VID_RECHECK_INTERVAL_MS: 10_000,
  /** 单次发送给 background 的草稿上限（防超大消息） */
  DRAFT_BATCH_MAX: 40,
  /** 诊断：最多保留多少条记录（2026-09-28 §26 后放宽为 500：非关键记录有 25% 保留水位，多 100 条能存下更完整的 vid.* 证据序列） */
  DIAG_MAX_RECORDS: 500,
  /** 诊断：单条记录里原始文本的最大长度 */
  DIAG_MAX_TEXT: 6000,
  /** 诊断：整体最大字节数（超出从最旧的开始丢） */
  DIAG_MAX_BYTES: 900_000,
  /**
   * 补角重建条目的**卡片封面**长边像素（2026-10-03 第三十一轮）。
   *
   * 卡片缩略图最大也就 ~200px 宽，480px 足够清晰（含高分屏），又能把 data URL 压在
   * ~20KB 量级；再大只是白花解码 / 传输成本（封面是**预览用**，不是交付物）。
   */
  PATCH_COVER_MAX_PX: 480,
  /** 封面 JPEG 质量（0~1）。封面只用于屏幕显示，0.82 肉眼无损、体积减半。 */
  PATCH_COVER_QUALITY: 0.82,
  /**
   * 页面侧封面缓存条数（FIFO）。
   *
   * 缓存的是合成好的 data URL（~20KB 一张），按「底板地址 + 来源档地址」为键 ——
   * 弹窗每次重新打开（模块重载）都会再问一遍，有它就不必重新取两档全尺寸图。
   * 12 条 ≈ 250KB，足以覆盖一屏可见的补角条目。
   */
  PATCH_COVER_CACHE_MAX: 12,
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
  /**
   * bg → content：**补角重建后下载**（2026-10-03 第二十三轮 §43.9 方案 B）。
   *
   * 老链路「修改生成」的图片（`msg.content.image_list[*]`）站点只给了两档带水印的**同源底图**，
   * 没有现成的无水印档；页面侧取两档 → 同源校验 → 把来源档的水印矩形**原样覆盖**到底板上
   * → 合成出的就是无水印图（无损，见 `core/image-patch.ts`）。MV3 的 service worker
   * 没有 OffscreenCanvas / createObjectURL，所以这一步必须在页面上下文里做。
   * 回执：`{ ok, patched }` —— `patched:false` 表示**同源校验没过**（未合成、未下载），
   * 由 bg 退回「直接下带水印原图」并把条目标成 `meta.patchFail`。
   */
  FetchPatchBlob: 'content:fetch-patch-blob',

  /**
   * bg → content：**解析分享页视频的无水印直链**（2026-10-03 第二十八轮 §48）。
   *
   * 为什么必须走页面：① `get_video_model` 要**登录 cookie**（同源请求才带得上）；
   * ② fplay 响应是**跨域**，要靠 DNR 注入的 CORS 头（`||vas-lf-x.snssdk.com/`）。
   *
   * 请求 `{ vid, quality }`；回执 `{ ok, url?, error? }`。
   * ⚠️ 直链**带时效** ⇒ 只能在**下载那一刻**现解现用，**绝不入库**。
   */
  ResolveShareVideo: 'content:resolve-share-video',

  /**
   * bg → content：**合成补角重建图的卡片封面**（2026-10-03 第三十一轮）。
   *
   * 为什么要有这条：补角条目的卡片封面原本直接用站点的 `image_thumb`
   * （`downsize_watermark`，**带水印**）—— 卡片上写着「无水印（补角重建）」，
   * 封面却是一个带水印的缩略图，自相矛盾（`docs/03` §45.1 的开放子项）。
   *
   * 做法与下载链路**同一套**（取两档 → 同源校验 → 覆盖 → 降采样），只是产物不落盘，
   * 而是缩到 `LIMITS.PATCH_COVER_MAX_PX` 后编码成 **data URL** 回给弹窗填 `<img src>`。
   *
   * ⚠️ **只在弹窗要显示时才做**（`IntersectionObserver` 只对可见卡片发问）：合成要取两档
   *   **全尺寸**图，提前给整个会话的图都做一遍是白耗流量。
   * ⚠️ **不落库**：data URL 只活在这一次弹窗里（页面侧另有一份有界缓存，见
   *   `LIMITS.PATCH_COVER_CACHE_MAX`）—— 像素不是资源的描述，没必要写进存储。
   * 回执：`{ ok, cover? , error? }`；失败（取图失败 / 同源校验没过 / 页面不支持 canvas）
   * 时弹窗**保持站点缩略图**，不假装有封面。
   */
  PatchCover: 'content:patch-cover',

  /* ---- UI ↔ bg ---- */
  StateGet: 'state:get',
  ConfigPatch: 'config:patch',
  LibraryList: 'library:list',
  DownloadOne: 'download:one',
  DownloadMany: 'download:many',
  DownloadRetry: 'download:retry',
  DownloadProgress: 'download:progress',
  /**
   * bg → UI：**当前标签页槽**的资源库有更新（2026-10-02 §38）。
   *
   * 为什么需要这条广播：库改为**按标签页分槽**后（`storage.ts::LibrarySlots`），
   * UI（扩展页）没有 tabId，无法从 `storage.onChanged` 里挑出自己的槽 ——
   * 所以由 bg 在写槽之后**主动推**「这个标签页当前的槽」给 UI。
   * 同一时刻只会有一个弹窗（扩展弹窗是单例），因此无条件采用是安全的；
   * 诊断页仍走 `diag:changed` 的快照（`lib` 字段 = 当前槽条数）。
   */
  LibrarySync: 'library:sync',

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

/**
 * 「补角重建」条目的文案（2026-10-03 第二十三轮 §43.9 方案 B）。
 *
 * ⚠️ **必须与「无水印原片」区分开**：这一族（老链路 `msg.content.image_list[*]`）站点**没给**原片，
 * 只有两张带水印的同源底图；无水印是**本插件在下载时互补还原**出来的。
 * 按「宁缺勿假」，界面如实写「重建」，绝不冒充站点原片。
 */
export const IMG_PATCH_LABEL = '无水印（补角重建）';
/** 补角**同源校验未通过** ⇒ 只能下到带水印的那一档，如实说（`meta.patchFail`） */
export const IMG_PATCH_FAIL_LABEL = '仅带水印档';

/**
 * **分享页视频**条目的文案（2026-10-03 第三十轮 §48.7）。
 *
 * 分享页视频被判「原片不可得」（`meta.expired`，创作树按登录账号隔离、别人的作品永远不在）
 * **不等于**拿不到无水印 —— §47/§48 之后分享直链两档可下（轻量 / 原画质）。
 * 旧口径「原片不可得」在这个场景自相矛盾（卡片标着取不到、下载却拿到无水印文件），
 * 故按补角条目的先例（落地即标能力、失败才降级），分享页视频直接标本标签。
 * ⚠️ **2026-10-04 §55 起「标签判据 = 行为判据」**：分享页视频**一经识别即**标本标签，
 * 不再等 `meta.expired`（旧口径要等 vid 三步链路翻完树 + 20s 确认窗口，实机体感是
 * 「下载已经生效、标签还停在『解析中』」）。悬停说明仍等 `meta.expired`（见 `stateTagTitle`）。
 * ⚠️ **只用于 `convKind='thread'` 且 `kind='video'`**；对话页「原片已超期」与分享页图片不动。
 */
export const SHARE_VIDEO_LABEL = '无水印（分享页）';

/**
 * **对话页「超期视频」**条目的文案（2026-10-04 第三十五轮）。
 *
 * 对话页（创作者本人）里生成超过约三个月的视频，创作树原片已被清除（`meta.expired`）——
 * 但这**不等于**拿不到无水印：实测（同一 vid 152 天前，`docs/03` §53）站点的播放源
 * 仍能换出**无水印的原画质档**（`fallback_api` → `codec_type=5 + force_fids=original`）。
 * 语义与分享页视频同源（落地即标能力、失败才降级），但措辞必须说清**这是原片超期后的补救**，
 * 不是站点给的原片。
 *
 * ⚠️ **只用于 `convKind='chat'` 且 `kind='video'` 且 `meta.expired`**；分享页用 `SHARE_VIDEO_LABEL`。
 */
export const CHAT_EXPIRED_LABEL = '无水印（超期补救）';

/** 取流方案：A = chrome.downloads + DNR 注入 Referer；B = content 内 fetch + blob（回退） */
export const DOWNLOAD_STRATEGY: 'auto' | 'downloads' | 'blob' = 'auto';
