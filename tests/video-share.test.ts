/**
 * 视频分享页（`/video-sharing`）适配 —— 2026-10-02 第十六轮。
 *
 * 两件事各测一半：
 *   ① 站点契约里的「URL → 查询参数 / 会话作用域键 / 路径判定」纯函数；
 *   ② 分享接口响应 → `RawMedia` → `MediaDraft` 的整条链路（含「拿不到原片」的口径）。
 * 外加一条**回归锁**：DNR 注入名单里绝不能出现这个 CDN 域（见最后一个 describe）。
 */

import { describe, expect, it } from 'vitest';

import { toDrafts } from '../src/core/extract/common';
import { extractVideoShareRaw } from '../src/core/extract/share';
import { buildDnrRules, isUsableCover, pickPrimary } from '../src/core/media-url';
import {
  VIDEO_SHARE_PATH_PATTERN,
  parseVideoShareQuery,
  videoShareConvId,
} from '../src/core/site-contract';
import {
  SHARE_ID,
  SHARE_VIDEO_BACKUP,
  SHARE_VIDEO_ID,
  SHARE_VIDEO_MAIN,
  SHARE_VIDEO_POSTER,
  VIDEO_SHARE_INFO_RESPONSE,
  VIDEO_SHARE_URL,
} from './fixtures/samples';

describe('分享页 URL：路径判定与查询参数（site-contract §2.7）', () => {
  it('`/video-sharing` 命中路径特征；`/video-sharing/` 与带子路径的也算', () => {
    expect(VIDEO_SHARE_PATH_PATTERN.test('/video-sharing')).toBe(true);
    expect(VIDEO_SHARE_PATH_PATTERN.test('/video-sharing/')).toBe(true);
    expect(VIDEO_SHARE_PATH_PATTERN.test('/video-sharing/abc')).toBe(true);
    // 别把别的路由误伤（pathname 是逐段比对的，不是子串搜索）
    expect(VIDEO_SHARE_PATH_PATTERN.test('/video-sharing-x')).toBe(false);
    expect(VIDEO_SHARE_PATH_PATTERN.test('/chat/38429621189804034')).toBe(false);
    expect(VIDEO_SHARE_PATH_PATTERN.test('/thread/abc123')).toBe(false);
  });

  it('从 URL 里取出 share_id / creation_id / video_id', () => {
    expect(parseVideoShareQuery(VIDEO_SHARE_URL)).toEqual({
      shareId: SHARE_ID,
      creationId: '',
      videoId: SHARE_VIDEO_ID,
    });
    expect(parseVideoShareQuery('https://www.doubao.com/video-sharing?creation_id=c1')).toEqual({
      shareId: '',
      creationId: 'c1',
      videoId: '',
    });
  });

  it('非 URL / 缺参数一律回空串（不抛异常、不编造）', () => {
    expect(parseVideoShareQuery('not a url')).toEqual({ shareId: '', creationId: '', videoId: '' });
    expect(parseVideoShareQuery('')).toEqual({ shareId: '', creationId: '', videoId: '' });
  });

  it('会话作用域键：share_id 优先，退 creation_id、再退 video_id，都空则空串', () => {
    expect(videoShareConvId(VIDEO_SHARE_URL)).toBe(`share_${SHARE_ID}`);
    expect(videoShareConvId('https://www.doubao.com/video-sharing?creation_id=c1&video_id=v1')).toBe('share_c1');
    expect(videoShareConvId('https://www.doubao.com/video-sharing?video_id=v1')).toBe('share_v1');
    // 都取不到 → 空串 = 不算会话（`detectKind` 会给出 kind=none，界面照旧提示「未检测到…」）
    expect(videoShareConvId('https://www.doubao.com/video-sharing')).toBe('');
    // 前缀保证不与对话页那种纯数字 convId 撞车
    expect(videoShareConvId(VIDEO_SHARE_URL)?.startsWith('share_')).toBe(true);
  });
});

describe('extractVideoShareRaw（分享接口响应 → RawMedia）', () => {
  const raws = extractVideoShareRaw(VIDEO_SHARE_INFO_RESPONSE, SHARE_VIDEO_ID);

  it('一条响应只产出一条视频素材，带播放地址 / 备用地址 / 封面 / 宽高 / vid', () => {
    expect(raws).toHaveLength(1);
    const raw = raws[0];
    expect(raw.kind).toBe('video');
    // 来源记 'thread'：这是**站点给出的**分享页数据（与 /thread/ 同档可信度）
    expect(raw.origin).toBe('thread');
    expect(raw.vid).toBe(SHARE_VIDEO_ID);
    expect(raw.downloadUrl).toBe(SHARE_VIDEO_MAIN);
    expect(raw.fallbackApi).toBe(SHARE_VIDEO_BACKUP);
    expect(raw.thumb).toBe(SHARE_VIDEO_POSTER);
    // 实测 play_info 给的就是这个可下载文件的规格（720×1280 竖版）
    expect(raw.width).toBe(720);
    expect(raw.height).toBe(1280);
    // 实测这两个地址都是带水印转码流 —— 绝不能当原片
    expect(raw.raw).toBeUndefined();
  });

  it('vid 缺省时不编造（指纹随之退化成 URL，但不会凭空造一个 id）', () => {
    const [raw] = extractVideoShareRaw(VIDEO_SHARE_INFO_RESPONSE);
    expect(raw.vid).toBeUndefined();
  });

  it('封面是站点自己那个带水印封面域 → 可作卡片缩略图', () => {
    expect(isUsableCover(SHARE_VIDEO_POSTER)).toBe(true);
  });

  it('结构变了 / 没有播放地址 → 空数组（宁缺勿假，绝不拿封面当视频入库）', () => {
    expect(extractVideoShareRaw({}, SHARE_VIDEO_ID)).toEqual([]);
    expect(extractVideoShareRaw(null, SHARE_VIDEO_ID)).toEqual([]);
    expect(extractVideoShareRaw({ data: {} }, SHARE_VIDEO_ID)).toEqual([]);
    expect(extractVideoShareRaw({ data: { play_info: {} } }, SHARE_VIDEO_ID)).toEqual([]);
    expect(extractVideoShareRaw({ data: { play_info: { main: '' } } }, SHARE_VIDEO_ID)).toEqual([]);
  });

  it('只有 main 时也能产出（backup / 封面缺失不阻塞）', () => {
    const raws2 = extractVideoShareRaw({ data: { play_info: { main: SHARE_VIDEO_MAIN } } }, SHARE_VIDEO_ID);
    expect(raws2).toHaveLength(1);
    expect(raws2[0].fallbackApi).toBeUndefined();
    expect(raws2[0].thumb).toBeUndefined();
  });
});

