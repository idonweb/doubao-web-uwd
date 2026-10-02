import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, LIMITS, SCHEMA_VERSION, STORAGE } from '../src/core/constants';
import {
  dropStaleImageSizes,
  normalizeConfig,
  normalizeLibrary,
  normalizeLibrarySlots,
  normalizeSchemaVersion,
  slotsFromLegacyLibrary,
  type Library,
} from '../src/core/storage';
import { LEGACY_STORAGE_KEYS } from '../src/core/site-contract';

describe('配置归一化（纯函数）', () => {
  it('空值 / 脏值回落到默认配置', () => {
    expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig('on')).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig({ skipThumbOnly: 1, theme: 'blue' })).toEqual(DEFAULT_CONFIG);
  });

  it('合法值被保留', () => {
    expect(normalizeConfig({ skipThumbOnly: false, theme: 'dark' })).toEqual({
      skipThumbOnly: false,
      theme: 'dark',
    });
  });

  it('缺失字段用默认值补齐（向前兼容）', () => {
    expect(normalizeConfig({ theme: 'light' })).toEqual({
      skipThumbOnly: DEFAULT_CONFIG.skipThumbOnly,
      theme: 'light',
    });
  });

  it('历史键一律忽略且不继承（replacePreview / showImageDownloadButton）', () => {
    // 2026-09-26：replacePreview（第三轮 K4）与 showImageDownloadButton（第四轮收尾）
    // 都已整体删除，语义不复存在 —— 读到旧存储时直接丢弃，且不得让新字段变成 undefined。
    const migrated = normalizeConfig({
      replacePreview: false,
      showImageDownloadButton: false,
      skipThumbOnly: false,
      theme: 'dark',
    });
    expect(migrated).toEqual({ skipThumbOnly: false, theme: 'dark' });
    expect('replacePreview' in migrated).toBe(false);
    expect('showImageDownloadButton' in migrated).toBe(false);
  });
});

describe('资源库归一化（纯函数）', () => {
  const validItem = {
    id: 'c::f',
    convId: 'c',
    convKind: 'chat',
    convTitle: 't',
    fingerprint: 'f',
    kind: 'video',
    state: 'raw',
    variants: [],
    primary: 'https://a.com/x.mp4',
    cover: null,
    meta: { ext: 'mp4' },
    firstSeen: 1,
    lastSeen: 2,
  };

  it('丢弃形状不完整的条目', () => {
    expect(normalizeLibrary(undefined)).toEqual({});
    expect(normalizeLibrary({ a: null, b: {}, c: { id: 'x' } })).toEqual({});
    expect(normalizeLibrary({ ok: validItem })).toEqual({ ok: validItem });
  });

  it('kind 取值必须合法', () => {
    expect(normalizeLibrary({ bad: { ...validItem, kind: 'audio' } })).toEqual({});
  });
});

/**
 * 分槽资源库（2026-10-02 §38 多标签页修复）。
 *
 * 背景：库从「全局单槽」改为「`tabId → 槽`」—— 否则三个豆包标签页来回切会互相删库
 * （诊断 `uwd-diag-1790925989845`：14 次作用域翻转、20 条草稿被丢、三边全空）。
 */
describe('normalizeLibrarySlots（分槽归一化，纯函数）', () => {
  const item = (convId: string, id = `${convId}::f`) => ({
    id,
    convId,
    convKind: 'chat',
    convTitle: 't',
    fingerprint: 'f',
    kind: 'video',
    state: 'raw',
    variants: [],
    primary: 'https://a.com/x.mp4',
    cover: null,
    meta: { ext: 'mp4' },
    firstSeen: 1,
    lastSeen: 2,
  });

  it('每个槽内部照旧过一遍条目校验，空槽直接丢掉', () => {
    const raw = {
      101: { [item('a').id]: item('a') },
      102: { broken: { id: 'x' } },
      103: {},
    };
    const slots = normalizeLibrarySlots(raw);
    expect(Object.keys(slots)).toEqual(['101']);
    expect(Object.keys(slots['101'])).toEqual(['a::f']);
  });

  it('非对象 / 脏值 → 空对象（不崩、不编造）', () => {
    expect(normalizeLibrarySlots(undefined)).toEqual({});
    expect(normalizeLibrarySlots(null)).toEqual({});
    expect(normalizeLibrarySlots('x')).toEqual({});
    expect(normalizeLibrarySlots([])).toEqual({});
  });
});

