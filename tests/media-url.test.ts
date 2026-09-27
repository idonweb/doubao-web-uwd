import { describe, expect, it } from 'vitest';

import {
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

describe('DNR 规则生成（构建期）', () => {
  const rules = buildDnrRules();

  it('id 连续且唯一', () => {
    const ids = rules.map((rule) => rule.id);
    expect(ids).toEqual(Array.from({ length: rules.length }, (_, i) => i + 1));
  });

  it('覆盖图片后缀 / logo_type / lr / CORS / Referer 五类', () => {
    const types = rules.map((rule) => rule.action.type);
    expect(types.filter((type) => type === 'redirect').length).toBeGreaterThanOrEqual(7);
    expect(types).toContain('modifyHeaders');

    const all = JSON.stringify(rules);
    expect(all).toContain('~tplv-a9rns2rl98-image-qvalue.jpeg');
    expect(all).toContain('logo_type');
    expect(all).toContain('video_gen_no_watermark');
    expect(all).toContain('Access-Control-Allow-Origin');
    expect(all).toContain('https://www.doubao.com/');
    expect(all).toContain('douyinvod.com');
  });

  it('每条 redirect 规则都有 condition，避免规则被 Chrome 拒绝', () => {
    for (const rule of rules) {
      expect(rule.condition).toBeTruthy();
      expect(rule.priority).toBeGreaterThan(0);
    }
  });
});
