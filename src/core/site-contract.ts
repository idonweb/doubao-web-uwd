/**
 * 站点私有契约（site-contract）—— **本文件是本项目唯一允许写站点私有常量的地方**。
 *
 * 为什么单独成文件：豆包的接口路径、响应字段路径、水印改写规则、DOM 选择器全部属于
 * 「外部不可控契约」，站点一次改版会同时失效。集中在一处，改版时只改这里。
 * 上游把这批常量散落在 4 个文件里，是本次重构最实际的收益点之一。
 *
 * 来源标注规则：
 *   [上游] = 直接照搬上游 doubao-seedance-15s@1ead7714 的实测结论（已在线验证可用）
 *   [实测] = 需要在 P2 阶段用真实豆包页面确认后回填
 */

/* ============================================================================
 * §1 路径与接口
 * ========================================================================== */

/** 对话页路径特征 [上游] */
export const CHAT_PATH_PATTERN = /\/chat\//;
/** 分享链接页路径特征 [上游] */
export const THREAD_PATH_PATTERN = /\/thread\//;
/**
 * **视频分享页**路径特征（单条视频的 H5 分享页）[实测 2026-10-02]
 *
 * 站位形态（用户手机上「分享 → 复制链接」得到的）：
 *   `https://www.doubao.com/video-sharing?source_type=mobile&share_id=<19位数字>&video_id=<vid>`
 * `location.pathname` 就是 `/video-sharing`（**没有尾斜杠**，别写成 `/video-sharing/`）。
 *
 * 它与 `/thread/`（整段对话分享）一样属于**分享页**，因此本项目把它判成 `kind='thread'` ——
 * 资源库作用域、页面徽标「分享页」、「原片不可得」这套措辞全部沿用现成实现，
 * **不新增页面类型**（新增会牵动 `ConvKind` / UI 徽标 / 后台作用域好几处）。
 * 它唯一不同的是**数据来源**：页面渲染前由路由 loader 单独发一个接口，见 §2.7。
 */
export const VIDEO_SHARE_PATH_PATTERN = /\/video-sharing(?:\/|$)/;
/** 从 URL 中提取会话 ID 的特征（/chat/<id> 或 /thread/<id>） [上游] */
export const CONV_ID_PATTERN = /\/(?:chat|thread)\/([A-Za-z0-9_-]+)/;

/**
 * 新建会话的**临时占位会话 ID 前缀** [实测 2026-09-27 · 单样本]
 *
 * 实测流程（2026-09-27 第七轮）：新建对话时站点先把 URL 导到 `/chat/local_<数字>`
 * （此时服务端还没分配会话 ID），提交首条消息后才分配真实 ID 并 `replaceState` 换掉占位值。
 * 因此「请求发出时刻」从 URL 提取的 convId 可能是占位值，而「响应到达时刻」页面已是真实 ID
 * —— 两者永不相等，按旧逻辑会把携带 creation_block 的 SSE 生成响应误判为「异会话」整体丢弃
 * （实测现象：新会话生成的视频在生成阶段无法入库，只能等几分钟后的 chain 推送）。
 * ⚠️ 目前只有一次实测样本（`local_1371803923460589`）；站点若更换占位格式，改这里即可。
 */
export const LOCAL_CONV_ID_PREFIX = 'local_';

/** 判断会话 ID 是否为「新建会话的临时占位 ID」 */
export function isLocalConvId(convId: string | undefined | null): boolean {
  return Boolean(convId && convId.startsWith(LOCAL_CONV_ID_PREFIX));
}

/**
 * 运行期判断 URL 是否属于**豆包域**（doubao.com / dola.com 及其子域）。
 *
 * 2026-09-27 第八轮补充：弹窗的「非会话页」徽标需要区分
 * 「豆包站内但尚未开始对话」（豆包首页）与「压根不在豆包」两种情形 ——
 * 域名知识属于站点契约，集中在这里（与 `HOST_PERMISSIONS` / bg 的 `isDoubaoUrl` 同源）。
 */
export function isDoubaoHostUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return /(?:^|\.)(?:doubao|dola)\.com$/.test(hostname);
  } catch {
    return false;
  }
}

/**
 * 从 SSE / chain 响应**文本**里收集 conversation_id 的正则 [实测 2026-09-27]
 *
 * 为什么按文本正则而不是解析后取字段：conversation_id 在响应体里出现的位置不固定
 * （SSE 的 SSE_ACK / FULL_MSG_NOTIFY、chain 的 `messages[].conversation_id`），
 * 且经常被包在**多层转义的 JSON 字符串**里（`\"conversation_id\":\"38444...\"`）。
 * 这里容忍 0~4 个反斜杠的转义深度；取值字符集与 CONV_ID_PATTERN 一致（含 `local_` 占位）。
 */
export const RESPONSE_CONV_ID_RE =
  /\\{0,4}"conversation_id\\{0,4}"\s*:\s*\\{0,4}"([A-Za-z0-9_-]+)\\{0,4}"/g;

/** SSE 流式响应端点：无水印原片 URL 的主要来源 [上游] */
export const SSE_ENDPOINT = '/chat/completion';
/** REST 端点：历史会话消息，main_url 为 base64 [上游] */
export const CHAIN_ENDPOINT = '/im/chain/single';

/** vid → 无水印原片的三步 API 固定 query [上游] */
export const AISPACE_QUERY =
  'aid=497858&device_platform=web&samantha_web=1' +
  '&use-olympus-account=1&version_code=20800&pkg_type=release_version';

export const AISPACE_HOMEPAGE = '/samantha/aispace/homepage';
export const AISPACE_NODE_INFO = '/samantha/aispace/node_info';
export const AISPACE_GET_DOWNLOAD_INFO = '/samantha/aispace/get_download_info';

/** 接口按「名称」匹配创作根节点，中文字面量 [上游] */
export const CREATION_ROOT_NAME = '我的创作';

/**
 * node_info 单页条数 [实测 2026-09-27，Finding C 探针]
 *
 * 上游写死 `size: 50` 且只拉第一页。实测「我的创作」树是**图文混排、最新在前**的分页列表
 * （2026-09-27 实测某账号全树 1420 条 = 1387 图 + 33 视频），条目超过 50 之后，
 * 排在后面的 vid 就永远找不到 —— 树里有但解析失败。站点对 200 照单全收，故提到 200。
 */
export const AISPACE_NODE_PAGE_SIZE = 200;

/** node_info 翻页的请求体游标字段名 [实测 2026-09-27：body.cursor = 上一页响应的 next_cursor] */
export const AISPACE_CURSOR_PARAM = 'cursor';

/** node_info 响应 data 里的翻页字段 [实测 2026-09-27] */
export const AISPACE_NEXT_CURSOR_KEY = 'next_cursor';
export const AISPACE_HAS_MORE_KEY = 'has_more';

/**
 * node_info 翻页上限。
 *
 * 10 页 × 200 = 2000 条，已大于实测全树（1420）；设上限是防异常大树打爆请求。
 * ⚠️ 翻到底（`has_more=false`）仍未见该 vid = **确定性结论**：站点对「我的创作」有保存期限
 * （2026-09-27 实测：6 月 23 日生成的视频原片仍可解析、5 月的 vid 已被清除 → 窗口约三个月，
 * 以「最早可解析日」为准），该 vid 的原片**永远**取不到
 * —— 这不是网络失败，重试没有意义（「原片已超期」状态的依据）。
 * ⚠️ 2026-09-28 补正：**一个观测不足以定论** —— 站点创作树对刚生成的视频有提交延迟
 * （实测：生成完成消息到达后 0.5s 查树「翻到底未见」，50s 后同一个查询即可见）。
 * 现行做法是 30s 二次确认窗口（`LIMITS.VID_EXPIRED_CONFIRM_MS`，见 `vid-resolver.ts`）。
 */
export const AISPACE_WALK_MAX_PAGES = 10;

/* ---------------------------------------------------------------------------
 * node_info 的**节点字段**（2026-09-28 只读探针实测，种子样本 149 条）
 *
 * 实测一个节点的完整字段：
 *   id / name / key / node_type / size / source / content / name_review_status /
 *   content_review_status / risk_review_status / **conversation_id** / operation_status /
 *   node_cover / parent_id / **create_time** / **update_time**
 *
 * 有用的几个：
 *   · `key`      —— 视频是 **vid**、图片是无水印原片路径（去查询参数后的路径）；
 *   · `create_time` / `update_time` —— **秒级 Unix 时间戳**，就是「作品真实生成时间」
 *     （资源库「最新/最早」的排序依据，2026-09-28 第十轮补做）；
 *   · `conversation_id` —— 该创作所属会话（可用于归属校验，目前未用）；
 *   · `node_type` —— 4 = 图片、6 = 视频（实测值）；
 *   · `content.duration` —— 视频时长（秒，如 15.05）；
 *   · `node_cover.list_view.image_width / image_height` —— 视频节点上是**整帧尺寸**，
 *     即原片真实帧宽高（2026-09-28 第十二轮探针 37 条样本证实：34 条落在 720P 横/竖档位、
 *     3 条 1470×630 超宽幅也经用户核对为真实尺寸 —— 异形尺寸同样如实反映）。
 *     ⚠️ **图片节点上是缩略图尺寸**（实测 28×28 / 116×116），因此**不能**拿它给图片补真实宽高；
 *     本字段只随 vid 解析路径使用（该路径只有视频），天然不会碰到图片节点。
 *
 * ⚠️ 请求体里的 `sort_param: {sort_type: 0, sort_order: 1}` 是照搬上游的固定值；
 * 实测响应**不回** `sort_config`（为 `null`），也未见别的排序类型 —— 站点侧不可配。
 * ⚠️ 到底时 `next_cursor` 返回 `-1`（不是缺省）；`has_more=false` 已足以判定到底。
 * ------------------------------------------------------------------------- */
