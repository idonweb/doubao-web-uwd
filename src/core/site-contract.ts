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
 */

/**
 * 「按需实测文件字节数」的 Range 取值（2026-09-28 探针实测）。
 *
 * 用途：创作树里没有的条目（超期视频 / 超过约三个月的旧图片）拿不到节点 `size`，
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
 * §3 水印改写规则
 *   同时用于：① 构建期生成 DNR 规则；② 运行期 URL 归一化（media-url.ts）
 * ========================================================================== */

export interface SuffixRewriteRule {
  /** 命中用的正则（对完整 URL 生效） */
  test: RegExp;
  /** 替换函数：返回改写后的 URL */
  apply: (url: string) => string;
  /** 生成 DNR regexFilter 时使用的原始模式（必须带一个捕获组） */
  dnrPattern: string;
  /** DNR regexSubstitution，`$1` 对应上文捕获组 */
  dnrSubstitution: string;
  note: string;
}

/** 图片水印后缀族 → 无水印后缀 [上游 rules.json id 1~6] */
export const IMAGE_SUFFIX_REWRITES: SuffixRewriteRule[] = [
  {
    test: /~tplv-a9rns2rl98-downsize_watermark_1_6\.png/,
    apply: (u) => u.replace(/~tplv-a9rns2rl98-downsize_watermark_1_6\.png/g, '~tplv-a9rns2rl98-image-qvalue.jpeg'),
    dnrPattern: '^(https://[^/]+/[^?]+)~tplv-a9rns2rl98-downsize_watermark_1_6\\.png',
    dnrSubstitution: '\\1~tplv-a9rns2rl98-image-qvalue.jpeg',
    note: 'a9rns2rl98 图片水印后缀',
  },
  {
    test: /~tplv-a9rns2rl98-video_dsz_watermark_1_6\.png/,
    apply: (u) =>
      u.replace(/~tplv-a9rns2rl98-video_dsz_watermark_1_6\.png/g, '~tplv-a9rns2rl98-video_cover.jpeg'),
    dnrPattern: '^(https://[^/]+/[^?]+)~tplv-a9rns2rl98-video_dsz_watermark_1_6\\.png',
    dnrSubstitution: '\\1~tplv-a9rns2rl98-video_cover.jpeg',
    note: 'a9rns2rl98 视频封面水印后缀',
  },
  {
    test: /~tplv-6187y3xstg-watermark.*\.(?:png|jpg|jpeg)/,
    apply: (u) => u.replace(/~tplv-6187y3xstg-watermark[^?#]*\.(?:png|jpg|jpeg)/g, '~tplv-6187y3xstg-image.jpeg'),
    dnrPattern: '^(https://[^/]+/[^?]+)~tplv-6187y3xstg-watermark.*\\.(?:png|jpg|jpeg)',
    dnrSubstitution: '\\1~tplv-6187y3xstg-image.jpeg',
    note: '6187y3xstg 图片水印后缀',
  },
  {
    test: /~tplv-6187y3xstg-video_dsz_watermark.*\.(?:png|jpg|jpeg)/,
    apply: (u) =>
      u.replace(/~tplv-6187y3xstg-video_dsz_watermark[^?#]*\.(?:png|jpg|jpeg)/g, '~tplv-6187y3xstg-video_cover.jpeg'),
    dnrPattern: '^(https://[^/]+/[^?]+)~tplv-6187y3xstg-video_dsz_watermark.*\\.(?:png|jpg|jpeg)',
    dnrSubstitution: '\\1~tplv-6187y3xstg-video_cover.jpeg',
    note: '6187y3xstg 视频封面水印后缀',
  },
  {
    test: /~tplv-6187y3xstg-downsize_watermark.*\.(?:png|jpg|jpeg)/,
    apply: (u) => u.replace(/~tplv-6187y3xstg-downsize_watermark[^?#]*\.(?:png|jpg|jpeg)/g, '~tplv-6187y3xstg-image.jpeg'),
    dnrPattern: '^(https://[^/]+/[^?]+)~tplv-6187y3xstg-downsize_watermark.*\\.(?:png|jpg|jpeg)',
    dnrSubstitution: '\\1~tplv-6187y3xstg-image.jpeg',
    note: '6187y3xstg 降尺寸水印后缀',
  },
];

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
