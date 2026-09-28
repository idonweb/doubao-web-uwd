import { describe, expect, it } from 'vitest';

import {
  mediaPathKey,
  buildDnrRules,
  dedupeVariants,
  getHost,
  isHostIn,
  isUsableCover,
  isWatermarked,
  looksUnwatermarked,
  normalizeUrl,
  pathExt,
  pickPrimary,
  rewriteImageSuffix,
  rewriteVideoLr,
  sanitizeMediaUrl,
  stripLogoType,
  stripQuery,
} from '../src/core/media-url';
import type { MediaVariant } from '../src/core/types';

describe('URL 基础工具', () => {
  it('stripQuery 去掉查询与 hash', () => {
    expect(stripQuery('https://a.com/x.png?a=1&b=2#f')).toBe('https://a.com/x.png');
    expect(stripQuery('https://a.com/x.png')).toBe('https://a.com/x.png');
  });

  it('normalizeUrl 抹平协议缺失与域名大小写、忽略查询参数（路径保持大小写）', () => {
    expect(normalizeUrl('https://P9-Ibyteimg.COM/Img/A.PNG?x=1')).toBe('https://p9-ibyteimg.com/Img/A.PNG');
    expect(normalizeUrl('//p9-ibyteimg.com/a.png')).toBe('https://p9-ibyteimg.com/a.png');
  });

  it('getHost / pathExt', () => {
    expect(getHost('https://v3-dy.douyinvod.com/a/b.mp4?x=1')).toBe('v3-dy.douyinvod.com');
    expect(pathExt('https://a.com/x.PNG?q=1')).toBe('png');
    expect(pathExt('https://a.com/x.webp')).toBe('webp');
    expect(pathExt('https://a.com/x')).toBe('png');
  });
});

describe('封面可用性判定（docs/03 P1-4）', () => {
  it('isHostIn 认子域', () => {
    expect(isHostIn('p6-flow-imagex-sign.byteimg.com', ['byteimg.com'])).toBe(true);
    expect(isHostIn('byteimg.com', ['byteimg.com'])).toBe(true);
    expect(isHostIn('notbyteimg.com', ['byteimg.com'])).toBe(false);
  });

  it('图片 CDN 域上的图片可用作封面', () => {
    expect(isUsableCover('https://p3-ibyteimg.com/img/a~tplv-a9rns2rl98-image-qvalue.jpeg')).toBe(true);
    expect(isUsableCover('https://p6-flow-imagex-sign.byteimg.com/tos-cn-i-x/a.jpeg')).toBe(true);
  });

  it('分享短链图 aka.doubaocdn.com/s/<token> 被拒（不是封面，且会导致指纹漂移）', () => {
    expect(isUsableCover('https://aka.doubaocdn.com/s/VVoWwXnvvx')).toBe(false);
    // 带查询参数也一样拒（首轮联调里这条正是「同一视频换封面就变新条目」的成因）
    expect(isUsableCover('https://aka.doubaocdn.com/s/VVoWwXnvvx?a=1')).toBe(false);
  });

  it('非 http(s) 与非 CDN 域一律拒绝', () => {
    expect(isUsableCover('blob:https://www.doubao.com/abc')).toBe(false);
    expect(isUsableCover('data:image/png;base64,AAA')).toBe(false);
    expect(isUsableCover('https://evil.example.com/a.png')).toBe(false);
    expect(isUsableCover('')).toBe(false);
  });
});