export const AISPACE_NODE_CREATE_TIME_KEY = 'create_time';
export const AISPACE_NODE_UPDATE_TIME_KEY = 'update_time';
export const AISPACE_NODE_CONVERSATION_KEY = 'conversation_id';
export const AISPACE_NODE_TYPE_KEY = 'node_type';
/**
 * 创作树节点的**文件体积**（字节）。
 *
 * [实测 2026-09-28] 与用户实际下载到的原片**字节数完全一致**（样例：节点 `size = 8698069`
 * ↔ 落盘的 `doubao-*.mp4` 恰好 8 698 069 字节）。⚠️ 与 §12 的结论不冲突：
 * 报文里 **creation 的 video 对象**没有 size 字段、`download_infos` 实测也基本不给 ——
 * 所以视频的体积过去一直显示不出来，**这个节点字段是目前唯一可用的来源**。
 * 只在 vid 能解析（树里还有该作品）时才有；「原片已超期」的条目取不到（也不影响：它本来下不了）。
 */
export const AISPACE_NODE_SIZE_KEY = 'size';
/**
 * 创作树节点的**封面图路径**（卡片缩略图的兜底来源）。
 *
 * [实测 2026-09-28] `node_cover.list_view.cover_url`（带签名，`~tplv-noop.image`）。
 * 视频节点上它是**整帧封面**（720×1280 与真实原片一致），正好当卡片缩略图。
 * ⚠️ 带时效签名：链式报文的 `video_thumb` 若缺/过期，用它能兜住；
 * 签名过期就只能回退占位（F5 重解析会换一份新的）。
 */
export const AISPACE_NODE_COVER_PATH = ['node_cover', 'list_view', 'cover_url'] as const;
/**
 * 创作树视频节点的**原片真实帧宽高**（`node_cover.list_view.image_width / image_height`）。
 *
 * [实测 2026-09-28 第十二轮探针，`docs/probe-video-dims.js`] 全树 37 条视频样本：
 * 34 条落在 720P 横版（1280×720）/ 竖版（720×1280）且与视频方向一一对应；
 * 3 条 1470×630（≈21:9）**经用户核对确为真实帧尺寸** —— 字段是视频整帧尺寸，异形也如实。
 * 用途：vid 解析成功时给卡片补真实宽高 + 派生清晰度标签（取代报文里 384×216 的预览规格）。
 * ⚠️ **图片节点上是缩略图尺寸**（28×28 / 116×116）—— 本字段只随 vid 解析路径使用
 * （该路径只有视频），不会碰到图片节点；不要把它扩展到图片链路。
 * 非已知档位（如 630 短边）`qualityFromDims` 派生不出标签，界面只显示真实宽高（宁缺勿假）。
 */
export const AISPACE_NODE_WIDTH_PATH = ['node_cover', 'list_view', 'image_width'] as const;
export const AISPACE_NODE_HEIGHT_PATH = ['node_cover', 'list_view', 'image_height'] as const;
/** 实测 node_type：4 = 图片、6 = 视频 */
export const AISPACE_NODE_TYPE_IMAGE = 4;
export const AISPACE_NODE_TYPE_VIDEO = 6;

/**
 * **图片体积的取数口径**（2026-09-28 实机结论，`docs/03` §18）—— 这里只留痕，没有对应常量。
 *
 * 图片的「文件大小」**只由 background 实测** `primary` 的真实字节数得到
 * （`Range: bytes=0-0` → `Content-Range`；见 `core/download.ts::parseTotalBytes`、
 * `bg/service-worker.ts::backfillSizes`）。两条**被否决**的来源记在这里，避免日后走回头路：
 *
 * ① ⛔ **报文里 image 子对象的 `size`**：宽高取自 `image_ori_raw`，而 `size` 可能来自
 *    **另一个子对象**（如 `image_preview`）——两者不是同一个文件。实机反例：卡片显示 378 KB，
 *    而 `image_ori_raw.url` 下回来的是 **3.81 MB 的 PNG**（3 996 293 字节）。
 * ② ⛔ **创作树图片节点的 `size`**：节点 key 形如 `tos-cn-i-a9rns2rl98/rc_gen_image/<32位hash>.jpeg`
 *    （2026-09-28 探针实测，原片 URL 的 hash 能命中），但**没有任何实测证据**表明
 *    它与「`…<hash>.jpeg~tplv-…-image_raw.png` 那个可下载文件」是同一个字节数
 *    （视频节点验证过、图片没有）；而且为图片触发一次整树翻页比实测 1 字节更重。
 *
 * 📌 与之相对：**视频**的节点 `size` 是**已验证**的（实测与落盘原片字节数完全一致，§17.9），
 * 所以视频仍用「创作树 `size` 优先」。
 *
 * 📌 **调度口径 2026-10-02 改版（§37）**：实测「只测已定局条目 + 一个条目只测一次（失败也算测过）」
 * 会让卡片体积**时有时无**。现行 = **入库即测**（`state=pending` 也测，界面先用「预览体积」如实标注）
 * + **按「条目 + 归一化地址」记账**（换文件即可重测）+ **失败只重试 1 次**
 * （`core/size-probe.ts`、`docs/03` §37）。
 */

/**
 * 「按需实测文件字节数」的 Range 取值（2026-09-28 探针实测）。
 *
 * 用途：创作树里没有的条目（候选流 / 超期视频 / 超过约三个月的旧图片）拿不到节点 `size`，
 * 由 **background** 对该条目 `primary` 发一次 `Range: bytes=0-0` 的 GET，
 * 从响应头读总字节数 —— 量到的就是「点下载真正会拿到的那个文件」的体积。
 * 实测：服务器**支持** Range（回 206，`content-length: 1`，只下 1 字节）。
 * ⚠️ 只允许在**扩展上下文**（bg）里发：页面里发会被 CORS 挡住响应头
 * （`Content-Range` 不在安全列表里，实测 `content-range=null`）。
 */
export const SIZE_PROBE_RANGE = 'bytes=0-0';

/**
 * **聊天报文里的消息生成时间**（2026-09-28 只读探针实测，v2 覆盖 XHR 通道）。
 *
 * 实测路径：
 *   `data.downlink_body.pull_singe_chain_downlink_body.messages[i].create_time`
 *   （注意站点字段名拼写就是 `pull_singe_chain`，不是 `single`；**秒级** Unix）
 *
 * 时间点与网页上每条生成结果下面显示的时间**完全一致**（实例：`1779538923` = 2026-05-23 20:22:03
 * ↔ 页面显示「5月23日 20:22」）。
 *
 * 为什么**优先用它**而不是创作树节点的 `create_time`：
 *   · 创作树只保留约三个月的作品（`AISPACE_WALK_MAX_PAGES` 注释），5 月的旧作品早已不在树里；
 *   · 图片**从不查询创作树**（图片走 `image_ori_raw` 那条链路），树里有没有都取不到；
 *   · 消息自带的这个时间随聊天历史长期存在，**图片、视频、已过期的旧视频通吃**。
 * 因此：消息时间优先，创作树时间退为兜底（`page/hook.ts::enrichWithResolvedVid`）。
 */
export const MESSAGE_CREATE_TIME_KEY = 'create_time';

/** 三步接口的固定请求体形状 [上游 / 实测修正 2026-09-27]
 *
 * ⚠️ 两个实测事实：
 *   1. `node_id` 等节点 id 在 JSON 里是**字符串**（数值超过 JS 安全整数），一律按字符串透传；
 *   2. 节点 id 是**会话级的**（实测同一节点隔约 45 分钟后 `node not exist`，code=-672020004），
 *      因此不能跨会话/长时间缓存 id —— 本项目的 resolver 每轮现取 homepage，天然满足。
 */
export const AISPACE_NODE_INFO_BODY = (cid: string, cursor?: string) => ({
  node_id: cid,
  need_full_path: true,
  size: AISPACE_NODE_PAGE_SIZE,
  sort_param: { need_sort_config: true, sort_order: 1, sort_type: 0 },
  ...(cursor ? { [AISPACE_CURSOR_PARAM]: cursor } : {}),
});
export const AISPACE_DOWNLOAD_INFO_BODY = (nid: string) => ({ requests: [{ node_id: nid }] });

/* ============================================================================
 * §2 响应字段路径
 *
 * ⚠️ 全部是**以 `creation` 对象为根**的完整路径（不是以 `video` / `image` 为根），
 *    求值时统一传 `creation`，例如 `getPath(creation, VID_RAW_PATH)`。
 * ========================================================================== */