describe('分享页素材 → 草稿（口径：分享页只能拿到带水印版）', () => {
  const CTX = { convId: `share_${SHARE_ID}`, convKind: 'thread' as const, convTitle: '豆包 AI 视频' };
  const drafts = toDrafts(extractVideoShareRaw(VIDEO_SHARE_INFO_RESPONSE, SHARE_VIDEO_ID), CTX);

  it('入库一条：指纹用 vid、会话类型 thread、状态是「解析中」而非「已拿到原片」', () => {
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft.fingerprint).toBe(`vid:${SHARE_VIDEO_ID}`);
    expect(draft.convId).toBe(`share_${SHARE_ID}`);
    expect(draft.convKind).toBe('thread');
    expect(draft.vid).toBe(SHARE_VIDEO_ID);
    // 没有 raw 变体 → state=pending（界面「解析中」），随后按分享页口径给出「原片不可得」
    expect(draft.state).toBe('pending');
    expect(draft.variants.some((variant) => variant.isRaw)).toBe(false);
  });

  it('主地址就是站点给的带水印播放地址（诚实地标「候选地址（参数改写）」，不冒充原片）', () => {
    const draft = drafts[0];
    expect(pickPrimary(draft.variants)).toContain('lr=video_gen_no_watermark');
    const candidate = draft.variants.find((variant) => variant.label === '候选地址（参数改写）');
    expect(candidate?.isRaw).toBe(false);
    // 备用播放源（带水印）排在候选地址之下、封面之上 —— 只作末位候选
    const fallback = draft.variants.find((variant) => variant.label === '备选播放源（带水印）');
    expect(fallback?.isRaw).toBe(false);
    expect(fallback?.rank).toBeGreaterThan(0);
    expect(fallback!.rank).toBeLessThan(candidate!.rank);
  });

  it('时间 / 体积不编造：站点没给就不写进 meta', () => {
    const draft = drafts[0];
    expect(draft.meta.createdAt).toBeUndefined();
    expect(draft.meta.size).toBeUndefined();
    expect(draft.meta.ext).toBe('mp4');
  });

  it('宽高取自 play_info，并带「预览」标记（界面显示「预览 720×1280」，用户 2026-10-02 拍板）', () => {
    const draft = drafts[0];
    expect(draft.meta.width).toBe(720);
    expect(draft.meta.height).toBe(1280);
    // `dimsPreview` 由 `toDraft` 对**所有**视频宽高统一打上 → 卡片副信息行会写成「预览 720×1280」
    expect(draft.meta.dimsPreview).toBe(true);
  });

  it('站点把宽高给成字符串时也能读出来（站点数字字段形态不稳定）', () => {
    const raws2 = extractVideoShareRaw(
      { data: { play_info: { main: SHARE_VIDEO_MAIN, width: '1080', height: '1920' } } },
      SHARE_VIDEO_ID,
    );
    expect(raws2[0].width).toBe(1080);
    expect(raws2[0].height).toBe(1920);
  });

  it('清晰度标签仍然不给（definition 有意不取 —— 避免 primary 换成真原片后标签说错文件）', () => {
    expect(drafts[0].meta.label).toBeUndefined();
  });

  it('卡片封面用站点那张图', () => {
    expect(drafts[0].cover).toBe(SHARE_VIDEO_POSTER);
  });

  it('没有 vid 时按 J3 不入库（拿不到稳定指纹，也换不到真原片）', () => {
    // ⚠️ 这里模拟的是「URL 里连 video_id 都没有」：extractVideoShareRaw 仍产出一条 raw，
    // 但 toDraft 因 `genuine` 不成立（无 vid、无站点声明的 raw）把它丢掉。
    const noVid = toDrafts(extractVideoShareRaw(VIDEO_SHARE_INFO_RESPONSE), CTX);
    expect(noVid).toEqual([]);
  });
});

describe('回归锁：这个分享 CDN 域不得进入 DNR 注入名单（2026-10-02 实测 403）', () => {
  it('规则里没有任何一条覆盖 365yg.com 的注入规则', () => {
    /*
     * 实测（`site-contract` §2.7）：该 CDN 对 `Referer: https://www.doubao.com/…` **直接回 403**，
     * 而带上 `CORS_INJECT_HOST_FILTERS` 就等于同时注入 Referer —— 加进去会把本来能下的文件打成 403。
     * 这条锁保证以后的会话不会「顺手补全域名」。
     */
    const all = JSON.stringify(buildDnrRules());
    expect(all).not.toContain('365yg.com');
  });
});
