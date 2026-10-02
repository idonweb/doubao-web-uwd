import { describe, expect, it } from 'vitest';

import {
  REPEAT_SUPPRESS_EVENTS,
  clip,
  createRepeatSuppressor,
  describe as describeValue,
  isKeepEvent,
  makeRecord,
  pushBounded,
  sample,
} from '../src/core/diagnostics';
import type { DiagRecord } from '../src/core/diagnostics';

describe('clip 截断', () => {
  it('短文本原样返回', () => {
    expect(clip('abc')).toBe('abc');
    expect(clip('')).toBe('');
  });

  it('长文本保留头尾并标注省略长度', () => {
    const text = 'A'.repeat(500) + 'B'.repeat(500) + 'C'.repeat(500);
    const out = clip(text, 300);
    expect(out.startsWith('A')).toBe(true);
    expect(out.endsWith('C')).toBe(true);
    expect(out).toContain('中略');
    expect(out.length).toBeLessThan(text.length);
  });
});

describe('sample 采样', () => {
  it('命中关键字时以关键字为中心取窗口', () => {
    const text = 'x'.repeat(9000) + 'creation_block' + 'y'.repeat(9000);
    const out = sample(text, 'creation_block', 400);
    expect(out).toContain('creation_block');
    expect(out).toContain('围绕 "creation_block"');
    expect(out.length).toBeLessThan(700);
  });

  it('未命中关键字时退回头尾截断', () => {
    const text = 'z'.repeat(9000);
    const out = sample(text, 'creation_block', 400);
    expect(out).not.toContain('围绕');
    expect(out).toContain('中略');
  });

  it('短文本原样返回', () => {
    expect(sample('hello', 'hello', 100)).toBe('hello');
  });
});

describe('describe 安全摘要', () => {
  it('处理常见类型', () => {
    expect(describeValue(undefined)).toBe('undefined');
    expect(describeValue(null)).toBe('null');
    expect(describeValue('abc')).toBe('abc');
    expect(describeValue(42)).toBe('42');
    expect(describeValue(true)).toBe('true');
    expect(describeValue({ a: 1 })).toBe('{"a":1}');
  });

  it('超长字符串被压缩', () => {
    const out = describeValue('a'.repeat(300), 100);
    expect(out).toContain('(+200)');
  });

  it('循环引用不抛异常', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => describeValue(cyclic)).not.toThrow();
    expect(describeValue(cyclic)).toBe('[unserializable]');
  });
});

describe('makeRecord 记录形状', () => {
  it('默认级别为 info，detail 为空时不写入', () => {
    const record = makeRecord('page', 'hook.fetch', undefined, { now: 123 });
    expect(record).toEqual({ t: 123, src: 'page', event: 'hook.fetch', level: 'info' });
  });

  it('text 自动截断', () => {
    const record = makeRecord('bg', 'parse.sse', 'x=1', { level: 'warn', text: 'a'.repeat(20000) });
    expect(record.level).toBe('warn');
    expect(record.detail).toBe('x=1');
    expect(record.text?.length).toBeLessThan(20000);
  });
});