/** SSE：data.patch_op[].patch_value.content_block[].content.creation_block.creations[] [上游] */
export const SSE_CREATION_BLOCK = 'creation_block';

export const PATH_PATCH_OP = ['patch_op'] as const;
export const PATH_PATCH_VALUE = ['patch_value'] as const;
export const PATH_CONTENT_BLOCK = ['content_block'] as const;
export const PATH_CONTENT = ['content'] as const;
export const PATH_CREATIONS = ['creations'] as const;

/** 图片：thumb → ori_raw [上游] */
export const IMG_THUMB_PATH = ['image', 'image_thumb', 'url'] as const;
/**
 * 图片**预览图**的字段路径（候选；2026-09-28 临时探针实测）。
 * 实测 image 对象的字段：`image_ori / image_thumb / key / request_id / preview_img / private_img`
 * —— 预览在 **`preview_img`**，旧版读的 `image_preview` 不存在。
 */
export const IMG_PREVIEW_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ['image', 'preview_img', 'url'],
  ['image', 'image_preview', 'url'],
];
export const IMG_RAW_PATH = ['image', 'image_ori_raw', 'url'] as const;

/**
 * 图片宽高所在的**子对象**回退链（2026-09-27 实测探针，`docs/03` §12）。
 *
 * 实测成品 image 的结构：`image` 顶层**没有** width / height，
 * 宽高在 `image_ori_raw / image_ori / image_preview / image_thumb` 各子对象里
 * （`{url, width, height, url_formats}`，全部一致，如 2720×1520），按「质量最高优先」排列。
 *
 * ⚠️ 这些子对象里**可能出现 `size`**（2026-09-28 实机遇到），但它**不可信** ——
 * 它与 `image_ori_raw.url` 那个可下载文件不是同一个字节数（实机反例：字段 378 KB ↔
 * 实际下载 3.81 MB 的 PNG）。因此本项目**只从这里取 width / height，绝不取 size**：
 * 图片体积一律由 background 实测 `primary`（见上方「图片体积的取数口径」）。
 */
export const IMG_DIMS_SUBOBJECTS = ['image_ori_raw', 'image_ori', 'image_preview', 'image_thumb'] as const;

/** 视频：thumb → ori_raw、vid、download_url、video_model [上游] */
/**
 * 视频**封面图**的字段路径（候选，按可信度排序；2026-09-28 临时探针实测）。
 *
 * 实测报文里 video 对象的字段：`vid / cover / status / width / height / duration /
 * video_type / download_url / video_model / download_filehash` —— **封面在 `cover` 里**：
 *   `video.cover.{image_thumb | image_preview}.url`
 * ⚠️ 上游与本项目旧版读的 `video.video_thumb.url` **在当前站点不存在**（实测 `cover=0/5`，
 * 封面长期为空的根因之一）；`video_thumb` 已从候选里移除，不要凭印象加回来。
 * 顺序：`image_thumb`（小图，卡片够用、加载快）→ `image_preview`（更大，兜底）。
 */
export const VID_COVER_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ['video', 'cover', 'image_thumb', 'url'],
  ['video', 'cover', 'image_preview', 'url'],
];
export const VID_RAW_PATH = ['video', 'video_ori_raw', 'url'] as const;
export const VID_ID_PATH = ['video', 'vid'] as const;
export const VID_DOWNLOAD_PATH = ['video', 'download_url'] as const;
export const VID_MODEL_PATH = ['video', 'video_model'] as const;

/**
 * 视频 id 的**两种字段名** [实测 2026-09-26]：
 *   - SSE / thread 用 `video.vid`；
 *   - `chain/single` 用 `video.video_id`（实测值形如 `v0d69cg10004daqj77i7dld84jf8qsjg`，就是 vid）。
 * 两者取到的是同一个东西，只是字段名不同，因此统一按候选顺序取第一个非空值。
 */
export const VIDEO_ID_KEYS = ['vid', 'video_id'] as const;

/** chain/single 专有字段 [实测 2026-09-26] */
export const CHAIN_VID_DURATION_KEY = 'video_duration';
/** 备选播放源，实测带 `logo_type=video_gen_watermark_dyn`，**不是**原片 */
export const CHAIN_FALLBACK_API_KEY = 'fallback_api';

/* ============================================================================
 * §2.5 「本次生成用的模型」字段（2026-09-29 第十四轮 §34，**纯诊断用途**）
 *
 * 为什么记它：用户要研究「不同模型 → 创作树登记延迟不同」这个假设（§33 的误判就是被延迟坑的）。
 * 只有把模型名记进诊断，这类样本才能事后对齐比较。**不参与任何业务判定、不进资源库。**
 *
 * 实测（`uwd-diag-1790690882278.json`，真实报文样本）：
 *   ① 消息对象上的 `chat_ability` 是**被转义的 JSON 字符串**，里层 `ability_param` **又是一层**转义：
 *      `"chat_ability":"{\"ability_type\":17,\"ability_param\":\"{\\\"ratio\\\":\\\"16:9\\\",\\\"model\\\":\\\"seedance_v2.0\\\",\\\"duration\\\":10,...}\"}"`
 *      → `...ability_param.model = "seedance_v2.0"`（用户在输入框里选的那个模型）
 *      它出现在**用户输入消息**那一批报文里（`message_from: "InputBox"`）。
 *   ② 消息 `ext.ai_creation_tool_list` 是转义 JSON 数组，元素形如
 *      `{"task_id":57049578737520386,"tool_name":"text_to_video","req_key":"seedance_v20_fast_flow","status":5,...}`
 *      → 取 `tool_name === "text_to_video"` 那条的 `req_key`（实际跑的那个「流程」）
 *      它出现在**生成任务 ack** 那一批报文里（文案：「本次使用 Seedance 2.0 Fast 生成」）。
 *   ⚠️ **视频成片那一批报文里这两处都没有** —— 模型信息在更早的消息里，所以页面侧必须
 *      「记住最近一次读到的值」并按批次时刻标注来源（见 `page/hook.ts::noteModelHints`）。
 * ========================================================================== */

/** 消息自带：模型选择（转义 JSON 字符串） */
export const MSG_CHAT_ABILITY_KEY = 'chat_ability';
/** 上者内层：生成参数（**又是一层**转义 JSON 字符串） */
export const ABILITY_PARAM_KEY = 'ability_param';
/** 上者内层：模型名，实测 `seedance_v2.0` */
export const ABILITY_MODEL_KEY = 'model';
/** 消息 `ext` 内：生成任务列表（转义 JSON 数组） */
export const AI_CREATION_TOOL_LIST_KEY = 'ai_creation_tool_list';
/** 任务元素里的工具名，实测 `text_to_video` */
export const TOOL_NAME_KEY = 'tool_name';
/** 任务元素里的流程名，实测 `seedance_v20_fast_flow` */
export const TOOL_REQ_KEY = 'req_key';
/** 视频生成任务的 `tool_name` 取值（同批可能有别的任务，用它挑出视频那条） */
export const TOOL_NAME_TEXT_TO_VIDEO = 'text_to_video';

/* ============================================================================
 * §2.6 模型标识（2026-09-30 第十五轮；**§35.11 起以「站点文案」为主来源**）
 *
 * 用途：把「这条视频是哪个模型生成的」直接标在卡片上（用户要求）。
 * 站点当前提供四个模型（用户截图）：**Seedance 2.5 / Seedance 2.0 / Seedance 2.0 Fast /
 * Seedance 2.0 Mini**；卡片上显示简称 **SD-2.5 / SD-2.0 / 2.0-Fast / 2.0-Mini**。
 *
 * ── 三个来源的**可信度排序**（都是实测结论，别按直觉排）────────────────────────
 *   ① **站点文案**（最可信）：任务 ack 消息里的
 *      「本次使用 **Seedance 2.0 Mini** 生成，大约需要 1-3 分钟。」—— 站点自己报的档位名，
 *      一次给出「版本 + 变体」，四种档位实测都能这样读到。
 *   ② `model` = `chat_ability.ability_param.model`（**用户输入框里选的**）：
 *      `seedance_v2.5` / `seedance_v2.0_std`（标准版）/ `seedance_v2.0_mini`（Mini）可用；
 *      ⚠️ **裸 `seedance_v2.0`（无后缀）不可用** —— 实测它既出现在标准版会话
 *      （`0929#动作戏练手`）也出现在 Fast / Mini 会话里，是**有歧义**的值。
 *   ③ `tool` = `ext.ai_creation_tool_list[].req_key`（**只信版本号，不信变体**）：
 *      实测 `seedance_v20_fast_flow` **同时**出现在 Fast 与 **Mini** 档位的会话里
 *      （`uwd-diag-1790734985577.json`：`0704#mini实验` 12 条全是 Mini，tool 却是 `fast_flow`）
 *      ⇒ 它是「视频生成**流程**」不是「档位」，**变体一律丢弃**，只从中取版本（`v25` → `2.5`）。
 *
 * ⚠️ 成片那一批报文里三处都没有 —— 模型信息在更早的消息里，所以页面侧按
 *    「每条提示所在消息的 `create_time`」排成时间线，再按资源自己的 `createdAt` 就近取用
 *    （`readModelTimeline` + `pickModelHintAt`，见 `docs/03` §35.10）。
 * ⚠️ 变体词走白名单 `MODEL_VARIANT_LABELS`；白名单外（站点将来加档位）**不给药丸**，不猜。
 * ⚠️ `readModelHints` 里**不得**用 `entries[0]` 兜底挑任务（§35.8：图片流程 `seedream_v50s_flow`
 *    曾把 `tool` 污染成非 seedance 形态，导致图文混合会话药丸整片消失）。
 * ========================================================================== */

