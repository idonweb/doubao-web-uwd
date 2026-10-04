/**
 * 测试夹具（fixture）。
 *
 * ⚠️ 说明：下列样本是按 **上游实测 + 2026-09-26 首轮实机联调实测**（site-contract §2、
 * `docs/03` §2/§4）逐字构造的**结构等价样本** —— 字段路径、转义层级、base64 编码方式
 * 都与真实响应一致，但**不是**从线上抓取的真实报文（已剔除真实域名下的真实 token）。
 */

/** 标准 base64 编码（用 btoa 而不是 Buffer，避免测试文件依赖 @types/node） */
const b64 = (value: string): string => btoa(value);

/** 保证 base64 长度 >= 100（chain 正则要求），不足则用路径片段补齐 */
export function longVodUrl(path: string, query: string): string {
  const pad = 'a'.repeat(Math.max(0, 120 - path.length));
  return `https://v3-dy.douyinvod.com/${path}/${pad}/video.mp4?${query}`;
}

/* --------------------------------------------------------------------------- */
/* 媒体 URL 常量（供各段样本共用）                                                */
/* --------------------------------------------------------------------------- */

const video1080 = longVodUrl('ssample/1080', 'lr=unwatermarked&definition=1080p');
const video720 = longVodUrl('ssample/720', 'lr=unwatermarked&definition=720p');

export const VIDEO_ORI_RAW =
  'https://v3-dy.douyinvod.com/ssample/ori/video.mp4?lr=video_gen_no_watermark';
export const VIDEO_DOWNLOAD_URL =
  'https://v3-dy.douyinvod.com/ssample/ori/video.mp4?lr=video_gen_watermark_dyn&logo_type=video_gen_watermark_dyn&x=1';
export const VIDEO_THUMB =
  'https://p3-ibyteimg.com/img/ssample-thumb-video~tplv-a9rns2rl98-video_dsz_watermark_1_6.png';

export const IMAGE_RAW = 'https://p9-ibyteimg.com/img/ssample-ori~tplv-a9rns2rl98-image-qvalue.jpeg';
export const IMAGE_PREVIEW = 'https://p9-ibyteimg.com/img/ssample-prev~tplv-a9rns2rl98-image-qvalue.jpeg';
export const IMAGE_THUMB =
  'https://p9-ibyteimg.com/img/ssample-thumb~tplv-a9rns2rl98-downsize_watermark_1_6.png';

/* --------------------------------------------------------------------------- */
/* chain/single 响应样本（2026-09-26 实测形态）                                   */
/* --------------------------------------------------------------------------- */

/** 实测 `main_url` 解码后的形态：带水印转码流（**不是** `unwatermarked`） */
export const chainWatermarkedUrl = longVodUrl(
  'chain/transcode',
  'lr=video_gen_watermark_dyn&mime_type=video_mp4',
);
/** 上游时代存在的「自带 unwatermarked」形态（保留用于验证解码与标记） */
export const chainUnwatermarkedUrl = longVodUrl('chain/raw', 'lr=unwatermarked&x=1');

/** 实测 `video_id`（就是 vid） */
export const CHAIN_VID = 'v0d69cg10004daqj77i7dld84jf8qsjg';
/** 实测 `fallback_api`：备选播放源，带 logo_type=video_gen_watermark_dyn */
export const CHAIN_FALLBACK_API =
  'https://vas-lf-x.snssdk.com/video/fplay/v0200f00000abcdef/?logo_type=video_gen_watermark_dyn&x=1';
/** 实测 `video_duration` */
export const CHAIN_DURATION = 24.065;

/**
 * `video_model` 的**二次转义**形态。
 *
 * 实测：报文里 `main_url` 长这样 —— `\\\"main_url\\\"`（3 个反斜杠 + 引号），
 * 即外层 JSON 解一次之后，拿到的仍是一个**被转义过的 JSON 文本**。
 * 因此 `JSON.stringify` 之前先手工把 `"` 换成 `\"`，让最终报文与线上一致。
 */
