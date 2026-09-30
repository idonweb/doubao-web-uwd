import { describe, expect, it } from 'vitest';

import { modelBadgeOf, pickModelHintAt } from '../src/core/model-badge';

/**
 * 模型药丸文案派生（2026-09-30 第十五轮 §35；**§35.11 起以站点文案为主来源**）。
 *
 * 三条实测证据链（`docs/03` §35.8 / §35.10 / §35.11）：
 *   · **站点文案**「本次使用 **Seedance 2.0 Mini** 生成」—— 最可信，站点自报档位；
 *   · `model`（用户选的）—— 带 `_std` / `_mini` 后缀可用，**裸 `seedance_v2.0` 有歧义**；
 *   · `tool`（req_key）—— **不参与**：实测 `seedance_v20_fast_flow` 同时用于 Fast 与 Mini。
 * 其余锁定「认不出就不给结论」这条宁缺勿假原则。
 */
describe('modelBadgeOf：站点文案（最可信的来源）', () => {
  it('四种档位全覆盖（用户截图里的全部模型）', () => {
    expect(modelBadgeOf({ label: 'Seedance 2.5' })?.short).toBe('SD-2.5');
    expect(modelBadgeOf({ label: 'Seedance 2.0' })?.short).toBe('SD-2.0');
    expect(modelBadgeOf({ label: 'Seedance 2.0 Fast' })?.short).toBe('2.0-Fast');
    expect(modelBadgeOf({ label: 'Seedance 2.0 Mini' })?.short).toBe('2.0-Mini');
  });

  it('大小写 / 多余空白 / `v` 前缀都容忍', () => {
    expect(modelBadgeOf({ label: 'seedance 2.0 fast' })?.short).toBe('2.0-Fast');
    expect(modelBadgeOf({ label: '  Seedance   2.0   Mini  ' })?.short).toBe('2.0-Mini');
    expect(modelBadgeOf({ label: 'Seedance v2.0 Fast' })?.short).toBe('2.0-Fast');
  });

  it('老版文案的语义双标：「Seedance 2.0 全能视频模型」= **2.0 Fast**（§35.13 用户实测）', () => {
    // 实测原文：本次使用 Seedance 2.0 全能视频模型 生成，将消耗 2 个视频生成额度，预计等待 5 分钟。
    // 用户确认：它**不是**标准版；不认这条就会把 Fast 标成 SD-2.0（实机报错）
    expect(modelBadgeOf({ label: 'Seedance 2.0 全能视频模型' })?.short).toBe('2.0-Fast');
    expect(modelBadgeOf({ label: 'Seedance 2.0 全能' })?.short).toBe('2.0-Fast'); // 简写也认
    // 而**纯**「Seedance 2.0」仍是标准版（0929#动作戏练手 21:35 那条实测如此）
    expect(modelBadgeOf({ label: 'Seedance 2.0' })?.short).toBe('SD-2.0');
  });

  it('悬停用的完整名与站点文案口径一致', () => {
    expect(modelBadgeOf({ label: 'Seedance 2.0 Mini' })?.full).toBe('Seedance 2.0 Mini');
    expect(modelBadgeOf({ label: 'Seedance 2.5' })?.full).toBe('Seedance 2.5');
  });

  it('文案报了档位但不在白名单（站点将来加的新档位）→ 不猜，也不退回 model', () => {
    // 若退回 model，可能给出一个与文案矛盾的标准版结论 —— 宁可没有药丸
    expect(modelBadgeOf({ label: 'Seedance 3.0 Pro', model: 'seedance_v3.0_std' })).toBeUndefined();
  });

  it('文案形态不认识时，才落到 model', () => {
    expect(modelBadgeOf({ label: '某种新说法', model: 'seedance_v2.0_mini' })?.short).toBe('2.0-Mini');
  });
});

describe('modelBadgeOf：model 字段（带明确后缀才可用）', () => {
  it('`_std` = 标准版、`_mini` = Mini（都有实测样本）', () => {
    expect(modelBadgeOf({ model: 'seedance_v2.0_std' })?.short).toBe('SD-2.0');
    expect(modelBadgeOf({ model: 'seedance_v2.0_mini' })?.short).toBe('2.0-Mini');
  });

  it('裸 `seedance_v2.0` 有歧义（标准版 / Fast / Mini 都用它）→ 不给结论', () => {
    expect(modelBadgeOf({ model: 'seedance_v2.0' })).toBeUndefined();
  });

  it('站点未提供变体的版本（2.5）可安全使用', () => {
    expect(modelBadgeOf({ model: 'seedance_v2.5' })?.short).toBe('SD-2.5');
  });

  it('白名单外的后缀不给（宁缺勿假），原型链成员同样不行', () => {
    expect(modelBadgeOf({ model: 'seedance_v2.0_pro' })).toBeUndefined();
    expect(modelBadgeOf({ model: 'seedance_v2.0_constructor' })).toBeUndefined();
    expect(modelBadgeOf({ model: 'seedance_v9.9' })).toBeUndefined();
  });
});