/** 「本次使用 **Seedance 2.0 Mini** 生成」—— 抓站点文案里的档位名 [实测 4 种档位] */
export const MODEL_LABEL_TEXT_RE = /本次使用\s*\*{0,2}\s*([^*\n]{1,24}?)\s*\*{0,2}\s*生成/;
/** 文案里的档位名形态：`Seedance <版本>` + 可选 ` <变体>`（大小写不敏感） */
export const MODEL_LABEL_RE = /seedance\s*v?(\d+(?:\.\d+)?)(?:\s+([a-z]{2,8}))?/i;
/** `model` 字段形态：`seedance_v<版本>` + 可选 `_<后缀>`（`std` = 标准版） */
export const MODEL_NAME_RE = /^seedance_v(\d+(?:\.\d+)?)(?:_([a-z]+))?$/;
/** `model` 后缀里表示「标准版」的字面（其余后缀走 `MODEL_VARIANT_LABELS` 白名单） */
export const MODEL_STD_SUFFIX = 'std';
/** 流程名形态：`seedance_v<两位版本>` + 可选 `_<变体>` + `_flow` [实测 2 例]；**变体不采用** */
export const MODEL_TOOL_RE = /^seedance_v(\d{2})(?:_([a-z0-9]+))?_flow$/;
/**
 * 变体字面 → 显示后缀（**白名单**：不在此表内的变体一律不给药丸）。
 * ⚠️ 用数组而不是 `Record` —— 变体词取自报文，`Record` 下标会命中
 * `constructor` / `toString` 这类原型成员（把函数当后缀拼进文案）。
 */
export const MODEL_VARIANT_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['fast', 'Fast'],
  ['mini', 'Mini'],
];
/**
 * 站点文案里的**档位别名**（老版写法）—— 字面 → 变体词。
 *
 * 实测（2026-09-30 §35.13，用户确认）：**老版把 2.0 Fast 档位写成**
 * 「本次使用 **Seedance 2.0 全能视频模型** 生成，将消耗 2 个视频生成额度，预计等待 5 分钟。」
 * —— 「全能视频模型」**不是**标准版，它就是 **2.0 Fast**（豆包老版的语义双标）。
 * 不认这条会把 Fast 标成 `SD-2.0`（用户实机报错）。
 * ⚠️ 别名匹配用前两字「全能」以覆盖简写；将来若出现新别名，一律**按实测**追加，不推测。
 */
export const MODEL_LABEL_ALIASES: ReadonlyArray<readonly [string, string]> = [['全能', 'fast']];
/**
 * 「站点**未提供变体**」的版本 —— 只有这些版本的 `model` 值即使**没有后缀**也可安全使用。
 * 实测：`seedance_v2.5` 只有 Seedance 2.5 一个档位（没有 2.5 Fast / Mini）；
 * 而 `seedance_v2.0`（无后缀）同时对应标准版 / Fast / Mini → 有歧义，不采用。
 */
export const MODEL_SINGLE_VARIANT_VERSIONS: readonly string[] = ['2.5'];

/* ============================================================================
 * §2.7 视频分享页（`/video-sharing`）—— 2026-10-02 第十六轮 [实测]
 *
 * 场景：用户在手机上把**单条视频**分享出来，链接形如
 *   https://www.doubao.com/video-sharing?source_type=mobile
 *     &share_id=57139820578269954&video_id=v0269cg10004daamhk27dld2vpu8bbgg
 * 站点给这个路由起了一个**固定**的页面标题「豆包 AI 视频」
 * （页面 chunk 里就是 `` `${DEFAULT_NAME} AI 视频` ``，与具体视频无关）。
 *
 * ── 为什么必须单独适配：数据来源与 `/thread/` 完全不同 ────────────────────────
 *   · `/thread/`（整段对话分享）—— 数据在**页面自身的 chain / SSE 报文**里，hook 照常解析；
 *   · `/video-sharing` —— 页面渲染前由**路由 loader** 发一次
 *     `POST /creativity/share/get_video_share_info`（body `{share_id, vid, creation_id}`），
 *     响应直接给出播放地址。这个接口**不在** chain / SSE 上，所以必须单独 hook
 *     （`page/hook.ts::handleShareInfo`）。
 *
 * ── 实测响应形状（2026-10-02，curl 直调该接口）────────────────────────────────
 *   { code: 0, msg: "",
 *     data: {
 *       play_info: { main, backup, height, width, definition, poster_url },
 *       user_info: { user_id, user_name, nickname },
 *       prompt: "8K 3D CG写实，……",
 *       source_info: { author_uid, message_id, creation_task_id } } }
 *
 * 关键结论（都影响实现，别按直觉改）：
 *   ① `main` / `backup` 都是**带水印**转码流（`lr=video_gen_watermark_dyn&download=true`），
 *      就是网页播放的那个文件 —— 即「分享页只能拿到带水印版」，与既有口径一致；
 *   ② 响应里**没有 vid**（只能从 URL 的 `video_id` 取）、**没有生成时间**、**没有文件体积** ——
 *      所以这条素材的时间药丸排末尾、体积由 background 实测（`bg.size`，§37 起**入库即测**）兜底；
 *   ③ `play_info.width/height`（实测 720×1280，`definition: "720p"`）描述的是**上面那个带水印
 *      文件自己**的规格 —— 2026-10-02 用户拍板：**取它**，界面上显示成「预览 720×1280」没关系
 *      （`toDraft` 对所有视频宽高一律打 `dimsPreview` 标记，措辞就是「预览」；
 *      这比「什么都不显示」对用户更有信息量）。`definition` 字段**仍然不取** ——
 *      清晰度标签（`meta.label`）只允许描述「最终下载的那个文件」，而该字段会在 vid 解析成功后
 *      可能换成另一个文件（见 `docs/03` §12.7 的历史教训），宁缺勿假。
 *
 * ⚠️ **绝对不要把这个 CDN 加进 `CORS_INJECT_HOST_FILTERS`**（实测血泪，2026-10-02）：
 *   播放地址的域名是 `*.365yg.com`（实测见过 `v5-se-gddgtc-default.365yg.com` /
 *   `v9-default.365yg.com`，按 CDN 调度变）。该 CDN 的行为是：
 *     · **不带 Referer** → `206 Partial Content`（正常，能下）；
 *     · `Referer: https://www.doubao.com/…`（任何形态）→ **403 Forbidden**；
 *     · 带 `Origin: chrome-extension://…`（background 实测体积时就是这样）→ 206 + `ACAO: *`。
 *   而 `CORS_INJECT_HOST_FILTERS` 那两条规则**除了 CORS 响应头还会注入 Referer** ——
 *   把 `365yg.com` 加进去，等于亲手把「本来能下的文件」打成 403。
 *   弹窗里的封面在 `p26-sign.douyinpic.com`，那个域本来就在封面注入名单里，不受影响。
 * ========================================================================== */

/** `/video-sharing` 的数据接口（POST JSON，站点路由 loader 调用）[实测 2026-10-02] */
export const VIDEO_SHARE_INFO_ENDPOINT = '/creativity/share/get_video_share_info';

/** 分享页 URL 里三个查询参数（站点 loader 读的就是它们）[实测 2026-10-02] */
export const VIDEO_SHARE_QUERY = {
  shareId: 'share_id',
  creationId: 'creation_id',
  videoId: 'video_id',
} as const;

/**
 * `/video-sharing` 页面的**会话 ID 前缀**（插件侧自己造的）。
 *
 * 该页 URL 的**路径里没有 ID**（id 全在查询参数里），而资源库是「会话作用域」的
 * （`retainConv` 按 convId 裁剪），所以必须有一个人造的稳定键：
 * `share_<share_id | creation_id | video_id>`。
 * 加前缀有两个用处：诊断里一眼看出它来自分享页；且**不会与对话页 / `/thread/` 的
 * 纯数字 convId 撞车**。
 */
export const SHARE_CONV_ID_PREFIX = 'share_';

/** 「正在看的这条分享视频」的上下文（三个参数都取不到时全是空串） */
export interface VideoShareQuery {
  shareId: string;
  creationId: string;
  videoId: string;
}

/** 从 URL 里取分享页的三个参数（URL 非法 → 全空；**不编造**） */
export function parseVideoShareQuery(href: string): VideoShareQuery {
  const out: VideoShareQuery = { shareId: '', creationId: '', videoId: '' };
  try {
    const params = new URL(href).searchParams;
    out.shareId = params.get(VIDEO_SHARE_QUERY.shareId) ?? '';
    out.creationId = params.get(VIDEO_SHARE_QUERY.creationId) ?? '';
    out.videoId = params.get(VIDEO_SHARE_QUERY.videoId) ?? '';
  } catch {
    /* 非法 URL → 全空 */
  }
  return out;
}