const chainModelPlain = JSON.stringify({
  video_list: {
    video_1: {
      main_url: b64(chainWatermarkedUrl),
      definition: '720p',
      quality_type: 2,
    },
  },
});
export const CHAIN_MODEL_DOUBLE_ESCAPED = chainModelPlain.replace(/"/g, '\\"');

/**
 * chain/single 的报文文本：结构与实测一致（video_id / video_duration / video_model / fallback_api）。
 *
 * 2026-09-28 只读探针实测的外层路径是
 * `data.downlink_body.pull_singe_chain_downlink_body.messages[i]`（站点字段名**确实**拼成
 * `pull_singe`，不是 `single`），且每条 message 自带 `create_time`（**秒级** Unix）——
 * 与网页上「5月23日 20:22」那种显示完全同源。夹具按实测形状构造，
 * 顺带覆盖「消息时间向下继承给 creation」这条行为（`extractChainRaw` 会写进 `raw.createdAt`）。
 */
export const CHAIN_MESSAGE_CREATE_TIME = 1790520877; // = 2026-09-27 22:54:37
export const CHAIN_RESPONSE = JSON.stringify({
  code: 0,
  msg: '',
  data: {
    downlink_body: {
      pull_singe_chain_downlink_body: {
        messages: [
          {
            message_id: '56852687132556800',
            conversation_id: '38429621189804034',
            create_time: CHAIN_MESSAGE_CREATE_TIME,
            update_time: CHAIN_MESSAGE_CREATE_TIME,
            content_block: [
              {
                content: {
                  creation_block: {
                    creations: [
                      {
                        video: {
                          video_id: CHAIN_VID,
                          video_duration: CHAIN_DURATION,
                          cover: { image_thumb: { url: VIDEO_THUMB }, image_preview: { url: VIDEO_THUMB } },
                          video_model: CHAIN_MODEL_DOUBLE_ESCAPED,
                          fallback_api: CHAIN_FALLBACK_API,
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
    },
  },
});

/**
 * 退化形态：只有 base64 `main_url`、没有 `video_id` 也没有 `ori_raw`。
 * 用于验证「JSON 结构走不通时的正则兜底只产出候选地址」（P0-1 修复方向 1）。
 */
export const CHAIN_RESPONSE_URL_ONLY = JSON.stringify({
  code: 0,
  data: { raw_json_fragment: `{\\"main_url\\":\\"${b64(chainWatermarkedUrl)}\\"}` },
});

/** 整段报文都不是 JSON —— 正则兜底仍然要能工作 */
export const CHAIN_RESPONSE_NOT_JSON = `not-json {"a":1} \\"main_url\\":\\"${b64(chainWatermarkedUrl)}\\"`;

/* --------------------------------------------------------------------------- */
/* SSE 样本                                                                    */
/* --------------------------------------------------------------------------- */

const videoCreation = {
  video: {
    vid: 'v0abc123def456',
    download_url: VIDEO_DOWNLOAD_URL,
    // 2026-09-28 实测：封面在 `cover.{image_thumb|image_preview}.url`（`video_thumb` 不存在）
    cover: { image_thumb: { url: VIDEO_THUMB }, image_preview: { url: VIDEO_THUMB } },
    video_ori_raw: { url: VIDEO_ORI_RAW },
    video_model: JSON.stringify({
      video_list: [
        { main_url: b64(video1080), definition: '1080p', quality_type: 1 },
        { main_url: b64(video720), definition: '720p', quality_type: 2 },
      ],
    }),
    /*
     * 2026-09-27 实测（探针采样，`docs/03` §12）：数字字段**类型不稳定** ——
     * 同一 vid 的多条报文里 width 可能是字符串。fixture 取「字符串宽 + 数字高」
     * 同时覆盖两种形态；**没有 size 字段**（实测整个 video 对象树都不给）。
     */
    width: '1080',
    height: 1920,
    duration: 15,
  },
};

/*
 * 2026-09-27 实测（探针采样，`docs/03` §12）：成品 image 的真实结构 ——
 * 顶层**没有** width / height / size，宽高在 image_ori_raw / image_ori /
 * image_preview / image_thumb 各子对象里（{url, width, height, url_formats}）。
 * size 整个对象树都不存在（站点不给）。
 */
const imageCreation = {
  image: {
    image_thumb: { url: IMAGE_THUMB, width: 2720, height: 1520 },
    // 2026-09-28 实测：预览字段叫 `preview_img`（`image_preview` 不存在）
    preview_img: { url: IMAGE_PREVIEW, width: 2720, height: 1520 },
    image_ori_raw: { url: IMAGE_RAW, width: 2720, height: 1520 },
  },
};

/** 只有封面图的「视频」——上游会把它当成一条 video 记录（成因 3），本项目必须丢弃 */
const coverOnlyCreation = {
  video: {
    // 只有封面、没有 vid / ori_raw —— 上游会把它当成一条 video 记录，本项目必须丢弃
    cover: { image_thumb: { url: 'https://p3-ibyteimg.com/img/cover-only~tplv-a9rns2rl98-video_cover.jpeg' } },
  },
};

function sseEvent(data: unknown): string {
  return `event: message\ndata: ${JSON.stringify(data)}\n\n`;
}

function patchEvent(creations: unknown[]): string {
  return sseEvent({
    patch_op: [
      {
        patch_type: 1,
        patch_value: {
          content_block: [
            { content: { creation_block: { creations } } },
          ],
        },
      },
    ],
  });
}

/** 一段完整的 SSE 响应文本：视频事件 + 图片事件 + 只有封面的事件 + 噪声事件 */
export const SSE_RESPONSE =
  patchEvent([videoCreation]) +
  patchEvent([imageCreation]) +
  patchEvent([coverOnlyCreation]) +
  'event: message\ndata: {"patch_op":[{"patch_value":{"content_block":[{"content":{"text_block":{"text":"done"}}}]}}]}\n\n' +
  'data: [DONE]\n\n';

/** 视频重复推送（SSE 增量）—— 用于验证 upsert 不会产生重复条目 */
export const SSE_RESPONSE_REPEATED = patchEvent([videoCreation]) + patchEvent([videoCreation]);

/* --------------------------------------------------------------------------- */
/* thread 页面样本                                                              */
/* --------------------------------------------------------------------------- */

const threadVideo = {
  vid: 'v0threadabc12345',
  download_url: VIDEO_DOWNLOAD_URL,
  cover: { image_thumb: { url: VIDEO_THUMB }, image_preview: { url: VIDEO_THUMB } },
  video_model: JSON.stringify({
    video_list: [{ main_url: b64(video1080), definition: '1080p' }],
  }),
};

const threadImage = {
  image_thumb: { url: IMAGE_THUMB },
  image_preview: { url: IMAGE_PREVIEW },
  image_ori_raw: { url: IMAGE_RAW },
};

/** 分享页消息同样自带 `create_time`（秒级）—— 用于覆盖「分享页也能拿到生成时间」 */
export const THREAD_MESSAGE_CREATE_TIME = 1779538923; // = 2026-05-23 20:22:03
const MESSAGE_LIST = [
  {
    create_time: THREAD_MESSAGE_CREATE_TIME,
    content_block: [
      { content: { creation_block: { creations: [{ video: threadVideo }, { image: threadImage }] } } },
    ],
  },
];

export const SHARE_INFO = {
  isMobileShareId: true,
  data: {
    share_info: { title: '分享 · 赛博朋克街道' },
    message_snapshot: { message_list: MESSAGE_LIST },
  },
};

/** 结构 ①：["thread_xxx/page","shareInfo",{...}] */
export const FN_ARGS_DIRECT = JSON.stringify(['thread_8kD2/page', 'shareInfo', SHARE_INFO]);

/** 结构 ②：["thread_xxx/page",[{key:"shareInfo",routerDataFnArgs:["<JSON>"]}]] */
export const FN_ARGS_ROUTER = JSON.stringify([
  'thread_8kD2/page',
  [{ key: 'shareInfo', routerDataFnArgs: [JSON.stringify(SHARE_INFO)] }],
]);

/** 无关脚本（应当被忽略） */
export const FN_ARGS_UNRELATED = JSON.stringify(['thread_8kD2/page', 'otherThing', { foo: 'bar' }]);

/* --------------------------------------------------------------------------- */
/* vid 三步 API 样本                                                            */
/* --------------------------------------------------------------------------- */

export const HOMEPAGE_RESPONSE = {
  code: 0,
  data: {
    children: [
      { id: 'root-1', name: '我的收藏' },
      { id: 'cid-123', name: '我的创作' },
    ],
  },
};

/*
 * node_info 第 1 页 [2026-09-28 探针实测形状]。
 *
 * 实测一个节点的完整字段：id / name / key / node_type / size / source / content /
 * … / conversation_id / node_cover / parent_id / **create_time** / **update_time**。
 * 这里只保留解析要用到的几项，但**结构与字段名与实测一致**：
 *   · `create_time`（秒级 Unix）→ `readNodeInfoPage()` 当成「作品真实生成时间」带回，供排序；
 *   · `size`（字节）→ 实测与下载到的原片字节数**完全一致**，供卡片显示「文件大小」。
 */
export const NODE_INFO_VIDEO_SIZE = 8_698_069; // 实测样例：节点 size ↔ 落盘 mp4 字节数一致
export const NODE_INFO_VIDEO_COVER =
  'https://p26-sign.douyinpic.com/tos-cn-p-9ecd54/cover~tplv-noop.image?x-expires=1790641295&x-signature=abc';
export const NODE_INFO_RESPONSE = {
  code: 0,
  data: {
    children: [
      { id: 'nid-1', key: 'v0other000000', node_type: 6, create_time: 1790461738, update_time: 1790461748, size: 12_698_192 },
      {
        id: 'nid-2',
        key: 'v0abc123def456',
        node_type: 6,
        create_time: 1790520877,
        update_time: 1790520885,
        size: NODE_INFO_VIDEO_SIZE,
        // 站点自己的封面图（带签名）—— 链式报文没给 video_thumb 时用它兜底
        node_cover: { list_view: { cover_url: NODE_INFO_VIDEO_COVER, image_width: 720, image_height: 1280 } },
      },
    ],
  },
};

export const DOWNLOAD_INFO_RESPONSE = {
  code: 0,
  data: {
    /*
     * 2026-09-27：download_infos[0] 上游只取 main_url；本项目顺带读 width / height / size
     * （字段**存在才带回**，缺了就让界面显示「—」，绝不编造）。
     *
     * 宽高取 1280×720：用户实机确认豆包当前**只提供 720P 这一个真实输出规格**，
     * 清晰度标签据此派生（`core/quality.ts`）。若站点日后换档，标签会跟着实际宽高走。
     */
    download_infos: [
      {
        main_url: 'https://v3-dy.douyinvod.com/full/original.mp4?lr=unwatermarked',
        width: 1280,
        height: 720,
        size: 41_000_000,
      },
    ],
  },
};

/* --------------------------------------------------------------------------- */
/* 视频分享页（/video-sharing）样本（2026-10-02 第十六轮）                          */
/*                                                                             */
/* 形态取自 2026-10-02 对该接口的直调实测（`POST /creativity/share/                */
/* get_video_share_info`，body `{share_id, vid, creation_id}`）：响应是**普通 JSON** */
/* （不是 SSE、也没有多层转义），字段为 `data.{play_info,user_info,prompt,source_info}`。*/
/* 下面按实测逐字构造，只把签名/域名替换成等价假值。                                */
/* --------------------------------------------------------------------------- */

/** 实测播放地址的宿主是 `*.365yg.com`（CDN 调度，取值会变），带水印 + `download=true` */
export const SHARE_VIDEO_MAIN =
  'https://v9-default.365yg.com/ssample/video/tos/cn/tos-cn-v-9ecd54/ssample-hash/?a=0&lr=video_gen_watermark_dyn&mime_type=video_mp4&download=true';
export const SHARE_VIDEO_BACKUP =
  'https://v26-default.365yg.com/ssample/video/tos/cn/tos-cn-v-9ecd54/ssample-hash/?a=0&lr=video_gen_watermark_dyn&mime_type=video_mp4&download=true';
/** 实测封面在 `p26-sign.douyinpic.com`（站点自己的带水印封面，带时效签名） */
export const SHARE_VIDEO_POSTER =
  'https://p26-sign.douyinpic.com/tos-cn-p-9ecd54/ssample-poster~tplv-noop.image?x-expires=1791528392&x-signature=abc';
/** 实测 URL 查询参数里的 vid（响应体里**没有** vid） */
export const SHARE_VIDEO_ID = 'v0269cg10004daamhk27dld2vpu8bbgg';
/** 实测 URL 查询参数里的分享 id */
export const SHARE_ID = '57139820578269954';

/** 实测响应形状（`code` / `msg` / `data.{play_info,user_info,prompt,source_info}`） */
export const VIDEO_SHARE_INFO_RESPONSE = {
  code: 0,
  msg: '',
  data: {
    play_info: {
      main: SHARE_VIDEO_MAIN,
      backup: SHARE_VIDEO_BACKUP,
      height: 1280,
      width: 720,
      definition: '720p',
      poster_url: SHARE_VIDEO_POSTER,
    },
    user_info: { user_id: 2830607241447786, user_name: '', nickname: '『ф✥』' },
    prompt: '8K 3D CG写实，PBR物理材质，16:9画幅，60fps，暴雨肆虐的建筑群……',
    source_info: { author_uid: 2830607241447786, message_id: '54072066510398466', creation_task_id: '54072741844764674' },
  },
};

/** 实测的分享页 URL 形态（`source_type=mobile`；pathname 就是 `/video-sharing`） */
export const VIDEO_SHARE_URL = `https://www.doubao.com/video-sharing?source_type=mobile&share_id=${SHARE_ID}&video_id=${SHARE_VIDEO_ID}`;

/* --------------------------------------------------------------------------- */
/* 「模型提示」样本（2026-09-29 第十四轮 §34）                                     */
/*                                                                             */
/* 结构等价样本，形态取自实测报文 `uwd-diag-1790690882278.json`：                  */
/*   ① 用户输入消息那批 → `chat_ability`（转义 JSON）→ `ability_param`（**又一层** */
/*      转义 JSON）→ `model`；                                                    */
/*   ② 生成任务 ack 那批 → `ext.ai_creation_tool_list`（转义 JSON 数组）→          */
/*      `tool_name === 'text_to_video'` 那条的 `req_key`。                        */
/* 两层转义直接用嵌套 JSON.stringify 复现（与线上一致，便以验反转义）。            */
/* --------------------------------------------------------------------------- */

/** 实测值：模型名与流程名 */
export const MODEL_HINT_MODEL = 'seedance_v2.0';
export const MODEL_HINT_TOOL = 'seedance_v20_fast_flow';

export const MODEL_HINT_CHAT_ABILITY = {
  cmd: 3100,
  downlink_body: {
    pull_singe_chain_downlink_body: {
      messages: [
        {
          message_id: '1790690096',
          message_from: 'InputBox',
          create_time: 1790690259,
          chat_ability: JSON.stringify({
            ability_type: 17,
            ability_param: JSON.stringify({ ratio: '16:9', model: MODEL_HINT_MODEL, duration: 10 }),
          }),
        },
      ],
    },
  },
};

export const MODEL_HINT_TASK_ACK = {
  cmd: 3100,
  downlink_body: {
    pull_singe_chain_downlink_body: {
      messages: [
        {
          message_id: '57060782466202370',
          create_time: 1790690260,
          ext: {
            // 同批还可能有别的任务：视频那条要靠 tool_name 挑出来
            ai_creation_tool_list: JSON.stringify([
              { task_id: 57049578737520386, tool_name: 'text_to_video', req_key: MODEL_HINT_TOOL, task_type: 6, status: 5 },
              { task_id: 57049578737520999, tool_name: 'image_gen', req_key: 'img_v2_flow', task_type: 4, status: 5 },
            ]),
          },
        },
      ],
    },
  },
};

/**
 * **纯图片任务**的 ack（实测 2026-09-30 §35.8，`uwd-diag-1790732601526.json`）。
 *
 * `ai_creation_tool_list` 里只有图片生成、**没有 `text_to_video`** —— 此时 `tool` 必须「不取」。
 * 旧实现 `(videoEntry ?? entries[0])` 会退到 `entries[0]`，把图片流程当成视频模型记下来
 * （实测症状：图文混合会话里视频卡片的模型药丸直接算不出来）。
 */
export const MODEL_HINT_IMAGE_ONLY_ACK = {
  cmd: 3100,
  downlink_body: {
    pull_singe_chain_downlink_body: {
      messages: [
        {
          message_id: '57064428028053762',
          create_time: 1790732000,
          ext: {
            ai_creation_tool_list: JSON.stringify([
              { task_id: 57064428028053763, tool_name: 'image_gen', req_key: 'seedream_v50s_flow', task_type: 4, status: 5 },
            ]),
          },
        },
      ],
    },
  },
};

/**
 * **站点文案**里的档位名（2026-09-30 §35.11）—— 模型药丸**最可信**的来源。
 *
 * 实测形态（用户截图）：任务 ack 消息的文本块里写着
 * 「本次使用 **Seedance 2.0 Mini** 生成，大约需要 1-3 分钟。」（4 种档位都能这样读到）。
 * 之所以以它为准：`tool` 的变体已被证伪 —— Mini 档位跑的也是 `seedance_v20_fast_flow`。
 */
export const MODEL_LABEL_TEXT = '本次使用 **Seedance 2.0 Mini** 生成，大约需要 1-3 分钟。';
export const MODEL_LABEL_NAME = 'Seedance 2.0 Mini';
/**
 * **老版文案**（2026-09-30 §35.13）：站点把 **2.0 Fast** 档位写成「全能视频模型」——
 * 实测原文见下，用户确认它不是标准版（认不出就会把 Fast 标成 `SD-2.0`）。
 */
export const MODEL_LABEL_LEGACY_TEXT = '本次使用 **Seedance 2.0 全能视频模型** 生成，将消耗 2 个视频生成额度，预计等待 5 分钟。';
export const MODEL_LABEL_LEGACY_NAME = 'Seedance 2.0 全能视频模型';
export const MODEL_LABEL_MESSAGE = {
  cmd: 3100,
  downlink_body: {
    pull_singe_chain_downlink_body: {
      messages: [
        {
          message_id: '57064428028053764',
          create_time: 1790731700,
          content: JSON.stringify({ blocks: [{ type: 1, text: MODEL_LABEL_TEXT }] }),
        },
      ],
    },
  },
};

/* --------------------------------------------------------------------------- */
/* 老链路「修改生成」的 image_list（2026-10-03 第二十三轮 §43）                    */
/* --------------------------------------------------------------------------- */

/** 两档共用的对象 key（实测形状：`tos-cn-i-a9rns2rl98/rc_gen_image/<32位hash>.jpeg`） */
export const IMG_LIST_KEY_VALUE = 'tos-cn-i-a9rns2rl98/rc_gen_image/6e2b4866e9814c64a206e9b9f2d32e52.jpeg';
/** 预览档（**水印在左上**）—— 站点把「预览档 URL」放在 `image_raw` 字段里（字段名有误导性） */
export const IMG_LIST_PRE_URL = `https://p3-flow-imagex-sign.byteimg.com/${IMG_LIST_KEY_VALUE}~tplv-a9rns2rl98-image_pre_watermark_1_5b.png?x-signature=PRE`;
/** 下载档（**水印在右下**）—— 补角的像素来源 */
export const IMG_LIST_DLD_URL = `https://p26-flow-imagex-sign.byteimg.com/${IMG_LIST_KEY_VALUE}~tplv-a9rns2rl98-image_dld_watermark_1_5b.png?x-signature=DLD`;
/** 缩略档（卡片封面） */
export const IMG_LIST_THUMB_URL = `https://p9-flow-imagex-sign.byteimg.com/${IMG_LIST_KEY_VALUE}~tplv-a9rns2rl98-downsize_watermark_1_5_b.png?x-signature=THM`;
/** 该批消息的生成时间（秒级 Unix） */
export const IMG_LIST_CREATE_TIME = 1771000000;
/** 两档共同的真实尺寸（实测 1536×2730） */
export const IMG_LIST_WIDTH = 1536;
export const IMG_LIST_HEIGHT = 2730;

/** 一条 `image_list` 条目：**没有 `image_ori_raw`**（站点没给现成原片） */
export const IMG_LIST_ENTRY = {
  key: IMG_LIST_KEY_VALUE,
  image_thumb: { url: IMG_LIST_THUMB_URL, width: 326, height: 580, format: 'jpeg' },
  image_ori: { url: IMG_LIST_DLD_URL, width: IMG_LIST_WIDTH, height: IMG_LIST_HEIGHT, format: 'png' },
  preview_img: { url: IMG_LIST_PRE_URL, width: IMG_LIST_WIDTH, height: IMG_LIST_HEIGHT, format: 'png' },
  image_raw: { url: IMG_LIST_PRE_URL, width: IMG_LIST_WIDTH, height: IMG_LIST_HEIGHT, format: 'png' },
  // 实测：只有宽高，**没有 url**（死字段）
  image_thumb_ori: { width: 326, height: 580, format: 'jpeg' },
};

/** 只有预览档、缺下载档的条目（补不了角 ⇒ 应落 `state='thumb'`） */
export const IMG_LIST_ENTRY_NO_DLD = {
  key: IMG_LIST_KEY_VALUE,
  image_thumb: { url: IMG_LIST_THUMB_URL, width: 326, height: 580, format: 'jpeg' },
  image_raw: { url: IMG_LIST_PRE_URL, width: IMG_LIST_WIDTH, height: IMG_LIST_HEIGHT, format: 'png' },
};

/**
 * 报文形状照实测：`messages[i].content` 是**被转义的 JSON 字符串**，解一层才是 `{ image_list: [...] }`
 * （探针实录路径 `…messages[4].content.image_list[0]`，`docs/03` §43.5）。
 */
export const CHAIN_IMAGE_LIST_RESPONSE = JSON.stringify({
  cmd: 3100,
  downlink_body: {
    pull_singe_chain_downlink_body: {
      messages: [
        {
          message_id: '57100000000000001',
          create_time: IMG_LIST_CREATE_TIME,
          content: JSON.stringify({ image_list: [IMG_LIST_ENTRY] }),
        },
      ],
    },
  },
});

export const CHAIN_IMAGE_LIST_RESPONSE_NO_DLD = JSON.stringify({
  cmd: 3100,
  downlink_body: {
    pull_singe_chain_downlink_body: {
      messages: [
        {
          message_id: '57100000000000002',
          create_time: IMG_LIST_CREATE_TIME,
          content: JSON.stringify({ image_list: [IMG_LIST_ENTRY_NO_DLD] }),
        },
      ],
    },
  },
});
