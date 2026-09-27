import { describe, expect, it, vi } from 'vitest';

import {
  createVidResolver,
  describeVidPayload,
  findCreationId,
  findDownloadMeta,
  findDownloadUrl,
  findNodeId,
  formatVidStep,
  type VidStepEvent,
} from '../src/core/vid-resolver';
import {
  DOWNLOAD_INFO_RESPONSE,
  HOMEPAGE_RESPONSE,
  NODE_INFO_RESPONSE,
} from './fixtures/samples';

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

  it('vid 查不到 node 时返回 null，且不缓存失败（允许重试）', async () => {
    const { fn, count } = pathFakeFetch({
      '/samantha/aispace/homepage': HOMEPAGE_RESPONSE,
      '/samantha/aispace/node_info': { data: { children: [] } },
    });
    const resolver = createVidResolver({ fetchFn: fn });

    expect(await resolver.resolve('v0missing')).toBeNull();
    expect(resolver.has('v0missing')).toBe(false);
    expect(count()).toBe(2);

    await resolver.resolve('v0missing');
    expect(count()).toBe(4);
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