describe('slotsFromLegacyLibrary（v2→v3 迁移归位，纯函数）', () => {
  const item = (convId: string) => ({
    id: `${convId}::f`,
    convId,
    convKind: 'chat' as const,
    convTitle: 't',
    fingerprint: 'f',
    kind: 'video' as const,
    state: 'raw' as const,
    variants: [],
    primary: 'https://a.com/x.mp4',
    cover: null,
    meta: { ext: 'mp4' },
    firstSeen: 1,
    lastSeen: 2,
  });

  it('★按「仍开着的标签页 URL」把旧条目归位到对应槽', () => {
    const legacy = { '3844::f': item('3844'), 'xkmLJCEtfJndqzlD4::f': item('xkmLJCEtfJndqzlD4') };
    const slots = slotsFromLegacyLibrary(legacy, [
      { tabId: 79567325, url: 'https://www.doubao.com/chat/3844?channel=itab2' },
      { tabId: 79567328, url: 'https://www.doubao.com/thread/xkmLJCEtfJndqzlD4' },
    ]);
    expect(Object.keys(slots).sort()).toEqual(['79567325', '79567328']);
    expect(Object.keys(slots['79567325'])).toEqual(['3844::f']);
    expect(Object.keys(slots['79567328'])).toEqual(['xkmLJCEtfJndqzlD4::f']);
  });

  it('★分享页也能归位（会话键来自查询参数 `share_<share_id>`）', () => {
    const legacy = { 'share_5713::vid:v0': item('share_5713') };
    const slots = slotsFromLegacyLibrary(legacy, [
      { tabId: 79567283, url: 'https://www.doubao.com/video-sharing?share_id=5713&video_id=v0' },
    ]);
    expect(Object.keys(slots['79567283'])).toEqual(['share_5713::vid:v0']);
  });

  it('没有标签页承载的条目 → 丢弃（会由页面重新解析恢复；分享页需 F5）', () => {
    const slots = slotsFromLegacyLibrary({ 'gone::f': item('gone') }, [
      { tabId: 1, url: 'https://www.doubao.com/chat/3844' },
    ]);
    expect(slots).toEqual({});
  });

  it('同一会话开在两个标签页 → 只归给第一个（避免迁移期重复）', () => {
    const slots = slotsFromLegacyLibrary({ '3844::f': item('3844') }, [
      { tabId: 11, url: 'https://www.doubao.com/chat/3844' },
      { tabId: 22, url: 'https://www.doubao.com/chat/3844' },
    ]);
    expect(Object.keys(slots)).toEqual(['11']);
  });

  it('非会话页（首页）不承载任何槽', () => {
    expect(slotsFromLegacyLibrary({ '3844::f': item('3844') }, [{ tabId: 9, url: 'https://www.doubao.com/chat' }])).toEqual(
      {},
    );
  });
});

describe('schema 版本归一化', () => {
  it('非法值回落到当前版本', () => {
    expect(normalizeSchemaVersion(undefined)).toBe(SCHEMA_VERSION);
    expect(normalizeSchemaVersion('1')).toBe(SCHEMA_VERSION);
    expect(normalizeSchemaVersion(0)).toBe(SCHEMA_VERSION);
    expect(normalizeSchemaVersion(3)).toBe(3);
  });
});

/**
 * schema v1 → v2 的一次性清理（2026-09-28）：图片旧体积不可信，必须丢掉重测。
 * 实机反例：卡片 378 KB ↔ 实际下载 3.81 MB 的 PNG。
 */
describe('dropStaleImageSizes（v1→v2 迁移，纯函数）', () => {
  const item = (kind: 'video' | 'image', size?: number) => ({
    id: `c::${kind}`,
    convId: 'c',
    convKind: 'chat' as const,
    convTitle: 't',
    fingerprint: kind,
    kind,
    state: 'raw' as const,
    variants: [],
    primary: 'https://a.com/x',
    cover: null,
    meta: size === undefined ? { ext: 'png' } : { ext: 'png', size },
    firstSeen: 1,
    lastSeen: 2,
  });

  it('图片条目的 size 被清掉，其它字段与视频条目原样保留', () => {
    const library = {
      'c::image': item('image', 378_043),
      'c::video': item('video', 8_698_069),
      'c::image2': item('image'),
    } as unknown as Library;
    const { library: next, changed } = dropStaleImageSizes(library);
    expect(changed).toBe(true);
    expect(next['c::image'].meta.size).toBeUndefined();
    expect(next['c::video'].meta.size).toBe(8_698_069); // 视频的树 size 已验证，不动
    expect(next['c::image2'].meta).toEqual({ ext: 'png' });
    // 不原地改传入对象
    expect(library['c::image'].meta.size).toBe(378_043);
  });

  it('没有图片体积时 changed=false（幂等，不产生无谓写入）', () => {
    const library = { 'c::video': item('video', 1_000) } as unknown as Library;
    expect(dropStaleImageSizes(library).changed).toBe(false);
    expect(dropStaleImageSizes({} as Library).changed).toBe(false);
  });
});

describe('常量约束（施工守则的可执行断言）', () => {
  it('存储键全部带 uwd: 前缀，与上游命名彻底隔离', () => {
    for (const key of Object.values(STORAGE)) {
      expect(key.startsWith('uwd:')).toBe(true);
    }
    // 也不允许与上游遗留键重名
    for (const legacy of LEGACY_STORAGE_KEYS) {
      expect(Object.values(STORAGE)).not.toContain(legacy);
    }
  });

  it('资源库上限 99、下载单并发', () => {
    expect(LIMITS.LIBRARY_MAX).toBe(99);
    expect(LIMITS.DOWNLOAD_CONCURRENCY).toBe(1);
  });

  it('上游遗留键清单与 SESSION_CONTEXT 记录一致（安装时清理，不迁移）', () => {
    expect([...LEGACY_STORAGE_KEYS]).toEqual([
      'doubao-seedance-enhancer_enabled',
      'doubao-seedance-enhancer_duration',
      'seedance_extracted_urls',
    ]);
  });
});
