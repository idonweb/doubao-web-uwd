import { describe, expect, it } from 'vitest';

import {
  FPLAY_CODEC_HEAVY,
  FPLAY_CODEC_LIGHT,
  FPLAY_FORCE_FIDS_ORIGINAL,
} from '../src/core/site-contract';
import { buildFplayUrl, decodeQaabToken, isFplayUrl, pickFplayUrl, readFplayKeySeed, readFplayTokens } from '../src/core/fplay';
import {
  SHARE_FPLAY_EXPECTED_URL,
  SHARE_FPLAY_FALLBACK_API,
  SHARE_FPLAY_KEY_SEED,
  SHARE_FPLAY_TOKEN,
} from './fixtures/share-fplay';

describe('isFplayUrl（只认受信的 fplay 地址）', () => {
  it('接受真实的 fallback_api', () => {
    expect(isFplayUrl(SHARE_FPLAY_FALLBACK_API)).toBe(true);
  });

  it('拒绝 http / 陌生域 / 非 fplay 路径 / 非字符串', () => {
    expect(isFplayUrl(SHARE_FPLAY_FALLBACK_API.replace('https://', 'http://'))).toBe(false);
    expect(isFplayUrl('https://evil.example.com/video/fplay/1/x/y')).toBe(false);
    expect(isFplayUrl('https://vas-lf-x.snssdk.com/other/path')).toBe(false);
    expect(isFplayUrl('https://notsnssdk.com/video/fplay/1/x/y')).toBe(false);
    expect(isFplayUrl('')).toBe(false);
    expect(isFplayUrl(undefined)).toBe(false);
    expect(isFplayUrl(123)).toBe(false);
  });

  it('接受子域（实测就是 vas-lf-x.snssdk.com 这种）', () => {
    expect(isFplayUrl('https://vas-lf-x.snssdk.com/video/fplay/1/abc/vid123')).toBe(true);
  });
});

describe('buildFplayUrl（档位开关）', () => {
  const light = buildFplayUrl(SHARE_FPLAY_FALLBACK_API, 'light');
  const heavy = buildFplayUrl(SHARE_FPLAY_FALLBACK_API, 'heavy');

  it('轻量档：codec_type=1', () => {
    expect(light).not.toBeNull();
    expect(new URL(light!).searchParams.get('codec_type')).toBe(FPLAY_CODEC_LIGHT);
  });

  it('高画质档：codec_type=5 + force_fids=base64("original")', () => {
    expect(heavy).not.toBeNull();
    const q = new URL(heavy!).searchParams;
    expect(q.get('codec_type')).toBe(FPLAY_CODEC_HEAVY);
    expect(q.get('force_fids')).toBe(FPLAY_FORCE_FIDS_ORIGINAL);
  });

  it('两档都必须先删掉 logo_type / force_fids（留着会把档位钉回默认档）', () => {
    expect(new URL(SHARE_FPLAY_FALLBACK_API).searchParams.get('logo_type')).toBe('video_gen_watermark_dyn');
    expect(new URL(light!).searchParams.has('logo_type')).toBe(false);
    expect(new URL(heavy!).searchParams.has('logo_type')).toBe(false);
    // 轻量档**不能**继承原来的 force_fids
    expect(new URL(light!).searchParams.has('force_fids')).toBe(false);
  });

  it('其余参数（key_seed / hash / vid）原样保留', () => {
    const before = new URL(SHARE_FPLAY_FALLBACK_API);
    const after = new URL(light!);
    expect(after.searchParams.get('key_seed')).toBe(before.searchParams.get('key_seed'));
    expect(after.pathname).toBe(before.pathname);
  });

  it('非法输入 → null', () => {
    expect(buildFplayUrl('https://evil.example.com/video/fplay/1/a/b', 'light')).toBeNull();
    expect(buildFplayUrl(undefined, 'light')).toBeNull();
  });
});