/**
 * 分享页的**会话作用域键**：三个参数都取不到时返回空串（= 不算会话，
 * 界面照旧提示「未检测到豆包对话或分享页面」，不会拿一个空作用域去清库）。
 */
export function videoShareConvId(href: string): string {
  const { shareId, creationId, videoId } = parseVideoShareQuery(href);
  const id = shareId || creationId || videoId;
  return id ? SHARE_CONV_ID_PREFIX + id : '';
}

/**
 * 从**任意 URL** 反推它属于哪个会话作用域（2026-10-02 §38 多标签页修复新增）。
 *
 * 用途：资源库按标签页分槽后，两处必须知道「这个标签页此刻在哪个会话」——
 *   ① 存储迁移（v2 单库 → v3 分槽）时把旧条目归位到仍开着的那个标签页；
 *   ② `tabs.onUpdated`：标签页导航到**非会话页**（豆包首页 / 别的站点）时
 *      「离开会话」→ 清掉它的槽。
 *
 * ⚠️ 与页面侧 `detectConvId()` 必须同源（都走这里/`videoShareConvId`），
 * 否则会出现「bg 认为这是会话页、页面认为不是」的静默分叉。
 * 拿不到会话返回空串（**不编造**，绝不用空串去清库）。
 */
export function convIdFromUrl(url: string | undefined | null): string {
  if (!url || !isDoubaoHostUrl(url)) return '';
  const share = videoShareConvId(url);
  if (share) return share;
  const match = url.match(/\/(?:chat|thread)\/([A-Za-z0-9_-]+)/);
  return match?.[1] ?? '';
}

/* ============================================================================
 * §2.8 老链路「修改生成」的图片容器 `image_list`（2026-10-03 第二十三轮 [实测]）
 *
 * 场景：**几个月前的老会话**里，「修改生成 / 二次编辑」产出的图**不进** `creation_block.creations`，
 * 而是挂在 `msg.content.image_list[*]` 下（探测实录 `docs/03` §43.1）。字段形如：
 *
 *   { key, image_thumb, image_ori, preview_img, image_raw, image_thumb_ori }
 *     宽高/URL 都在各自子对象里：{ url, width, height, format }
 *
 * ⚠️ 三个必须记住的实测事实（`docs/03` §43，10 次观测 / 8 张独立底图）：
 *   ① **没有 `image_ori_raw`** —— 也就是站点**没给现成的无水印档**（这正是「嗅探不到」的根因：
 *      老实现只认 `image.image_ori_raw.url`，于是这一族整条被当成 thumb 丢掉）。
 *   ② `image_raw`（≡ `preview_img`）与 `image_ori` 是**同一张底图的两种带水印档**：
 *      `image_raw` = `…_pre_watermark_1_5b.png`（**水印在左上**）、
 *      `image_ori` = `…_image_dld_watermark_1_5b.png`（**水印在右下**）；
 *      **底图逐像素完全相同**（排除两块水印矩形后全域差 = 0）。
 *   ③ 两处水印**互不相邻**（左上 / 右下，相距 >1000px）⇒ **互换同位置像素即可无损还原**。
 *
 * ⚠️ **字段名有误导性**：这里 `image_raw` 指向的是**带水印的预览档**，
 *    与新版布局里「`image_ori_raw` → `…_image_raw.png`（真干净）」**同名不同物**。
 *    按字段名推断一律不算数 —— 必须看像素（这条踩过坑，见 `docs/03` §43.7）。
 *
 * ⚠️ **不许改写后缀去水印**：该 CDN 的 `x-signature` **覆盖整个路径（含 `~tplv-` 后缀）**，
 *    后缀一改即 **403**（6 组对照实测，`docs/03` §43.6）。唯一可行的是**两档互补补角**。
 *
 * 📌 本容器**只出现在老链路**：新版会话的结果回到 `creation_block.creations[].image` 且带
 *    `image_ori_raw`（实测 `image_list 命中 = 0`）—— 这就是「老对话多、新对话少」的原因。
 * ========================================================================== */

/** 「修改生成」结果的容器键（实测路径 `msg.content.image_list`，`content` 可能是转义 JSON 字符串） */
export const IMG_LIST_KEY = 'image_list';
/** 预览档（**全尺寸、水印在左上**）—— 补角的**底板** */
export const IMG_LIST_PRE_KEY = 'image_raw';
/** 下载档（**全尺寸、水印在右下**）—— 补角的**像素来源** */
export const IMG_LIST_PATCH_KEY = 'image_ori';
/** 缩略档（326×580，带水印）—— 只当卡片封面 */
export const IMG_LIST_THUMB_KEY = 'image_thumb';

/**
 * **补角矩形**：把「下载档」这块矩形里的像素，原样覆盖到「预览档」的同一位置。
 *
 * 取法（实测并集，10 次观测）：水印在预览档上的矩形是 `x25~227 y25~116`（203×92），
 * 但**会随背景对比度抖动 ±5px**（亮背景 203×92 / 暗背景 195~197×85）。
 * 所以这里取**宽松框** `0,0 260×150`（留 ~30px 余量）。
 *
 * ⚠️ **放大无害**：两档底图逐像素相同 ⇒ 多补进来的区域两档本就一致，**覆盖等于没覆盖**
 *    （这是「同源底图」这条性质的直接红利，见 `docs/03` §43.11）。
 */
export const IMG_PATCH_RECT = { x: 0, y: 0, w: 260, h: 150 } as const;

/**
 * **来源档（下载档 `image_ori`）自己的水印矩形** —— 距**右下角**的宽松框尺寸。
 *
 * ⚠️ **2026-10-03 第二十六轮实机修复（务必先读）**：同源校验**必须把两块水印都排除**。
 *   原先只排除了补角矩形（底板**左上**那处），于是「稀疏全图采样」（step=37）必然扫到
 *   **来源档右下角的水印** ⇒ 两档在那里本来就不同 ⇒ 校验**恒定失败**、补角**一次都没成功过**。
 *   实机症状（`docs/03` §46）：全部条目显示「仅带水印档」，诊断 `content.patch` 恒为
 *   「同源校验未通过」；像素复核证明两档底图逐像素相同、差异只在左上 + 右下两个水印角。
 *
 * 实测来源档水印矩形 = `x1267~1513 y2644~2703`（原图 1536×2730），与左上那处一样
 * **随背景对比度抖动 ±5px** ⇒ 同取宽松框 `296×110`（距右下角；并集与余量见 `docs/03` §43.11）。
 *
 * 📌 只用于**校验时排除**，不参与覆盖 —— 覆盖只动底板左上的补角矩形（那里已是干净像素）。
 */
export const IMG_PATCH_SRC_MARK = { w: 296, h: 110 } as const;

/**
 * 补角前的**同源校验**步长（像素）。
 *
 * 补角的正确性建立在「两档底图逐像素相同」之上 —— 万一站点将来改成两档不同源，
 * 覆盖就会把**别处的画面**糊到这块矩形里（比带水印更糟）。
 * 所以下载前先做一次**稀疏全图采样**（步长 37px ≈ 3000 个采样点）逐像素比对：
 * 一致才补角，不一致**退回下载带水印的预览档**并把它标成「补角失败」。
 */
export const IMG_PATCH_VERIFY_STEP = 37;

/** 补角校验时矩形外扩的环带宽度（像素）—— 紧邻水印的一圈必须逐像素一致 */
export const IMG_PATCH_VERIFY_RING = 16;

/* ============================================================================
 * §2.9 分享页「无水印视频」—— 档位开关与 fplay / qAAB 契约（2026-10-03 第二十七轮 [实测]）
 *
 * 场景：**别人分享出来的**视频（`/thread/` 整段对话分享、`/video-sharing` 单条分享）。
 * 站点在页面上只给**带水印**的播放档；无水印档要用下面这条链路换：
 *
 *   ① 拿 `fallback_api`（形如 `https://vas-lf-x.snssdk.com/video/fplay/1/<hash>/<vid>?…&key_seed=…`）
 *      · `/thread/`：**页面 SSR / chain 报文里就有**（本项目早已抽取 `RawMedia.fallbackApi`），**免登录**；
 *      · `/video-sharing`：页面里没有 ⇒ 必须调 `VIDEO_MODEL_ENDPOINT`（**需登录态**）。
 *   ② 改 fplay 请求：**先删 `logo_type` / `force_fids`**，再按档位设 `codec_type`
 *      （见 `FPLAY_CODEC_LIGHT` / `FPLAY_CODEC_HEAVY`）；
 *   ③ GET → 响应 `video_info.data.{key_seed, video_list[*].main_url | backup_url_1}`
 *      —— 值是 **qAAB 加密 token**，要用 `core/fplay.ts::decodeQaabToken` 解成明文直链；
 *   ④ 明文直链**带时效签名** ⇒ 只能**下载那一刻现解现用**，**绝不入库**。
 *
 * ⚠️ 三条实测事实（`docs/03` §47.9 / §47.10 / §47.11）：
 *   ① **`codec_type` 才是档位开关**：`1` = 轻量无水印、`5`/`8` = 原画质无水印、
 *      **`3` = 带水印**（`/video-sharing` 页面给的原始值）；
 *   ② **URL 里的 `lr` 只是装饰**：同一次请求里 `lr=unwatermarked` 与「无 lr」**解出同一个文件、同 MD5**；
 *   ③ **作者身份不参与**：`fallback_api` 里的 `user_id` 是**请求者**（实测 ≠ 分享接口给的 `author_uid`）
 *      ⇒ 非原作者一样能拿到无水印档；只有 `/video-sharing` 那条路要求「**任意账号已登录**」。
 *
 * ⚠️ 高画质档的**绝对码率随片源走**（实测竖版 15.36 Mbps / 横版 4.6 Mbps）⇒ **UI 不得承诺具体体积**。
 * ========================================================================== */

