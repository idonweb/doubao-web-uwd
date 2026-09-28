import { describe, expect, it } from 'vitest';

import {
  DownloadQueue,
  FilenameAllocator,
  baseFilename,
  formatTimestamp,
  parseTotalBytes,
  sanitizeExt,
  sanitizeSegment,
  sequencedFilename,
} from '../src/core/download';
import type { DownloadProgress } from '../src/core/types';

describe('字节数实测的响应解析（parseTotalBytes，2026-09-28 体积兜底）', () => {
  const headers = (map: Record<string, string>) => (name: string) => map[name.toLowerCase()] ?? null;

  it('206（服务器支持 Range）：从 content-range 的「/」之后取总长', () => {
    // 探针实测：Range: bytes=0-0 → 206 + `content-range: bytes 0-0/2074286` + content-length: 1
    expect(parseTotalBytes(206, headers({ 'content-range': 'bytes 0-0/2074286', 'content-length': '1' }))).toBe(2_074_286);
    expect(parseTotalBytes(206, headers({ 'content-range': 'bytes 0-0/1861088' }))).toBe(1_861_088);
  });

  it('200（站点忽略 Range）：content-length 就是完整长度', () => {
    expect(parseTotalBytes(200, headers({ 'content-length': '8698069' }))).toBe(8_698_069);
  });

  it('认不出来一律 undefined（宁缺勿假）：缺头 / 星号 / 非 2xx / 非法值', () => {
    expect(parseTotalBytes(206, headers({}))).toBeUndefined();
    expect(parseTotalBytes(206, headers({ 'content-range': 'bytes 0-0/*' }))).toBeUndefined();
    expect(parseTotalBytes(206, headers({ 'content-range': 'bytes 0-1/0' }))).toBeUndefined();
    expect(parseTotalBytes(200, headers({}))).toBeUndefined();
    expect(parseTotalBytes(200, headers({ 'content-length': '0' }))).toBeUndefined();
    expect(parseTotalBytes(200, headers({ 'content-length': 'abc' }))).toBeUndefined();
    expect(parseTotalBytes(403, headers({ 'content-length': '9' }))).toBeUndefined();
    expect(parseTotalBytes(302, headers({ 'content-range': 'bytes 0-0/9' }))).toBeUndefined();
  });
});

describe('文件名规则（方案 §7.1，已冻结）', () => {
  it('时间戳格式 YYYY-M-D HH-mm-ss（年月日不补零，时分秒补零）', () => {
    expect(formatTimestamp(new Date(2026, 8, 26, 17, 3, 24))).toBe('2026-9-26 17-03-24');
    expect(formatTimestamp(new Date(2026, 11, 1, 0, 0, 5))).toBe('2026-12-1 00-00-05');
    expect(formatTimestamp(new Date(2026, 0, 9, 9, 9, 9))).toBe('2026-1-9 09-09-09');
  });

  it('片段净化：非法字符替换、去掉结尾的点与空格', () => {
    expect(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeSegment('  name...  ')).toBe('name');
    expect(sanitizeSegment('')).toBe('unknown');
  });

  it('扩展名净化', () => {
    expect(sanitizeExt('MP4')).toBe('mp4');
    expect(sanitizeExt('jp!g')).toBe('jpg');
    expect(sanitizeExt('')).toBe('bin');
  });

  it('完整示例与方案文档一致', () => {
    expect(baseFilename('7f3a92c1-08b4', 'mp4', new Date(2026, 8, 26, 17, 3, 24))).toBe(
      'doubao-7f3a92c1-08b4-2026-9-26 17-03-24.mp4',
    );
  });

  it('序号从 -02 起两位补零，加在时间戳之后', () => {
    expect(sequencedFilename('doubao-a-2026-9-26 17-03-24.mp4', 2)).toBe(
      'doubao-a-2026-9-26 17-03-24-02.mp4',
    );
    expect(sequencedFilename('doubao-a-2026-9-26 17-03-24.mp4', 10)).toBe(
      'doubao-a-2026-9-26 17-03-24-10.mp4',
    );
  });

  it('分配器：首个不编号，冲突时依次加序号', () => {
    const allocator = new FilenameAllocator();
    const date = new Date(2026, 8, 26, 17, 3, 24);
    expect(allocator.next('conv-1', 'mp4', date)).toBe('doubao-conv-1-2026-9-26 17-03-24.mp4');
    expect(allocator.next('conv-1', 'mp4', date)).toBe('doubao-conv-1-2026-9-26 17-03-24-02.mp4');
    expect(allocator.next('conv-1', 'mp4', date)).toBe('doubao-conv-1-2026-9-26 17-03-24-03.mp4');
    expect(allocator.next('conv-2', 'mp4', date)).toBe('doubao-conv-2-2026-9-26 17-03-24.mp4');
    expect(allocator.allocated).toHaveLength(4);
  });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await delay(5);
  }
}

describe('DownloadQueue（单并发 + 重试）', () => {
  it('并发度恒为 1，任务按序执行', async () => {
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];

    const queue = new DownloadQueue({ concurrency: 1, retry: 0 });
    queue.enqueue(
      ['a', 'b', 'c'].map((id) => ({
        id,
        label: id,
        run: async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          order.push(id);
          await delay(8);
          running--;
        },
      })),
    );

    await waitFor(() => queue.progress.done === 3);
    expect(maxRunning).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(queue.progress.total).toBe(3);
    expect(queue.progress.failed).toBe(0);
  });

  it('失败重试 1 次后仍失败 → 计入 failed 并回调', async () => {
    const results: Array<{ id: string; ok: boolean }> = [];
    const attempts: number[] = [];

    const queue = new DownloadQueue({
      concurrency: 1,
      retry: 1,
      onJobDone: (job, ok) => results.push({ id: job.id, ok }),
    });

    queue.enqueue([
      {
        id: 'always-fail',
        label: '',
        run: async (attempt) => {
          attempts.push(attempt);
          throw new Error('HTTP 403');
        },
      },
    ]);

    await waitFor(() => queue.progress.failed === 1);
    expect(attempts).toEqual([0, 1]);
    expect(results).toEqual([{ id: 'always-fail', ok: false }]);
    expect(queue.progress.lastError).toBe('HTTP 403');
  });

  it('首次失败、重试成功 → 计入 done', async () => {
    let calls = 0;
    const progress: DownloadProgress[] = [];
    const queue = new DownloadQueue({ concurrency: 1, retry: 1, onProgress: (p) => progress.push(p) });

    queue.enqueue([
      {
        id: 'flaky',
        label: '',
        run: async () => {
          calls++;
          if (calls === 1) throw new Error('网络抖动');
        },
      },
    ]);

    await waitFor(() => queue.progress.done === 1);
    expect(calls).toBe(2);
    expect(queue.progress.failed).toBe(0);
    expect(progress.at(-1)?.done).toBe(1);
  });

  it('stop() 之后不再执行排队中的任务', async () => {
    let started = 0;
    const queue = new DownloadQueue({ concurrency: 1, retry: 0 });
    queue.enqueue([
      { id: 'first', label: '', run: async () => { started++; await delay(20); } },
      { id: 'second', label: '', run: async () => { started++; } },
    ]);
    queue.stop();
    await waitFor(() => queue.progress.running === 0);
    await delay(40);
    expect(started).toBe(1);
  });
});
