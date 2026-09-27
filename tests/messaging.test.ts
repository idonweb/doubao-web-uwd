import { describe, expect, it } from 'vitest';

import { ENVELOPE_VERSION, envelope, isEnvelope, payloadOf } from '../src/core/messaging';
import { MSG } from '../src/core/constants';

describe('消息信封', () => {
  it('信封形状固定为 { v, src, type, payload }', () => {
    expect(envelope('ui', MSG.StateGet)).toEqual({ v: 1, src: 'ui', type: 'state:get' });
    expect(envelope('content', MSG.MediaAppend, [{ a: 1 }])).toEqual({
      v: 1,
      src: 'content',
      type: 'media:append',
      payload: [{ a: 1 }],
    });
  });

  it('payload 为 undefined 时不写入该字段', () => {
    expect(Object.keys(envelope('bg', 'x'))).toEqual(['v', 'src', 'type']);
  });

  it('isEnvelope 接受合法信封', () => {
    expect(isEnvelope(envelope('page', MSG.MediaCaptured, []))).toBe(true);
    expect(ENVELOPE_VERSION).toBe(1);
  });

  it('isEnvelope 拒绝非法输入（防止误吞页面上其它脚本的 postMessage）', () => {
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope('state:get')).toBe(false);
    expect(isEnvelope({ type: 'x' })).toBe(false);
    expect(isEnvelope({ v: 2, src: 'ui', type: 'x' })).toBe(false);
    expect(isEnvelope({ v: 1, src: 'unknown', type: 'x' })).toBe(false);
    expect(isEnvelope({ v: 1, src: 'ui' })).toBe(false);
    expect(isEnvelope({ v: 1, src: 'ui', type: '' })).toBe(false);
  });

  it('payloadOf 安全取值', () => {
    expect(payloadOf<number[]>(envelope('bg', MSG.DownloadProgress, [1, 2]))).toEqual([1, 2]);
    expect(payloadOf(envelope('bg', 'x'))).toBeUndefined();
  });

  it('所有消息类型都带命名空间，便于排查（上游 set-enabled / toggle-enabled 不一致的教训）', () => {
    for (const type of Object.values(MSG)) {
      expect(typeof type).toBe('string');
      expect(type.length).toBeGreaterThan(2);
    }
    // 消息类型集合内不得重复
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });
});