/** fplay 的路径前缀（用来校验「这个 fallback_api 长得对不对」） */
export const FPLAY_PATH_PREFIX = '/video/fplay/';
/** fplay 的受信域名后缀（只认它，避免把别处 URL 当接口去请求） */
export const FPLAY_HOST_SUFFIX = 'snssdk.com';

/** 改写 fplay 请求时**必须先删掉**的参数（实测：留着会把档位钉回带水印/默认档） */
export const FPLAY_DROP_PARAMS = ['logo_type', 'force_fids'] as const;

/** **轻量档**：`codec_type=1` —— hevc 720P 级，体积与站点带水印档几乎一样（实测 2.39 MB / 1.91 Mbps） */
export const FPLAY_CODEC_LIGHT = '1';
/** **高画质档**：`codec_type=5` + `force_fids=FPLAY_FORCE_FIDS_ORIGINAL` */
export const FPLAY_CODEC_HEAVY = '5';
/** `base64("original")` —— 高画质档的 `force_fids` 取值（照搬站点/同类实现的写法，不可推导） */
export const FPLAY_FORCE_FIDS_ORIGINAL = 'b3JpZ2luYWw=';

/** fplay 响应里「取哪几个字段当直链候选」（其它字段一律不取） */
export const FPLAY_VIDEO_URL_KEYS = ['main_url', 'backup_url_1'] as const;
/** fplay 响应里数据都在这个路径下（顶层是 `{video_info, message, code}`） */
export const FPLAY_RESPONSE_DATA_PATH = ['video_info', 'data'] as const;
/** `video_list` 可能是**对象**（键为序号）也可能是**数组**，两种都要吃 */
export const FPLAY_VIDEO_LIST_KEY = 'video_list';
/** 解密用的种子（base64）——响应里也有，比 URL query 里那份更权威 */
export const FPLAY_KEY_SEED_KEY = 'key_seed';

/** qAAB 解密的**固定盐**（64 字节 hex；与 `docs/probe-decode-qaab.mjs` / 开源实现同一份，照搬） */
export const FPLAY_KDF_SALT_HEX =
  '4dd4c2e6b83162090e52b3c7a6733ba4' +
  '1cb2462b829ab58a196b39db57177524' +
  'f49baf7f08e8d68d26a72e37c1a95a2f' +
  '1f05a51892aef2949732b62a38aadd58';

/** qAAB token 的被剥离前缀（前 4 字节）；不是这个值就走「不剥」的退化分支 */
export const FPLAY_TOKEN_PREFIX = [0xa8, 0x00, 0x01, 0x00] as const;

/**
 * `/video-sharing` 专用：**只吃 vid** 的接口，返回带 `fallback_api` 的视频模型。
 * ⚠️ **需要登录 cookie**（实测无 cookie 回 `code:710012001 登录已过期`），
 *    且**不要求你是作者**（见本节开头第 ③ 条）。
 */
export const VIDEO_MODEL_ENDPOINT = '/alice/resource/get_video_model';
/** 该接口的强制 query（照搬同类实现；缺 `aid` 会被服务端吞掉/拒绝） */
export const VIDEO_MODEL_QUERY: Readonly<Record<string, string>> = {
  version_code: '20800',
  language: 'zh-CN',
  device_platform: 'web',
  aid: '497858',
  real_aid: '497858',
  pkg_type: 'release_version',
  samantha_web: '1',
  'use-olympus-account': '1',
};
/** 请求体里 vid 的字段名（实测是 `uri`，**不是** `vid`/`key`） */
export const VIDEO_MODEL_URI_KEY = 'uri';
/** 响应里拿 `fallback_api` 的路径（`video_model` 是**一层转义 JSON 字符串**） */
export const VIDEO_MODEL_RESULT_PATH = ['data', 'results'] as const;
export const VIDEO_MODEL_MODEL_PATH = ['video_model_result', 'video_model'] as const;
export const VIDEO_MODEL_FALLBACK_KEY = 'fallback_api';

/**
 * 「原画质档」按钮的界面文案（2026-10-04 §52 由「高画质」收成两字）。
 *
 * ⚠️ **必须两字**：分享页卡片的动作行是「下载 / 原画 / 预览」三键等宽 46px，而 CJK 全角 = 1em，
 * 三字时内容要 10 + 3 + 3×10.5 = 45px，会把按钮的左右内边距吃光（§52 实测：内容 45 / 可用 40）。
 * 全称并没有丢 —— 悬停说明 `HQ_TITLE` 里写着「原画质档」。
 */
export const HQ_LABEL = '原画';
export const HQ_TITLE = '下载无水印原画质档（体积随片源，可能十几～几十 MB）';
/** 「轻量」不加按钮，只在「下载」的悬停说明里点明它是哪一档 */
export const LQ_TITLE = '下载无水印（轻量档，体积与站点带水印档相当）';

/* --- 响应字段路径（以**整个响应体**为根求值）--------------------------------- */


/** 播放信息子对象 */
export const SHARE_PLAY_INFO_PATH = ['data', 'play_info'] as const;
/** 播放地址（实测 `lr=video_gen_watermark_dyn&download=true`，**带水印**、网页播放的同一个文件） */
export const SHARE_PLAY_MAIN_KEY = 'main';
/** 备用播放地址（同为带水印转码流；因语义一致而复用 `RawMedia.fallbackApi`，只作末位候选） */
export const SHARE_PLAY_BACKUP_KEY = 'backup';
/**
 * 播放文件的宽 / 高（实测 720×1280；数字形态，与站点其它数字字段一样可能给字符串，
 * 故一律经 `asNumber()` 读取）。`toDraft` 会打上 `dimsPreview` 标记 → 界面显示「预览 720×1280」。
 */
export const SHARE_PLAY_WIDTH_KEY = 'width';
export const SHARE_PLAY_HEIGHT_KEY = 'height';
/** 封面图（实测在 `p26-sign.douyinpic.com`，走站点自己的带水印封面，不抓原片帧） */
export const SHARE_POSTER_KEY = 'poster_url';

/** 判定「一个对象是不是 creation」：含 `video` 或 `image` 子对象 [上游] */
export const CREATION_MEDIA_KEYS = ['video', 'image'] as const;

/**
 * chain/single 的响应体结构未被穷举，且历史上被包过不止一层，
 * 因此不用固定字段路径下钻，而是**在解析树上按 `CREATION_MEDIA_KEYS` 收集 creation**。
 * 这里限制递归深度，避免在异常深/自引用的响应上打转。
 */
export const CREATION_WALK_MAX_DEPTH = 14;

/** video_model 内嵌 JSON 的清晰度列表字段 [上游] */
export const VIDEO_MODEL_LIST_KEY = 'video_list';
export const VIDEO_MODEL_MAIN_URL_KEY = 'main_url';
export const VIDEO_MODEL_DEFINITION_KEY = 'definition';
export const VIDEO_MODEL_QUALITY_KEY = 'quality_type';

/**
 * chain/single：main_url 为 base64，且被 JSON 转义包裹 [上游 / 实测修正 2026-09-26]
 *
 * ⚠️ 上游写的是 `/\\"main_url\\"\s*:\s*\\"(...)\\"/` —— **只认「1 个反斜杠 + 引号」这一种转义深度**。
 * 实测 chain 报文里 `video_model` 是**多层转义**的（`docs/03` §2：`\\\"main_url\\\"`），
 * 那种形态下上游正则两侧都会匹配失败（引号前有多个反斜杠，而正则只允许一个）。
 * 这里把两侧的转义放宽为 `\\*`（0 ~ N 个反斜杠），一次性覆盖所有转义深度。
 */
export const CHAIN_MAIN_URL_RE = /\\*"main_url\\*"\s*:\s*\\*"([A-Za-z0-9+/=]{100,})\\*"/g;
/** base64 解码后含此标记即为无水印版 [上游] */
export const CHAIN_UNWATERMARK_TAG = 'unwatermarked';