describe('水印改写（site-contract §3.3）', () => {
  it('图片水印后缀族全部能改写', () => {
    expect(
      rewriteImageSuffix('https://p3-ibyteimg.com/img/a~tplv-a9rns2rl98-downsize_watermark_1_6.png'),
    ).toBe('https://p3-ibyteimg.com/img/a~tplv-a9rns2rl98-image-qvalue.jpeg');

    expect(
      rewriteImageSuffix('https://p3-ibyteimg.com/img/a~tplv-a9rns2rl98-video_dsz_watermark_1_6.png'),
    ).toBe('https://p3-ibyteimg.com/img/a~tplv-a9rns2rl98-video_cover.jpeg');

    expect(rewriteImageSuffix('https://p3-ibyteimg.com/img/a~tplv-6187y3xstg-watermark_1_6.png')).toBe(
      'https://p3-ibyteimg.com/img/a~tplv-6187y3xstg-image.jpeg',
    );

    expect(rewriteImageSuffix('https://p3-ibyteimg.com/img/a~tplv-6187y3xstg-video_dsz_watermark.jpg')).toBe(
      'https://p3-ibyteimg.com/img/a~tplv-6187y3xstg-video_cover.jpeg',
    );

    expect(rewriteImageSuffix('https://p3-ibyteimg.com/img/a~tplv-6187y3xstg-downsize_watermark_1_6.jpeg')).toBe(
      'https://p3-ibyteimg.com/img/a~tplv-6187y3xstg-image.jpeg',
    );
  });

  it('无水印后缀保持不变（幂等）', () => {
    const url = 'https://p3-ibyteimg.com/img/a~tplv-a9rns2rl98-image-qvalue.jpeg';
    expect(rewriteImageSuffix(url)).toBe(url);
  });

  it('视频 lr 参数：豆包走 video_gen_no_watermark，dola 走 unwatermarked', () => {
    expect(rewriteVideoLr('https://v.douyinvod.com/a.mp4?lr=video_gen_watermark&x=1')).toBe(
      'https://v.douyinvod.com/a.mp4?lr=video_gen_no_watermark&x=1',
    );
    expect(rewriteVideoLr('https://v.douyinvod.com/a.mp4?lr=video_gen_watermark_dyn')).toBe(
      'https://v.douyinvod.com/a.mp4?lr=video_gen_no_watermark',
    );
    expect(rewriteVideoLr('https://v.dola.com/a.mp4?lr=video_gen_watermark')).toBe(
      'https://v.dola.com/a.mp4?lr=unwatermarked',
    );
  });

  it('stripLogoType 只在命中契约取值时移除', () => {
    expect(stripLogoType('https://v.douyinvod.com/a.mp4?lr=x&logo_type=video_gen_watermark_dyn')).toBe(
      'https://v.douyinvod.com/a.mp4?lr=x',
    );
    expect(stripLogoType('https://v.douyinvod.com/a.mp4?logo_type=other')).toBe(
      'https://v.douyinvod.com/a.mp4?logo_type=other',
    );
  });

  it('isWatermarked / looksUnwatermarked', () => {
    expect(isWatermarked('https://a.com/x~tplv-a9rns2rl98-downsize_watermark_1_6.png')).toBe(true);
    expect(isWatermarked('https://a.com/x~tplv-a9rns2rl98-image-qvalue.jpeg')).toBe(false);
    expect(looksUnwatermarked('https://v.douyinvod.com/a.mp4?lr=video_gen_no_watermark')).toBe(true);
    expect(looksUnwatermarked('https://v.douyinvod.com/a.mp4?lr=unwatermarked')).toBe(true);
    expect(looksUnwatermarked('https://v.douyinvod.com/a.mp4?logo_type=video_gen_watermark_dyn')).toBe(false);
  });

  it('sanitizeMediaUrl 组合改写（视频 / 图片）', () => {
    expect(sanitizeMediaUrl('https://v.douyinvod.com/a.mp4?lr=video_gen_watermark_dyn&logo_type=video_gen_watermark_dyn', 'video')).toBe(
      'https://v.douyinvod.com/a.mp4?lr=video_gen_no_watermark',
    );
    expect(sanitizeMediaUrl('https://a.com/x~tplv-a9rns2rl98-downsize_watermark_1_6.png', 'image')).toBe(
      'https://a.com/x~tplv-a9rns2rl98-image-qvalue.jpeg',
    );
  });
});

describe('变体归并', () => {
  const variants: MediaVariant[] = [
    { url: 'https://v.douyinvod.com/a/1080.mp4', label: '1080p', rank: 40, isRaw: true },
    { url: 'https://v.douyinvod.com/a/raw.mp4', label: '无水印原片', rank: 100, isRaw: true },
    { url: 'https://v.douyinvod.com/a/raw.mp4?x=1', label: '无水印（参数改写）', rank: 60, isRaw: true },
    { url: 'https://p3-ibyteimg.com/cover.jpeg', label: '封面', rank: 10, isRaw: false },
  ];

  it('同一路径的不同查询参数视为同一变体，保留 rank 更高者', () => {
    const deduped = dedupeVariants(variants);
    expect(deduped).toHaveLength(3);
    expect(deduped[0].url).toBe('https://v.douyinvod.com/a/raw.mp4');
    expect(deduped[0].rank).toBe(100);
  });

  it('pickPrimary 取 rank 最高的 isRaw 变体', () => {
    expect(pickPrimary(dedupeVariants(variants))).toBe('https://v.douyinvod.com/a/raw.mp4');
  });

  it('没有 isRaw 变体时退回 rank 最高者', () => {
    expect(
      pickPrimary([
        { url: 'https://a.com/thumb.png', label: '缩略图', rank: 10, isRaw: false },
        { url: 'https://a.com/preview.png', label: '预览图', rank: 30, isRaw: false },
      ]),
    ).toBe('https://a.com/preview.png');
  });
});

