import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, LIMITS, SCHEMA_VERSION, STORAGE } from '../src/core/constants';
import { normalizeConfig, normalizeLibrary, normalizeSchemaVersion } from '../src/core/storage';
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

describe('schema 版本归一化', () => {
  it('非法值回落到当前版本', () => {
    expect(normalizeSchemaVersion(undefined)).toBe(SCHEMA_VERSION);
    expect(normalizeSchemaVersion('1')).toBe(SCHEMA_VERSION);
    expect(normalizeSchemaVersion(0)).toBe(SCHEMA_VERSION);
    expect(normalizeSchemaVersion(3)).toBe(3);
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