/**
 * ⚠️ [实测 2026-09-26] **不能再拿 `CHAIN_UNWATERMARK_TAG` 当过滤器**。
 * 实测 `main_url` 解出来的是 `lr=video_gen_watermark_dyn`（带水印转码流），
 * 按关键字过滤会把整条响应全部丢掉（首轮联调 `raws=0` 的直接原因）。
 * 正确做法：解出来的地址一律走 `sanitizeMediaUrl()` 做**候选地址**，
 * 真原片由同响应里的 `video_id` 经三步 API 换取。
 */
export const CHAIN_REQUIRE_UNWATERMARK_TAG = false;

/**
 * thread 分享页：内联脚本选择器 [上游]。
 *
 * ⚠️ **[实测 2026-09-28 只读探针]** 当前站点的分享页（`/thread/xxx`）**页面上没有
 * `script[data-fn-args]`** —— 分享页的数据实际由页面自身的 chain / SSE 请求带回
 * （我们 hook 照常解析：非本人账号也能拿到带水印候选与 `vid`），分享标题退回 `document.title`。
 * 也就意味着：**分享页拿不拿得到原片，取决于 `vid` 在不在当前账号的「我的创作」树里**
 * （原片只对作品所属账号开放），与这个选择器无关。
 *
 * 这条选择器**保留**，作为旧版 / 服务端渲染分享页的兜底：命中就照旧解析
 * （诊断 `parse.thread` 的 `scripts=N raws=M` 能看出是否命中），未命中无副作用。
 * ⛔ 别因为「探针没看到」就删掉整条 thread 抽取链（`core/extract/thread.ts`）。
 */
export const FN_ARGS_SELECTOR = 'script[data-fn-args]';
export const SHARE_INFO_KEY = 'shareInfo';
/** 结构① ["thread_x/page","shareInfo",{...}] */
export const SHARE_INFO_INDEX = 1;
/** 结构② ["thread_x/page",[{key:"shareInfo",routerDataFnArgs:["<json>"]}]] */
export const ROUTER_DATA_FN_ARGS_KEY = 'routerDataFnArgs';
/** 数据路径 shareInfo.data.message_snapshot.message_list [上游] */
export const SHARE_DATA_PATH = ['data', 'message_snapshot', 'message_list'] as const;
/** 单条消息内的内容块字段 [上游] */
export const MESSAGE_CONTENT_BLOCK = 'content_block';

/**
 * 分享页标题可能出现的字段路径 [上游 + 第四轮实测回填]
 *
 * ⚠️ [实测 2026-09-26] 上游写的 `data.share_info.title` **不存在**；
 * 真正承载标题的是 **`data.share_info.share_name`**（探针 `describeTitleFields` 实测得到）：
 *
 * ```
 * data.share_info.share_name    = 超写实武侠CG打斗视频生成与呈现   ← 就是它
 * data.share_info.user.nick_name = 暮星河                        ← 用户昵称，不能用
 * data.share_info.bot.name       = 豆包                          ← 机器人名，不能用
 * ```
 *
 * 因此 `share_name` 排第一；其余候选保留（站点换结构时仍有机会命中），
 * 再由 `findTitleByKey()` 用 `SHARE_TITLE_KEYS` 兜底扫描。
 */
export const SHARE_TITLE_PATHS = [
  ['data', 'share_info', 'share_name'],
  ['data', 'share_info', 'share_title'],
  ['data', 'share_info', 'title'],
  ['data', 'share_info', 'name'],
  ['data', 'message_snapshot', 'title'],
  ['data', 'message_snapshot', 'share_info', 'title'],
  ['data', 'title'],
] as const;

/**
 * 兜底扫描时认得的「像标题」的 key 名 [第四轮新增/实测回填]。
 * ⚠️ **不能收 `name`**：实测 `share_info.bot.name` 是「豆包」、
 * `user.nick_name` 是用户名、`message_action_list[].name` 是「喜欢/不喜欢」——
 * 一旦收进来就会把「豆包」或「喜欢」当成分享标题。
 */
export const SHARE_TITLE_KEYS = ['share_name', 'share_title', 'title'] as const;
/** 兜底扫描的深度上限（避免在异常深的结构上打转） */
export const SHARE_TITLE_WALK_MAX_DEPTH = 4;
/** 结构摘要（校准用）的深度上限：要够到 `message_list[i].content_block[j]` 这一层 */
export const SHARE_DESCRIBE_MAX_DEPTH = 6;
/** 结构摘要最多列多少条字段 */
export const SHARE_DESCRIBE_MAX_FIELDS = 24;
/** 标题长度上限：超过这个长度的字符串不是标题（多半是正文或 JSON） */
export const SHARE_TITLE_MAX_LEN = 200;

/* ============================================================================
 * §3 水印参数
 *   只有两类：① 视频 `lr` 参数；② 动态水印 `logo_type` 参数。
 *
 * ⛔ **没有「图片后缀改写表」了**（2026-10-03 第三十一轮删除）：早年从上游照搬的
 *   `~tplv-…-downsize_watermark_1_6.png → …-image-qvalue.jpeg` 一族**从未命中过**真实地址
 *   （站点后缀已是 `1_5b` / `1_6_b`），而且签名覆盖整个路径、改后缀即 403，属**有害的死重**
 *   （`docs/03` §43.6 / §45.2）。图片地址一律原样进库。
 * ========================================================================== */

/** 视频 lr 参数：带水印 → 无水印 [上游 rules.json id 8] */
export const LR_WATERMARK_RE = /lr=video_gen_watermark(?:_dyn)?/g;
export const LR_WATERMARK_DYN_RE = /lr=video_gen_watermark_dyn/g;
export const LR_NO_WATERMARK = 'lr=video_gen_no_watermark';
export const LR_DOLA_CLEAN = 'lr=unwatermarked';
export const LR_WATERMARK_DOLA_RE = /lr=watermark(?:_dyn)?/g;
export const DOWNSIZE_WATERMARK_RE = /downsize_watermark_[^&]+/g;

/** 动态水印的 logo 查询参数 [上游 rules.json id 3] */
export const LOGO_TYPE_PARAM = 'logo_type';
export const LOGO_TYPE_VALUE = 'video_gen_watermark_dyn';

/** 水印 / 缩略图 判定用的关键字（运行期分类用） */
export const WATERMARK_HINTS = ['watermark', 'downsize', 'logo_type'] as const;
export const THUMB_HINTS = ['~tplv-', 'thumb', 'cover', 'downsize'] as const;

/** 视频 CDN 域名（用于选择 lr 改写取值） [上游] */
export const HOST_DOUBAO = 'doubao.com';
export const HOST_DOLA = 'dola.com';
export const HOST_DOUYINVOD = 'douyinvod.com';

/**
 * 图片 CDN 域名 [实测]
 * ⚠️ `p3-ibyteimg.com` / `p9-ibyteimg.com` **不是** `ibyteimg.com` 的子域
 * （二阶域分别是 `p3-ibyteimg` / `p9-ibyteimg`），必须逐个列出。
 */
export const HOST_IMAGE_CDN_SUFFIXES = [
  'byteimg.com',
  'ibyteimg.com',
  'p3-ibyteimg.com',
  'p9-ibyteimg.com',
  'ibytedtos.com',
  'doubao.com',
  /** [实测 2026-09-28] 创作树 `node_cover` 与视频封面的域名（`p26-sign.douyinpic.com`） */
  'douyinpic.com',
] as const;

/**
 * 封面 / 缩略图 CDN 的 Referer 注入（2026-09-28 第十轮）。
 *
 * 卡片缩略图用的是**站点自己的带水印封面图**（省流量、与站点显示一致，不抓原片帧）。
 * 但这些图片域要求站内 Referer，而弹窗发出的请求 Referer 是扩展页（`chrome-extension://…`）
 * → 403 → 卡片只剩灰底占位。这里按域名后缀给它们补上同一个 Referer（资源类型含 `image`）。
 *
 * ⚠️ 与 `CORS_INJECT_HOST_FILTERS`（媒体域）分开维护：封面不需要 CORS 响应头，只需要 Referer。
 * ⚠️ 封面 URL 是**带时效签名**的：过期后仍会 403（回退占位），F5 重解析会换一份新的。
 * ℹ️ 故意不含 `doubao.com`（站点自身域的请求本来就是站内 Referer，无需改写）。
 */
export const COVER_INJECT_HOST_FILTERS = [
  '||douyinpic.com/',
  '||byteimg.com/',
  '||ibytedtos.com/',
] as const;

/**
 * 分享短链域名 [实测]
 * `aka.doubaocdn.com/s/<token>` 是**分享卡片短链图**，不是视频封面：
 * 首轮联调里它既让卡片缩略图加载失败，又因为被当成封面而导致**指纹漂移**
 * （换一次封面就变成另一条记录，`docs/03` P1-4）。
 */
export const HOST_SHARE_SHORTLINK_SUFFIX = 'doubaocdn.com';

