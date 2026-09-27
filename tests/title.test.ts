import { describe, expect, it } from 'vitest';

import {
  cleanDocTitle,
  isGenericDocTitle,
  isStaleTitle,
  normalizeTitleSnapshot,
  pickFreshTitle,
} from '../src/core/title';

describe('cleanDocTitle：清洗 document.title', () => {
  it('去掉站点后缀', () => {
    expect(cleanDocTitle('0924_古装战争史诗视频生成 - 豆包')).toBe('0924_古装战争史诗视频生成');
    expect(cleanDocTitle('海底城市夜景 | Doubao')).toBe('海底城市夜景');
    expect(cleanDocTitle('海底城市夜景 · dola')).toBe('海底城市夜景');
  });

  it('纯品牌名视为「没有标题」', () => {
    expect(cleanDocTitle('豆包')).toBe('');
    expect(cleanDocTitle('Doubao')).toBe('');
    expect(cleanDocTitle('   ')).toBe('');
    expect(cleanDocTitle('')).toBe('');
  });

  it('站点**通用标题**视为「没有标题」（第四轮实测值）', () => {
    // 实测：F5 时 document.title 是空的 → 快照为空、闸门失效，
    // 稍后它变成通用标题，于是被当成会话名锁定（docs/03 §9.9）
    expect(cleanDocTitle('豆包 - 字节跳动旗下 AI 智能助手')).toBe('');
    expect(cleanDocTitle('豆包 · 你的 AI 智能助手')).toBe('');
    expect(cleanDocTitle('豆包 - 你的 AI 智能助手')).toBe('');
    expect(cleanDocTitle('AI 智能助手')).toBe('');
    expect(isGenericDocTitle('豆包 - 字节跳动旗下 AI 智能助手')).toBe(true);
    expect(isGenericDocTitle('海底城市夜景')).toBe(false);
  });

  it('不误伤正文（只剥结尾的品牌段）', () => {
    expect(cleanDocTitle('豆包对话记录整理')).toBe('豆包对话记录整理');
    expect(cleanDocTitle('豆包 - 帮我写一份周报')).toBe('豆包 - 帮我写一份周报');
  });
});

describe('normalizeTitleSnapshot：快照归一化', () => {
  it('去空、去重、保序', () => {
    expect(normalizeTitleSnapshot(['  A  ', '', 'B', 'A', '   '])).toEqual(['A', 'B']);
  });
});

describe('pickFreshTitle：快照闸门（第四轮 v2 的核心）', () => {
  const STALE = ['0924_古装战争史诗视频生成', '豆包'];

  it('拒绝路由切换前就读到的候选（=上一个会话的标题）', () => {
    // 切换后 document.title 还没更新，仍读到旧标题 → 不能采用
    expect(pickFreshTitle(['0924_古装战争史诗视频生成'], STALE)).toBe('');
  });

  it('站点更新标题后即可采用（候选已不在快照里）', () => {
    expect(pickFreshTitle(['0925_AI视频提示词运镜分析与修改'], STALE)).toBe('0925_AI视频提示词运镜分析与修改');
  });

  it('按优先级取第一个「新鲜」的候选（标题元素优先于 document.title）', () => {
    expect(pickFreshTitle(['', '海底城市夜景'], STALE)).toBe('海底城市夜景');
    // 第一项仍是旧值 → 跳过，取第二项
    expect(pickFreshTitle(['0924_古装战争史诗视频生成', '机械蜂鸟特写'], STALE)).toBe('机械蜂鸟特写');
  });

  it('全被拒时不返回兜底值（兜底由界面层负责）', () => {
    expect(pickFreshTitle([], STALE)).toBe('');
    expect(pickFreshTitle(['0924_古装战争史诗视频生成', '豆包'], STALE)).toBe('');
  });

  it('快照为空时不拦（例如首次加载、无从对比）', () => {
    expect(pickFreshTitle(['海底城市夜景'], [])).toBe('海底城市夜景');
  });

  it('isStaleTitle 把空值也算作不可用', () => {
    expect(isStaleTitle('', [])).toBe(true);
    expect(isStaleTitle('  ', [])).toBe(true);
    expect(isStaleTitle('海底城市夜景', [])).toBe(false);
    expect(isStaleTitle('豆包', STALE)).toBe(true);
  });
});

describe('回归：实机「切对话后显示上一个对话标题」场景', () => {
  /** 模拟：从「0924」切到「0925」，站点还没更新标题 */
  function switchConversation(): { snapshot: string[]; readNow: () => string } {
    // 切换瞬间能读到的：标题元素 + document.title，都还是 0924
    const snapshot = normalizeTitleSnapshot(['0924_古装战争史诗视频生成', '0924_古装战争史诗视频生成 - 豆包'].map(cleanDocTitle));
    let docTitle = '0924_古装战争史诗视频生成 - 豆包';
    return {
      snapshot,
      readNow: () => pickFreshTitle([cleanDocTitle(docTitle)], snapshot),
    };
  }

  it('切换瞬间不采用旧标题；站点更新后才采用', () => {
    const { snapshot, readNow } = switchConversation();
    expect(snapshot).toEqual(['0924_古装战争史诗视频生成']);
    // 站点还没渲染完 → 拒收（宁可空，也不显示上一个对话的标题）
    expect(readNow()).toBe('');
    // 站点更新 → 采用
    expect(readNow()).not.toBe('0925_AI视频提示词运镜分析与修改');
    const after = pickFreshTitle([cleanDocTitle('0925_AI视频提示词运镜分析与修改 - 豆包')], snapshot);
    expect(after).toBe('0925_AI视频提示词运镜分析与修改');
  });
});
