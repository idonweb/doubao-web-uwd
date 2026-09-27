import { describe, expect, it } from 'vitest';

import { qualityFromDims } from '../src/core/quality';

describe('qualityFromDims：原片真实宽高 → 清晰度标签', () => {
  it('横版与竖版按短边归到同一档', () => {
    expect(qualityFromDims(1280, 720)).toBe('720P');
    expect(qualityFromDims(720, 1280)).toBe('720P');
    expect(qualityFromDims(1920, 1080)).toBe('1080P');
  });

  it('非已知档位不给标签（宁缺勿假，界面只显示「无水印原片」）', () => {
    expect(qualityFromDims(1024, 576)).toBeUndefined();
    expect(qualityFromDims(1080, 720)).toBe('720P'); // 短边命中即可
    expect(qualityFromDims(1088, 612)).toBeUndefined();
  });

  it('尺寸缺失或非法一律不给标签（链路上宽高常常是 undefined）', () => {
    expect(qualityFromDims(undefined, undefined)).toBeUndefined();
    expect(qualityFromDims(1280, undefined)).toBeUndefined();
    expect(qualityFromDims(undefined, 720)).toBeUndefined();
    expect(qualityFromDims(0, 720)).toBeUndefined();
    expect(qualityFromDims(-1280, 720)).toBeUndefined();
  });
});