describe('mediaPathKey：把条目匹配回页面 DOM 媒体元素的「路径键」（2026-09-28 第十轮）', () => {
  const VIDEO_HASH = 'o80CsgIeQIIkw4QQpb0EDtEouMF74KDAhw41ul';
  const IMAGE_HASH = '7bf8db54a7ec4040ba073c804e45b121';

  it('视频：报文候选地址与页面 <video src> 落在同一个 hash 上', () => {
    const fromPayload = `https://v26-vdl.doubao.com/abc123/video/tos/cn/tos-cn-v-9ecd54/${VIDEO_HASH}/?a=482431&lr=video_gen_watermark_dyn`;
    const fromDom = `https://v3-vdl.doubao.com/xyz/video/tos/cn/tos-cn-v-9ecd54/${VIDEO_HASH}/?sign=1`;
    expect(mediaPathKey(fromPayload)).toBe(VIDEO_HASH);
    expect(mediaPathKey(fromDom)).toBe(VIDEO_HASH);
  });

  it('图片：原片 URL（~tplv-…-image_raw）与页面水印缩略图（.jpg~tplv-…-image）同键', () => {
    const oriRaw = `https://p6-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/${IMAGE_HASH}.jpeg~tplv-a9rns2rl98-image_raw.png`;
    const domThumb = `https://p11-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/${IMAGE_HASH}.jpg~tplv-a9rns2rl98-image.png?x-expires=1&x-signature=a`;
    expect(mediaPathKey(oriRaw)).toBe(IMAGE_HASH);
    expect(mediaPathKey(domThumb)).toBe(IMAGE_HASH);
  });

  it('转义引号 / 结尾反斜杠 / 查询串都不影响取键', () => {
    expect(mediaPathKey(`https://x.com/a/video/${VIDEO_HASH}/\\\\`)).toBe(VIDEO_HASH);
    expect(mediaPathKey(`https://x.com/a/b/${IMAGE_HASH}.jpeg?x=1`)).toBe(IMAGE_HASH);
  });

  it('短路径段 / 空值 / 非 URL 一律返回 null（宁缺勿假，不用短段乱匹配）', () => {
    expect(mediaPathKey('')).toBeNull();
    expect(mediaPathKey('https://x.com/abc.jpg')).toBeNull(); // 只有 3 个字符
    expect(mediaPathKey('https://www.doubao.com/chat/123')).toBeNull(); // 路径段太短
  });
});

describe('DNR 规则生成（构建期）', () => {
  const rules = buildDnrRules();

  it('id 连续且唯一', () => {
    const ids = rules.map((rule) => rule.id);
    expect(ids).toEqual(Array.from({ length: rules.length }, (_, i) => i + 1));
  });

  it('只保留「注入类」规则：没有任何 redirect（改写类规则会打废站点的签名 URL）', () => {
    const types = rules.map((rule) => rule.action.type);
    // 2026-09-28 第十轮：改写过图片后缀/lr/logo_type 的 7 条规则已整体移除 ——
    // 实测它们把 `…~tplv-…-video_dsz_watermark_1_6.png` 重定向成 `…video_cover.jpeg`，
    // 而该域带签名，路径一改就 403（docs/03 §17.11）。这里守住「不许再加回改写规则」。
    expect(types).not.toContain('redirect');
    expect(types).toContain('modifyHeaders');

    const all = JSON.stringify(rules);
    expect(all).not.toContain('~tplv-a9rns2rl98-image-qvalue.jpeg');
    expect(all).not.toContain('video_gen_no_watermark');
    expect(all).toContain('Access-Control-Allow-Origin');
    expect(all).toContain('https://www.doubao.com/');
    expect(all).toContain('douyinvod.com');
  });

  it('每条规则都有 condition 与优先级，避免规则被 Chrome 拒绝', () => {
    for (const rule of rules) {
      expect(rule.condition).toBeTruthy();
      expect(rule.priority).toBeGreaterThan(0);
    }
  });

  it('封面 / 缩略图域也有 Referer 注入（否则弹窗里的封面图会被防盗链挡成 403）', () => {
    const coverRules = rules.filter((rule) => {
      const types = (rule.condition?.resourceTypes ?? []) as unknown as string[];
      return types.includes('image') && JSON.stringify(rule.action).includes('Referer');
    });
    const filters = coverRules.map((rule) => String(rule.condition?.urlFilter ?? ''));
    expect(filters).toContain('||douyinpic.com/');
    expect(filters).toContain('||byteimg.com/');
    // 只加 Referer / Origin，不加 CORS 响应头（`<img>` 不需要跨域读取）
    expect(JSON.stringify(coverRules)).not.toContain('Access-Control-Allow-Origin');
  });

  it('封面域的 Referer 也覆盖 xmlhttprequest —— bg 侧「实测文件字节数」要用（2026-09-28）', () => {
    // 体积兜底是在 background 里对图片原片 URL 发 `Range: bytes=0-0` 读 Content-Range；
    // 那是一次 xhr 类请求，若这些域只对 `image` 注入 Referer，就会被防盗链挡成 403。
    const byteimg = rules.find((rule) => String(rule.condition?.urlFilter) === '||byteimg.com/');
    const types = (byteimg?.condition?.resourceTypes ?? []) as unknown as string[];
    expect(types).toContain('image');
    expect(types).toContain('xmlhttprequest');
  });
});