describe('pushBounded 有界环形缓冲', () => {
  const rec = (i: number): DiagRecord => ({ t: i, src: 'bg', event: 'e', level: 'info', detail: String(i) });

  it('不超过条数上限，超出时丢最旧的', () => {
    let list: DiagRecord[] = [];
    for (let i = 0; i < 10; i++) list = pushBounded(list, rec(i), 5, 1_000_000);
    expect(list).toHaveLength(5);
    expect(list[0].detail).toBe('5');
    expect(list[4].detail).toBe('9');
  });

  it('不超过字节上限（且至少保留一条，避免把当前这条也丢掉）', () => {
    const big = (i: number): DiagRecord => ({
      t: i,
      src: 'bg',
      event: 'e',
      level: 'info',
      text: 'x'.repeat(500),
    });
    let list: DiagRecord[] = [];
    for (let i = 0; i < 20; i++) list = pushBounded(list, big(i), 1000, 2000);
    const bytes = list.reduce((sum, item) => sum + JSON.stringify(item).length + 2, 0);
    expect(bytes).toBeLessThanOrEqual(2000 + 600);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('单条记录本身就超上限时也保留', () => {
    const list = pushBounded([], { t: 1, src: 'bg', event: 'e', level: 'info', text: 'y'.repeat(50_000) }, 100, 100);
    expect(list).toHaveLength(1);
  });
});

describe('关键记录保留策略（docs/03 §3 缺陷 3）', () => {
  const plain = (i: number): DiagRecord => ({ t: i, src: 'bg', event: 'bg.upsert', level: 'info', detail: `p${i}` });
  const keep = (i: number): DiagRecord => ({ t: i, src: 'page', event: 'hook.ready', level: 'info', detail: `k${i}` });

  it('isKeepEvent 只认 hook. / net. / parse. 前缀', () => {
    expect(isKeepEvent('hook.ready')).toBe(true);
    expect(isKeepEvent('net.xhr')).toBe(true);
    expect(isKeepEvent('parse.chain')).toBe(true);
    expect(isKeepEvent('bg.upsert')).toBe(false);
    expect(isKeepEvent('dom.vidscan')).toBe(false);
  });

  it('超限时先淘汰最旧的非关键记录，关键记录全部存活', () => {
    let list: DiagRecord[] = [];
    // 先放 3 条关键记录，再灌 20 条普通记录，上限只留 6 条
    for (let i = 0; i < 3; i++) list = pushBounded(list, keep(i), 6, 1_000_000);
    for (let i = 0; i < 20; i++) list = pushBounded(list, plain(i), 6, 1_000_000);

    expect(list).toHaveLength(6);
    expect(list.filter((r) => isKeepEvent(r.event))).toHaveLength(3);
    expect(list.filter((r) => isKeepEvent(r.event)).map((r) => r.detail)).toEqual(['k0', 'k1', 'k2']);
    // 普通记录只剩最新的 3 条
    expect(list.filter((r) => !isKeepEvent(r.event)).map((r) => r.detail)).toEqual(['p17', 'p18', 'p19']);
  });

  it('关键记录自己超限时，从最旧的关键记录开始丢', () => {
    let list: DiagRecord[] = [];
    for (let i = 0; i < 10; i++) list = pushBounded(list, keep(i), 4, 1_000_000);
    expect(list).toHaveLength(4);
    expect(list.map((r) => r.detail)).toEqual(['k6', 'k7', 'k8', 'k9']);
  });

  it('关键记录不会被非关键记录的洪峰挤掉', () => {
    let list: DiagRecord[] = [];
    list = pushBounded(list, keep(0), 5, 1_000_000);
    for (let i = 0; i < 500; i++) list = pushBounded(list, plain(i), 5, 1_000_000);
    expect(list.some((r) => r.detail === 'k0')).toBe(true);
  });
});

describe('pushBounded 淘汰（§26 补正：缓冲被关键记录填满时不得吞掉新来的非关键记录）', () => {
  const crit = (n: number): DiagRecord => makeRecord('page', 'net.xhr', `c${n}`);
  const nonCrit = (n: number): DiagRecord => makeRecord('bg', 'bg.upsert', `n${n}`);

  it('缓冲全是关键记录且已满时，新来的非关键记录必须存活（超出配额的关键记录让位）', () => {
    // 400 = DIAG_MAX_RECORDS 条关键记录填满缓冲（配额 75% = 300）
    let list: DiagRecord[] = Array.from({ length: 400 }, (_, i) => crit(i)); // 显式用 400 上限（非默认 500），场景更紧凑
    const incoming = nonCrit(999);
    const next = pushBounded(list, incoming, 400, 900_000);
    expect(next).toContain(incoming); // ⛔ 修复前：incoming 在第一轮被自己挤掉，诊断从此失明
    expect(next.filter((r) => isKeepEvent(r.event)).length).toBe(300); // 关键记录退到配额
    expect(next.some((r) => r.detail === 'c0')).toBe(false); // 让位的是最旧的关键记录
  });

  it('非关键记录此后可以持续入库（最多占满 25% 余量，FIFO 淘汰最旧）', () => {
    let list: DiagRecord[] = Array.from({ length: 400 }, (_, i) => crit(i)); // 显式用 400 上限（非默认 500），场景更紧凑
    for (let n = 1; n <= 10; n++) list = pushBounded(list, nonCrit(n), 400, 900_000);
    const kept = list.filter((r) => r.event === 'bg.upsert').map((r) => r.detail);
    expect(kept).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10']); // 全部存活
    expect(list.filter((r) => isKeepEvent(r.event)).length).toBe(300); // 关键记录稳定在配额
  });

  it('非关键洪峰挤不掉配额内的关键记录', () => {
    let list: DiagRecord[] = Array.from({ length: 300 }, (_, i) => crit(i));
    for (let n = 1; n <= 200; n++) list = pushBounded(list, nonCrit(n), 400, 900_000);
    expect(list.filter((r) => isKeepEvent(r.event)).length).toBe(300); // 关键记录一条不少
    expect(list.filter((r) => r.event === 'bg.upsert').length).toBe(100); // 非关键只保留配额余量
  });
});

/**
 * 纯查询回执的重复抑制（2026-10-02 §40）。
 *
 * 实测：一次 500 条的诊断导出里约四成是 `page.query` / `content.query` / `bg.state` ——
 * 纯噪声会稀释 `vid.*` / `bg.size` / `draft.emit` 这些真证据。抑制规则**只对这三类生效**，
 * 且**只与前一条同事件记录比较**：内容变了就记（会话切换 / 槽条数变化都看得见）。
 */
describe('createRepeatSuppressor（重复抑制，§40）', () => {
  it('同一事件 + 同一 detail 连刷 → 只记第一条', () => {
    const should = createRepeatSuppressor();
    expect(should('page.query', 'kind=chat convId=a title=T')).toBe(true);
    expect(should('page.query', 'kind=chat convId=a title=T')).toBe(false);
    expect(should('page.query', 'kind=chat convId=a title=T')).toBe(false);
    // 内容变了 → 记
    expect(should('page.query', 'kind=chat convId=b title=T2')).toBe(true);
    expect(should('page.query', 'kind=chat convId=b title=T2')).toBe(false);
  });

  it('★只抑制纯查询回执三类；`vid.*` / `bg.size` / `net.*` 等的重复**必须保留**（重复即证据）', () => {
    const should = createRepeatSuppressor();
    expect(should('vid.recheck', 'vid=v1 → 10s 后第 2/30 轮重扫')).toBe(true);
    expect(should('vid.recheck', 'vid=v1 → 10s 后第 2/30 轮重扫')).toBe(true); // 不许吞
    expect(should('bg.size', '实测字节：成功 1 条 / 失败 0 条')).toBe(true);
    expect(should('bg.size', '实测字节：成功 1 条 / 失败 0 条')).toBe(true); // 不许吞
    expect(should('net.xhr', '/im/chain/single len=45042')).toBe(true);
    expect(should('net.xhr', '/im/chain/single len=45042')).toBe(true);
  });

  it('三个受抑制事件各自独立记账（互不干扰）', () => {
    const should = createRepeatSuppressor();
    expect(should('page.query', 'kind=none')).toBe(true);
    expect(should('content.query', 'kind=none')).toBe(true); // 同 detail、不同事件 → 记
    expect(should('bg.state', 'kind=none')).toBe(true);
    expect(should('page.query', 'kind=none')).toBe(false); // 各自记忆里仍是旧的
  });

  it('抑制事件清单是**白名单**（写死三类，避免误伤排查事件）', () => {
    expect([...REPEAT_SUPPRESS_EVENTS].sort()).toEqual(['bg.state', 'content.query', 'page.query']);
  });
});