/**
 * CORS 头注入 / Referer 注入的域名过滤 [上游 + 实测修正 2026-09-26]
 *
 * 上游只写了 `douyinvod.com`；实测视频还来自 `v26-vdl.doubao.com` 与
 * `vas-lf-x.snssdk.com`，若只覆盖旧域名，方案 A（`chrome.downloads`）与
 * 方案 B（页面内 fetch + blob）在这些域名上都会拿不到 CORS 头 / Referer。
 * 每个过滤串生成一条规则（DNR 的 `urlFilter` 一次只接受一个字符串）。
 *
 * ⚠️ 域名写法注意：`v26-vdl.doubao.com` **不是** `vdl.doubao.com` 的子域
 * （二阶域是 `v26-vdl.doubao`），所以这里用 `vdl.doubao.com` 作为后缀没有意义，
 * 但 DNR 的 `urlFilter` 是**子串匹配**，`||vdl.doubao.com/` 能命中
 * `v26-vdl.doubao.com`，因此保持这种写法即可。
 */
export const CORS_INJECT_HOST_FILTERS = [
  '||douyinvod.com/',
  '||vdl.doubao.com/',
  '||vas-lf-x.snssdk.com/',
] as const;

/** 下载防盗链 Referer [上游] */
export const DOWNLOAD_REFERER = 'https://www.doubao.com/';

/* ============================================================================
 * §4 DOM 契约
 *   ⚠️ P2 阶段必须用真实豆包页面实测确认后回填，禁止凭猜测写死。
 *   在未确认前，`verified=false`，注射器会走「候选选择器 + 文本/aria 兜底」的宽松策略，
 *   并把命中结果打到控制台，方便实机校准。
 * ========================================================================== */

/**
 * DOM 契约（**只剩「会话标题候选」这一项还有消费者**）。
 *
 * 📌 2026-09-26 第四轮收尾：图片注入按钮**整体删除**，连带以下字段一并删掉，
 *    因为它们已经没有任何消费者（留着只会误导排查）：
 *      - `imageContainer`：从未被注入逻辑使用（挂载点一直是几何启发式）；
 *      - `minImageSize`：只被注入器的尺寸预筛用；
 *      - `firstMessageText`：早已不参与会话名命名（会把上一段对话的消息当标题）。
 *    结论与证据见 `docs/03` §9.8 / §9.10。
 */
export interface DomContract {
  /** 是否已用真实页面实测确认 */
  verified: boolean;
  /**
   * 会话标题候选选择器（取不到时退回 document.title）。
   *
   * ⚠️ [实测 2026-09-26] **当前站点这几个候选全部未命中**，实际来源一直是
   * `document.title`（对话页 `会话名 - 豆包`，分享页同形态）。
   * 候选保留（站点加类名时会自动生效），但**不要指望它**；真正的可靠性来自
   * `core/title.ts` 的「快照闸门 + 弱标题识别」。
   */
  conversationTitle: string[];
  /** 站点知识备忘（不改行为，只留痕） */
  notes: string[];
}

/**
 * ✅ `verified = true`（2026-09-26 用真实豆包页面实测确认，证据见 `docs/03` §9.8）。
 *
 * 实测结论：
 *   - **会话名**：`conversationTitle` 候选**全部未命中**，实际来源是 `document.title`
 *     （对话页 `0924_… - 豆包`、分享页同形态）。因此「读不到标题」不是选择器问题，
 *     靠 `core/title.ts` 的闸门 + 有界重试 + `<title>` 变更监听解决。
 *   - **页面侧已彻底零干预**：不注入任何元素（含 `<style>`）、不改任何样式、不拦截任何点击。
 *     图片按钮注入能力**已整体删除**（实测它从未生效，早年注入在左下角时还遮挡了
 *     豆包原生的图片下载入口）；所有无水印下载统一由弹窗资源库提供。
 */
export const DOM_CONTRACT: DomContract = {
  verified: true,
  conversationTitle: [
    '[class*="conversation-title"]',
    '[class*="chat-title"]',
    '[class*="chatHeader"] [class*="title"]',
    '[class*="conversationHeader"]',
    'header h1',
  ],
  notes: [
    '【2026-09-26 第四轮收尾 · 页面侧彻底零干预】',
    '  历史上页面侧试过三种做法，全部退场：①「接管原生 ⬇ 的点击」（K1）、',
    '  ②「预览替换」（K3）、③「注入一个常显的图片下载按钮」（K2）。',
    '  ③ 退场的原因有两条：',
    '    · 实测**从未注入成功**（`ui.imagebtn` 恒 `matched=0`：页面 <img src> 是水印缩略图后缀，',
    '      与解析结果的原片 URL 对不上键，且存在 p3-/p6- 镜像域名）；',
    '    · 更要紧的是它早年注入在**左下角**时会**压在豆包原生的悬停操作行**（`66 · ↻ · ⬇`）上，',
    '      既看不见也点不到 —— 用户曾经的困惑「为什么原生按钮看起来被隐藏了」就来自这里。',
    '  现在：不注入任何元素（连 `<style>` 都没有）、不改任何样式、不拦截任何点击；',
    '  所有无水印下载统一由**弹窗资源库**提供，页面上隐藏的原生 ⬇ 由用户自行悬停使用。',
    '【已废弃的选择器知识】接管方案退场后删掉的字段：nativeDownloadButton / imageDownloadButton /',
    '  downloadButtonAriaHints / videoContainer / messageActionRow / imageContainer / minImageSize /',
    '  firstMessageText。若日后要恢复其中某项，可从 git 历史或 docs/03 取回。',
    '【实测】图片原片后缀为 `~tplv-a9rns2rl98-image_raw.png`（本身就是原片后缀，无需改写）；',
    '  实测大图结构：`img.pointer-events-none.absolute.inset-0` → `div.relative.inline-flex.h-fit`',
    '  → `div.image-box-grid-item-*` → `div.image-box-grid-*`。',
    '【实测】视频转码/播放域已不止 `douyinvod.com`：还有 `v26-vdl.doubao.com` / `v11-vdl.doubao.com`，',
    '  备选播放源在 `vas-lf-x.snssdk.com`；分享短链图在 `aka.doubaocdn.com`（**不是封面**，已排除）。',
    '【实测】chain/single 响应里 `creation.video` 含 `video_id`(=vid) / `video_duration` / `video_model`(多层转义 JSON) / `fallback_api`。',
    '【实测 2026-09-26 · 分享页标题】真正的字段是 `data.share_info.share_name`',
    '  （`share_info.title` / `share_title` / `name` 全部不存在）；`share_info.bot.name` 是「豆包」、',
    '  `share_info.user.nick_name` 是用户名 —— 取名字段时必须避开后两者。',
    '【第四轮实测：标题不能在「切换瞬间」读】SPA 切会话时 document.title 滞后一拍、',
    '  会话标题元素可能还挂着旧节点、消息容器更是上一段对话的内容 —— 读到就采用会把',
    '  上一个对话的标题错位到新会话上（实测三度踩坑）。对策是 core/title.ts 的**快照闸门**',
    '  + **弱标题识别**（兜底值 / 站点通用名 `豆包 - 字节跳动旗下 AI 智能助手` 都不可当会话名）。',
    '【实测 2026-09-27 · chain/single 是用户级 IM 同步通道】后台任务（视频生成）完成时，',
    '  服务端会把**其它会话**的消息从当前打开的 chain 连接推送下来（实测：停留在会话 A 的页面',
    '  收到了会话 B 的「生成完成」消息）。因此响应归属必须按**响应体自报的 conversation_id**',
    '  判定（`classifyResponseConv`），不能只看「请求是发给哪个会话的」—— 后者拦不住跨会话推送。',
    '【实测 2026-09-27 · 新会话占位 ID】新建对话时 URL 先是 `/chat/local_<数字>`，',
    '  提交首条消息后才 replaceState 成真实 ID。涉及「请求时刻快照 convId」的判定都必须豁免',
    '  `local_` 占位（`isLocalConvId`），否则新会话的生成响应会被异会话过滤器误杀。',
  ],
};

/* ============================================================================
 * §5 站点匹配
 * ========================================================================== */

export const DOUBAO_URL_PATTERNS = ['*://*.doubao.com/*', '*://*.dola.com/*'] as const;

/**
 * host_permissions（构建期由 `scripts/build.mjs` 投影进 manifest）。
 *
 * [实测修正 2026-09-26] 增补 `*.snssdk.com`：备选播放源
 * `vas-lf-x.snssdk.com` 不在原列表里，缺权限会让方案 A/B 直接失败。
 * `*.vdl.doubao.com` 已由 `*.doubao.com` 覆盖；分享短链 `aka.doubaocdn.com`
 * 只作为页面内 `<img>` 出现（插件不主动请求它，且已判定为「不可用封面」），故不申请权限。
 */
export const HOST_PERMISSIONS = [
  '*://*.doubao.com/*',
  '*://*.dola.com/*',
  '*://*.byteimg.com/*',
  '*://*.ibyteimg.com/*',
  '*://*.p3-ibyteimg.com/*',
  '*://*.p9-ibyteimg.com/*',
  '*://*.douyinvod.com/*',
  '*://*.snssdk.com/*',
  '*://*.douyin.com/*',
] as const;

/** 上游遗留的存储键：安装时清理，避免占用配额（不迁移） */
export const LEGACY_STORAGE_KEYS = [
  'doubao-seedance-enhancer_enabled',
  'doubao-seedance-enhancer_duration',
  'seedance_extracted_urls',
] as const;