describe('readFplayKeySeed / readFplayTokens（响应解析）', () => {
  const payload = {
    video_info: {
      data: {
        key_seed: 'SEED==',
        video_list: {
          '0': { main_url: 'TOK-A', backup_url_1: 'TOK-B', other: 'X' },
        },
      },
    },
    message: '',
    code: 0,
  };

  it('取 key_seed', () => {
    expect(readFplayKeySeed(payload)).toBe('SEED==');
    expect(readFplayKeySeed({})).toBe('');
  });

  it('取 token：main_url 在前、backup_url_1 在后，其它字段不取', () => {
    expect(readFplayTokens(payload)).toEqual(['TOK-A', 'TOK-B']);
    expect(readFplayTokens(payload)).not.toContain('X');
  });

  it('video_list 是**数组**时同样能吃', () => {
    expect(readFplayTokens({ video_info: { data: { video_list: [{ main_url: 'T1' }] } } })).toEqual(['T1']);
  });

  it('空响应 → 空数组（不抛错）', () => {
    expect(readFplayTokens({})).toEqual([]);
    expect(readFplayTokens(null)).toEqual([]);
    expect(readFplayTokens(undefined)).toEqual([]);
  });

  it('去重', () => {
    expect(readFplayTokens({ video_info: { data: { video_list: [{ main_url: 'T', backup_url_1: 'T' }] } } })).toEqual(['T']);
  });
});

describe('decodeQaabToken（用**真实响应样本**钉住 KDF / 切片 / 填充）', () => {
  it('🔒 真实 token 解出的直链与实测逐字符一致', async () => {
    const url = await decodeQaabToken(SHARE_FPLAY_TOKEN, SHARE_FPLAY_KEY_SEED);
    expect(url).toBe(SHARE_FPLAY_EXPECTED_URL);
  });

  it('解出的确实是可下载的明文地址', async () => {
    const url = await decodeQaabToken(SHARE_FPLAY_TOKEN, SHARE_FPLAY_KEY_SEED);
    expect(url.startsWith('https://')).toBe(true);
    expect(url).toContain('/video/tos/cn/tos-cn-v-9ecd54/');
  });

  it('key_seed 换成别的值 → 解不出（宁缺勿假，返回空串）', async () => {
    expect(await decodeQaabToken(SHARE_FPLAY_TOKEN, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe('');
  });

  it('token / seed 为空或非 base64 → 空串', async () => {
    expect(await decodeQaabToken('', SHARE_FPLAY_KEY_SEED)).toBe('');
    expect(await decodeQaabToken(SHARE_FPLAY_TOKEN, '')).toBe('');
    expect(await decodeQaabToken('not-base64-!!!', SHARE_FPLAY_KEY_SEED)).toBe('');
  });

  it('长度不是 16 倍数 → 空串（不硬解）', async () => {
    expect(await decodeQaabToken('qAABAAAA', SHARE_FPLAY_KEY_SEED)).toBe('');
  });
});

describe('pickFplayUrl（端到端：响应 → 直链）', () => {
  const payload = {
    video_info: { data: { key_seed: SHARE_FPLAY_KEY_SEED, video_list: [{ main_url: SHARE_FPLAY_TOKEN }] } },
  };

  it('从真实形状的响应里直接得到直链', async () => {
    expect(await pickFplayUrl(payload)).toBe(SHARE_FPLAY_EXPECTED_URL);
  });

  it('第一个 token 解不出时改用第二个', async () => {
    const two = {
      video_info: { data: { key_seed: SHARE_FPLAY_KEY_SEED, video_list: [{ main_url: 'AAAA' }, { main_url: SHARE_FPLAY_TOKEN }] } },
    };
    expect(await pickFplayUrl(two)).toBe(SHARE_FPLAY_EXPECTED_URL);
  });

  it('没有 key_seed / 没有 token → 空串', async () => {
    expect(await pickFplayUrl({ video_info: { data: { video_list: [{ main_url: 'T' }] } } })).toBe('');
    expect(await pickFplayUrl({ video_info: { data: { key_seed: SHARE_FPLAY_KEY_SEED } } })).toBe('');
  });
});
