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

/** chain/single 的报文文本：结构与实测一致（video_id / video_duration / video_model / fallback_api） */
export const CHAIN_RESPONSE = JSON.stringify({
  code: 0,
  msg: '',
  data: {
    message_list: [
      {
        content_block: [
          {
            content: {
              creation_block: {
                creations: [
                  {
                    video: {
                      video_id: CHAIN_VID,
                      video_duration: CHAIN_DURATION,
                      video_thumb: { url: VIDEO_THUMB },
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
    video_thumb: { url: VIDEO_THUMB },
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
    image_preview: { url: IMAGE_PREVIEW, width: 2720, height: 1520 },
    image_ori_raw: { url: IMAGE_RAW, width: 2720, height: 1520 },
  },
};

/** 只有封面图的「视频」——上游会把它当成一条 video 记录（成因 3），本项目必须丢弃 */
const coverOnlyCreation = {
  video: {
    video_thumb: { url: 'https://p3-ibyteimg.com/img/cover-only~tplv-a9rns2rl98-video_cover.jpeg' },
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
  video_thumb: { url: VIDEO_THUMB },
  video_model: JSON.stringify({
    video_list: [{ main_url: b64(video1080), definition: '1080p' }],
  }),
};

const threadImage = {
  image_thumb: { url: IMAGE_THUMB },
  image_preview: { url: IMAGE_PREVIEW },
  image_ori_raw: { url: IMAGE_RAW },
};

const MESSAGE_LIST = [
  {
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

export const NODE_INFO_RESPONSE = {
  code: 0,
  data: {
    children: [
      { id: 'nid-1', key: 'v0other000000' },
      { id: 'nid-2', key: 'v0abc123def456' },
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