describe('modelBadgeOf：tool 不参与档位判定（§35.11 实测证伪）', () => {
  it('只有 tool 时不给药丸（连版本也不取 —— 免得把 Mini 标成标准版）', () => {
    expect(modelBadgeOf({ tool: 'seedance_v20_fast_flow' })).toBeUndefined();
    expect(modelBadgeOf({ tool: 'seedance_v25_flow' })).toBeUndefined();
  });

  it('实测反例：Mini 档位跑的也是 fast_flow —— 文案才是准的', () => {
    // `uwd-diag-1790734985577`：0704#mini实验 12 条视频全是 Seedance 2.0 Mini，
    // 报文里的 tool 却是 `seedance_v20_fast_flow`（据此显示 2.0-Fast 正是用户报的那个错）
    const realWorld = { label: 'Seedance 2.0 Mini', model: 'seedance_v2.0', tool: 'seedance_v20_fast_flow' };
    expect(modelBadgeOf(realWorld)?.short).toBe('2.0-Mini');
  });

  it('图片流程名（seedream_*）同样绝不算作视频模型', () => {
    expect(modelBadgeOf({ tool: 'seedream_v50s_flow' })).toBeUndefined();
  });
});

describe('modelBadgeOf：读不到就什么都不给', () => {
  it('空对象 / null / undefined / 全空白', () => {
    expect(modelBadgeOf({})).toBeUndefined();
    expect(modelBadgeOf(null)).toBeUndefined();
    expect(modelBadgeOf(undefined)).toBeUndefined();
    expect(modelBadgeOf({ label: '  ', model: '', tool: '' })).toBeUndefined();
  });
});

/**
 * 按资源生成时刻**就近**取提示（2026-09-30 §35.10）—— 修「同一会话换过模型」串味。
 *
 * 实测场景：`0929#动作戏练手` 里 11:00 那条视频出自 `Seedance 2.0 Fast`、
 * 21:38 那条出自 `Seedance 2.0`。旧实现拿「最近一次提示」粘给所有条目 → 前者被标成 SD-2.0。
 */
describe('pickModelHintAt：模型提示时间线 → 某条资源适用的提示', () => {
  const timeline = [
    { at: 1_790_600_000, label: 'Seedance 2.0 Fast', model: 'seedance_v2.0', tool: 'seedance_v20_fast_flow' },
    { at: 1_790_640_000, label: 'Seedance 2.0', model: 'seedance_v2.0_std', tool: 'seedance_v20_fast_flow' },
  ];

  it('早的那条资源拿早的文案、晚的拿晚的（不再串味）', () => {
    expect(modelBadgeOf(pickModelHintAt(timeline, 1_790_600_100))?.short).toBe('2.0-Fast');
    expect(modelBadgeOf(pickModelHintAt(timeline, 1_790_640_100))?.short).toBe('SD-2.0');
  });

  it('资源没有生成时间时退到**最后一条**（旧的兜底行为）', () => {
    expect(modelBadgeOf(pickModelHintAt(timeline, null))?.short).toBe('SD-2.0');
    expect(modelBadgeOf(pickModelHintAt(timeline, undefined))?.short).toBe('SD-2.0');
  });

  it('时刻早于所有提示（异常）时**不给值** —— 严格对齐，不拿未来的提示标过去的资源', () => {
    expect(pickModelHintAt(timeline, 1)).toEqual({});
    expect(modelBadgeOf(pickModelHintAt(timeline, 1))).toBeUndefined();
  });

  it('插在两条提示之间的资源取前一条（时间对齐的边界）', () => {
    const events = [
      { at: 100, label: 'Seedance 2.5' },
      { at: 300, label: 'Seedance 2.0 Mini' },
    ];
    expect(modelBadgeOf(pickModelHintAt(events, 100))?.short).toBe('SD-2.5'); // 恰好等于
    expect(modelBadgeOf(pickModelHintAt(events, 299))?.short).toBe('SD-2.5'); // 差一秒
    expect(modelBadgeOf(pickModelHintAt(events, 300))?.short).toBe('2.0-Mini');
  });

  it('三个字段可能来自不同消息 —— 各自独立就近取', () => {
    const split = [
      { at: 100, model: 'seedance_v2.0' },
      { at: 200, label: 'Seedance 2.0 Mini', tool: 'seedance_v20_fast_flow' },
    ];
    expect(pickModelHintAt(split, 300)).toEqual({
      label: 'Seedance 2.0 Mini',
      model: 'seedance_v2.0',
      tool: 'seedance_v20_fast_flow',
    });
    // 资源在 150 秒那一刻：只有 model 那条已经出现 → label 还没有 → 此时确实给不出药丸
    expect(pickModelHintAt(split, 150)).toEqual({ model: 'seedance_v2.0' });
    expect(modelBadgeOf(pickModelHintAt(split, 150))).toBeUndefined();
  });

  it('空时间线 → 空对象（页面侧再退回跨批记忆兜底）', () => {
    expect(pickModelHintAt([], 123)).toEqual({});
    expect(pickModelHintAt([{ at: 1 }, { at: 2 }], 5)).toEqual({});
  });
});
