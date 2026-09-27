import { describe, expect, it, vi } from 'vitest';

import {
  createVidResolver,
  describeVidPayload,
  findCreationId,
  findDownloadMeta,
  findDownloadUrl,
  findNodeId,
  formatVidStep,
  readNodeInfoPage,
  type VidStepEvent,
} from '../src/core/vid-resolver';
import {
  DOWNLOAD_INFO_RESPONSE,
  HOMEPAGE_RESPONSE,
  NODE_INFO_RESPONSE,
} from './fixtures/samples';

/** 200 响应的极简替身（body 直接作为 json 返回） */
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

describe('三步 API 的响应解析（纯函数）', () => {
  it('第 1 步：按「我的创作」这个中文字面量找创作 ID', () => {
    expect(findCreationId(HOMEPAGE_RESPONSE)).toBe('cid-123');
    expect(findCreationId({ data: { children: [] } })).toBeNull();
    expect(findCreationId(null)).toBeNull();
  });

  it('第 2 步：按 key === vid 找 node id（字符串比较，兼容数字型 key）', () => {
    expect(findNodeId(NODE_INFO_RESPONSE, 'v0abc123def456')).toBe('nid-2');
    expect(findNodeId({ data: { children: [{ id: 'n', key: 12345 }] } }, '12345')).toBe('n');
    expect(findNodeId(NODE_INFO_RESPONSE, 'not-exist')).toBeNull();
  });

  it('第 3 步：取 download_infos[0].main_url', () => {
    expect(findDownloadUrl(DOWNLOAD_INFO_RESPONSE)).toBe(
      'https://v3-dy.douyinvod.com/full/original.mp4?lr=unwatermarked',
    );
    expect(findDownloadUrl({ data: { download_infos: [] } })).toBeNull();
    expect(findDownloadUrl(undefined)).toBeNull();
  });

  it('第 3 步：download_infos[0] 的 width / height / size 存在才带回，缺了不编造', () => {
    expect(findDownloadMeta(DOWNLOAD_INFO_RESPONSE)).toEqual({ width: 1280, height: 720, size: 41_000_000 });
    expect(findDownloadMeta({ data: { download_infos: [{ main_url: 'https://x' }] } })).toEqual({});
    expect(findDownloadMeta({ data: { download_infos: [{ width: 'bad' }] } })).toEqual({});
    expect(findDownloadMeta(undefined)).toEqual({});
  });

  it('第 2 步翻页（readNodeInfoPage）：读出 key/id/has_more/next_cursor，结构对不上返回 null', () => {
    expect(
      readNodeInfoPage({
        code: 0,
        data: {
          children: [
            { id: 'nid-1', key: 'v0abc' },
            { id: 2, key: 123 }, // 数字形态也转成字符串
            { key: 'no-id' }, // 缺 id 的条目跳过
          ],
          has_more: true,
          next_cursor: 'c-2',
        },
      }),
    ).toEqual({
      children: [
        { key: 'v0abc', id: 'nid-1' },
        { key: '123', id: '2' },
      ],
      hasMore: true,
      nextCursor: 'c-2',
    });
    // has_more=false → 游标清空（到底）
    expect(readNodeInfoPage({ data: { children: [], has_more: false, next_cursor: 'c-9' } })).toEqual({
      children: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(readNodeInfoPage({ data: {} })).toBeNull();
  });
});

describe('createVidResolver', () => {
  /** 按三步 API 的路径分派响应，比「按调用序」更贴近真实行为 */
  function pathFakeFetch(map: Record<string, unknown>) {
    let count = 0;
    const fn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      count++;
      const key = Object.keys(map).find((path) => url.includes(path));
      const body = key === undefined ? {} : map[key];
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    return { fn, count: () => count };
  }

  const FULL_MAP = {
    '/samantha/aispace/homepage': HOMEPAGE_RESPONSE,
    '/samantha/aispace/node_info': NODE_INFO_RESPONSE,
    '/samantha/aispace/get_download_info': DOWNLOAD_INFO_RESPONSE,
  };

  it('串行三步后返回原始原片地址，并命中缓存', async () => {
    const { fn, count } = pathFakeFetch(FULL_MAP);
    const resolver = createVidResolver({ fetchFn: fn });

    const url = await resolver.resolve('v0abc123def456');
    expect(url).toBe('https://v3-dy.douyinvod.com/full/original.mp4?lr=unwatermarked');
    expect(count()).toBe(3);
    // 第 3 步顺带带回的元数据也能从缓存读出（fixture 里给了 1280×720 / 41MB）
    expect(resolver.metaOf('v0abc123def456')).toEqual({ width: 1280, height: 720, size: 41_000_000 });
    expect(resolver.has('v0abc123def456')).toBe(true);

    // 第二次直接走缓存
    expect(await resolver.resolve('v0abc123def456')).toBe(url);
    expect(count()).toBe(3);
  });

  it('翻遍整棵树（has_more=false）仍未见到 vid → 确定性「已超期」，TTL 内不重试', async () => {
    let clock = 0;
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/samantha/aispace/homepage')) return ok(HOMEPAGE_RESPONSE);
      if (url.includes('/samantha/aispace/node_info')) {
        // 单页、无 has_more → 已到底，但里面没有这个 vid
        return ok({ code: 0, data: { children: [{ id: 'nid-1', key: 'v0other000000' }] } });
      }
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    const resolver = createVidResolver({ fetchFn, ttlMs: 1_000, indexTtlMs: 1_000, now: () => clock });
    const first = await resolver.resolveDetailed('v0missing');
    expect(first).toEqual({ url: null, expired: true });
    expect(calls.length).toBe(2); // homepage + 1 页 node_info

    // 确定性结论进了负缓存：TTL 内再问不发生请求
    const second = await resolver.resolveDetailed('v0missing');
    expect(second).toEqual({ url: null, expired: true });
    expect(calls.length).toBe(2);

    // TTL 过后允许再确认一次（树可能有新变化）
    clock += 1_001;
    await resolver.resolveDetailed('v0missing');
    expect(calls.length).toBe(4);
  });

  it('达翻页上限（has_more 恒为 true）→ 不下确定性结论，仍可重试', async () => {
    let seq = 0;
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/samantha/aispace/homepage')) return ok(HOMEPAGE_RESPONSE);
      if (url.includes('/samantha/aispace/node_info')) {
        seq++;
        return ok({
          code: 0,
          data: {
            children: [{ id: `nid-${seq}`, key: `v0page${seq}` }],
            has_more: true,
            next_cursor: `cursor-${seq}`,
          },
        });
      }
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    const resolver = createVidResolver({ fetchFn, indexTtlMs: 0, ttlMs: 0 });
    const outcome = await resolver.resolveDetailed('v0missing');
    // 10 页上限（AISPACE_WALK_MAX_PAGES）+ 1 次 homepage；vid 未见但「未到底」→ expired=false
    expect(outcome).toEqual({ url: null, expired: false });
  });

  it('vid 在第 2 页也能找到：cursor 翻页 + 请求体带游标', async () => {
    const bodies: unknown[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      bodies.push(init?.body);
      if (url.includes('/samantha/aispace/homepage')) return ok(HOMEPAGE_RESPONSE);
      if (url.includes('/samantha/aispace/node_info')) {
        const cursor = JSON.parse(String(init?.body) || '{}')?.cursor;
        if (!cursor) {
          return ok({
            code: 0,
            data: {
              children: [{ id: 'nid-1', key: 'v0page1item' }],
              has_more: true,
              next_cursor: 'cursor-2',
            },
          });
        }
        return ok({
          code: 0,
          data: { children: [{ id: 'nid-deep', key: 'v0deep0000001' }], has_more: false },
        });
      }
      if (url.includes('/samantha/aispace/get_download_info')) return ok(DOWNLOAD_INFO_RESPONSE);
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    const resolver = createVidResolver({ fetchFn, indexTtlMs: 0, ttlMs: 0 });
    expect(await resolver.resolve('v0deep0000001')).toBe(
      'https://v3-dy.douyinvod.com/full/original.mp4?lr=unwatermarked',
    );
    expect(bodies.some((body) => String(body).includes('"cursor":"cursor-2"'))).toBe(true);
  });

  it('新鲜索引未见 → 先做 head 校验：树没变 = 确定性超期；树变了 = 重新扫描', async () => {
    let clock = 0;
    let headKey = 'v0head0000001';
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/samantha/aispace/homepage')) return ok(HOMEPAGE_RESPONSE);
      if (url.includes('/samantha/aispace/node_info')) {
        return ok({ code: 0, data: { children: [{ id: 'nid-head', key: headKey }] } });
      }
      throw new Error('unexpected');
    }) as unknown as typeof fetch;

    const resolver = createVidResolver({ fetchFn, ttlMs: 60_000, indexTtlMs: 60_000, now: () => clock });

    // 第 1 个 vid 建好索引（complete）；第 2 个 vid 未见 → head 没变 → 确定性超期
    await resolver.resolveDetailed('v0head0000001');
    const before = calls.length;
    const miss = await resolver.resolveDetailed('v0other000000');
    expect(miss.expired).toBe(true);
    expect(calls.length).toBe(before + 2); // homepage + head 校验，各一次

    // 树变了（新创作插到最前面，head 变化）→ 重新全量扫描，且此时树里还是找不到 → 仍超期
    clock += 1; // 不让负缓存/索引过期（TTL 60s）
    headKey = 'v0newhead00001';
    const after = calls.length;
    const miss2 = await resolver.resolveDetailed('v0fresh0000001');
    expect(miss2.expired).toBe(true);
    expect(calls.length).toBe(after + 3); // homepage + head 校验（发现变化）+ 全量重扫
  });

  it('请求 URL 带上契约里的固定 query', async () => {
    const calls: string[] = [];
    const spy = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    await createVidResolver({ fetchFn: spy }).resolve('v0x');
    expect(calls[0]).toContain('/samantha/aispace/homepage?aid=497858');
    expect(calls[0]).toContain('device_platform=web');
    expect(calls[0]).toContain('version_code=20800');
    expect(calls[0]).toContain('pkg_type=release_version');
  });

  it('HTTP 非 200 时不抛出，返回 null', async () => {
    const failing = (async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    await expect(createVidResolver({ fetchFn: failing }).resolve('v0x')).resolves.toBeNull();
  });

  it('网络异常被吞掉并返回 null，不抛出到调用方', async () => {
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const resolver = createVidResolver({ fetchFn: failing });
    await expect(resolver.resolve('v0x')).resolves.toBeNull();
  });

  it('同一个 vid 并发请求只发一次三步调用', async () => {
    const responses = [HOMEPAGE_RESPONSE, NODE_INFO_RESPONSE, DOWNLOAD_INFO_RESPONSE];
    let index = 0;
    const spy = vi.fn(
      async () =>
        ({ ok: true, status: 200, json: async () => responses[Math.min(index++, responses.length - 1)] }) as Response,
    );
    const resolver = createVidResolver({ fetchFn: spy as unknown as typeof fetch });

    const [a, b] = await Promise.all([
      resolver.resolve('v0abc123def456'),
      resolver.resolve('v0abc123def456'),
    ]);
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('空 vid 直接返回 null', async () => {
    const spy = vi.fn();
    const resolver = createVidResolver({ fetchFn: spy as unknown as typeof fetch });
    expect(await resolver.resolve('')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('缓存 TTL / force / clear（第四轮：签名地址过期自愈）', () => {
  const URL_OLD = 'https://v3-dy.douyinvod.com/full/original.mp4?sign=OLD';
  const URL_NEW = 'https://v3-dy.douyinvod.com/full/original.mp4?sign=NEW';

  /** 每次三步调用返回一个可控地址 */
  function resolverWith(urls: string[], ttlMs: number) {
    let step = 0;
    let clock = 0;
    const spy = vi.fn(async () => {
      const url = urls[Math.min(Math.floor(step / 3), urls.length - 1)];
      step++;
      return { ok: true, status: 200, json: async () => responseFor(step, url) } as Response;
    });
    const resolver = createVidResolver({
      fetchFn: spy as unknown as typeof fetch,
      ttlMs,
      // 索引 TTL 与正缓存同寿命：让「TTL 过期后重新走三步」的请求计数保持可预期
      indexTtlMs: ttlMs,
      now: () => clock,
    });
    return { resolver, spy, advance: (ms: number) => (clock += ms), calls: () => spy.mock.calls.length };
  }

  /** 用真实的 fixture 结构，只把第 3 步的 main_url 换成可控值 */
  function responseFor(step: number, url: string): unknown {
    const phase = ((step - 1) % 3) + 1;
    if (phase === 1) return HOMEPAGE_RESPONSE;
    if (phase === 2) return NODE_INFO_RESPONSE;
    return { data: { download_infos: [{ main_url: url }] } };
  }

  it('TTL 内命中缓存，超过 TTL 后重新解析（拿到新签名地址）', async () => {
    const { resolver, advance, calls } = resolverWith([URL_OLD, URL_NEW], 1_000);

    expect(await resolver.resolve('v0abc123def456')).toBe(URL_OLD);
    expect(calls()).toBe(3);

    // TTL 内：命中缓存，不再发请求
    advance(999);
    expect(await resolver.resolve('v0abc123def456')).toBe(URL_OLD);
    expect(calls()).toBe(3);

    // 越过 TTL：重新走三步 API
    advance(1);
    expect(resolver.has('v0abc123def456')).toBe(false);
    expect(await resolver.resolve('v0abc123def456')).toBe(URL_NEW);
    expect(calls()).toBe(6);
  });

  it('force=true 忽略未过期的缓存', async () => {
    const { resolver, calls } = resolverWith([URL_OLD, URL_NEW], 60_000);
    expect(await resolver.resolve('v0abc123def456')).toBe(URL_OLD);
    expect(await resolver.resolve('v0abc123def456', { force: true })).toBe(URL_NEW);
    expect(calls()).toBe(6);
  });

  it('clear() 丢弃全部缓存', async () => {
    const { resolver, calls } = resolverWith([URL_OLD, URL_NEW], 60_000);
    await resolver.resolve('v0abc123def456');
    expect(resolver.has('v0abc123def456')).toBe(true);

    resolver.clear();
    expect(resolver.has('v0abc123def456')).toBe(false);
    expect(await resolver.resolve('v0abc123def456')).toBe(URL_NEW);
    expect(calls()).toBe(6);
  });

  it('ttlMs = 0 表示永久缓存（保持旧行为，兼容既有调用）', async () => {
    const { resolver, advance, calls } = resolverWith([URL_OLD, URL_NEW], 0);
    expect(await resolver.resolve('v0abc123def456')).toBe(URL_OLD);
    advance(24 * 3600_000);
    expect(await resolver.resolve('v0abc123def456')).toBe(URL_OLD);
    expect(calls()).toBe(3);
  });
});

describe('三步 API 的步骤级诊断（P1，2026-09-27）', () => {
  function pathFakeFetch(map: Record<string, unknown>) {
    const fn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(map).find((path) => url.includes(path));
      const body = key === undefined ? {} : map[key];
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    return fn;
  }

  function collect() {
    const events: VidStepEvent[] = [];
    return { events, onStep: (event: VidStepEvent) => events.push(event) };
  }

  it('成功时逐步回调三件事，并带上关键事实', async () => {
    const { events, onStep } = collect();
    const resolver = createVidResolver({
      fetchFn: pathFakeFetch({
        '/samantha/aispace/homepage': HOMEPAGE_RESPONSE,
        '/samantha/aispace/node_info': NODE_INFO_RESPONSE,
        '/samantha/aispace/get_download_info': DOWNLOAD_INFO_RESPONSE,
      }),
      onStep,
    });

    expect(await resolver.resolve('v0abc123def456')).toBeTruthy();
    expect(events.map((e) => `${e.step}:${e.ok}`)).toEqual([
      'homepage:true',
      'node_info:true',
      'get_download_info:true',
    ]);
    expect(events[0].detail).toContain('创作 id=');
    expect(events[1].detail).toContain('node id=');
    expect(events[2].detail).toContain('download_infos=1');
    expect(events.every((e) => typeof e.ms === 'number')).toBe(true);
  });

  it('命中缓存时不回调（没有真实请求就没有步骤事实）', async () => {
    const { events, onStep } = collect();
    const resolver = createVidResolver({
      fetchFn: pathFakeFetch({
        '/samantha/aispace/homepage': HOMEPAGE_RESPONSE,
        '/samantha/aispace/node_info': NODE_INFO_RESPONSE,
        '/samantha/aispace/get_download_info': DOWNLOAD_INFO_RESPONSE,
      }),
      onStep,
    });
    await resolver.resolve('v0abc123def456');
    await resolver.resolve('v0abc123def456');
    expect(events).toHaveLength(3);
  });

  it('HTTP 403：记下状态码与响应体片段（风控页 / 登录页一眼可辨）', async () => {
    const { events, onStep } = collect();
    const forbidden = (async () => ({
      ok: false,
      status: 403,
      text: async () => '<html><body>访问受限，请完成验证</body></html>',
    })) as unknown as typeof fetch;
    const resolver = createVidResolver({ fetchFn: forbidden, onStep });

    expect(await resolver.resolve('v0x')).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ step: 'homepage', ok: false, status: 403 });
    expect(events[0].detail).toContain('HTTP 403');
    expect(events[0].detail).toContain('访问受限');
  });

  it('网络层失败（代理不可达 / 证书）与超时分别有可读原因', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const { events, onStep } = collect();
    await createVidResolver({ fetchFn: failing, onStep }).resolve('v0x');
    expect(events[0].detail).toContain('请求未完成');
    expect(events[0].detail).toContain('代理');

    const aborted = (async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as unknown as typeof fetch;
    const timeout = collect();
    await createVidResolver({ fetchFn: aborted, timeoutMs: 20_000, onStep: timeout.onStep }).resolve('v0x');
    expect(timeout.events[0].detail).toContain('请求超时（>20000ms）');
  });

  it('结构对不上时说明是「第几步的什么字段」缺失', async () => {
    // 第 2 步：homepage 正常，但 node_info 里没有该 vid
    const missingNode = collect();
    await createVidResolver({
      fetchFn: pathFakeFetch({
        '/samantha/aispace/homepage': HOMEPAGE_RESPONSE,
        '/samantha/aispace/node_info': { data: { children: [] } },
      }),
      onStep: missingNode.onStep,
    }).resolve('v0missing');
    expect(missingNode.events.map((e) => `${e.step}:${e.ok}`)).toEqual(['homepage:true', 'node_info:false']);
    expect(missingNode.events[1].detail).toContain('没有 key=v0missing 的条目');
    expect(missingNode.events[1].detail).toContain('children=0');

    // 第 1 步：连「我的创作」都没有
    const missingRoot = collect();
    await createVidResolver({
      fetchFn: pathFakeFetch({ '/samantha/aispace/homepage': { code: 1001, msg: '未登录', data: {} } }),
      onStep: missingRoot.onStep,
    }).resolve('v0x');
    expect(missingRoot.events).toHaveLength(1);
    expect(missingRoot.events[0].detail).toContain('没有「我的创作」条目');
    expect(missingRoot.events[0].detail).toContain('code=1001');
    expect(missingRoot.events[0].detail).toContain('msg=未登录');

    // 第 3 步：download_infos 里没有 main_url
    const missingUrl = collect();
    await createVidResolver({
      fetchFn: pathFakeFetch({
        '/samantha/aispace/homepage': HOMEPAGE_RESPONSE,
        '/samantha/aispace/node_info': NODE_INFO_RESPONSE,
        '/samantha/aispace/get_download_info': { data: { download_infos: [{}] } },
      }),
      onStep: missingUrl.onStep,
    }).resolve('v0abc123def456');
    expect(missingUrl.events[2].detail).toContain('没有可用的 main_url');
    expect(missingUrl.events[2].detail).toContain('download_infos=1');
  });
});

describe('诊断文案（纯函数）', () => {
  it('formatVidStep：一步一行，含状态码与耗时', () => {
    expect(formatVidStep({ vid: 'v1', step: 'homepage', ok: false, ms: 812, status: 403, detail: 'HTTP 403' })).toBe(
      'step=homepage 失败 ms=812 status=403 HTTP 403',
    );
    expect(formatVidStep({ vid: 'v1', step: 'node_info', ok: true, ms: 5 })).toBe('step=node_info ok ms=5');
  });

  it('describeVidPayload：只摘实际存在的字段，缺什么就写「缺失」', () => {
    expect(describeVidPayload({ code: 0, msg: 'ok', data: { children: [1, 2] } }, 'children')).toBe(
      'code=0 msg=ok children=2',
    );
    expect(describeVidPayload({ data: {} }, 'children')).toBe('children=缺失');
    expect(describeVidPayload(null, 'children')).toBe('children=缺失');
    expect(describeVidPayload({}, undefined)).toBe('无可用字段');
  });
});

