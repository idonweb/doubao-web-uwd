import { describe, expect, it } from 'vitest';

import { rawFromCreation, readModelHints, readModelLabelText, readModelTimeline, siteTimeToMs, toDraft } from '../src/core/extract/common';
import type { RawMedia } from '../src/core/types';
import {
  MODEL_HINT_CHAT_ABILITY,
  MODEL_HINT_IMAGE_ONLY_ACK,
  MODEL_HINT_MODEL,
  MODEL_HINT_TASK_ACK,
  MODEL_HINT_TOOL,
  MODEL_LABEL_LEGACY_NAME,
  MODEL_LABEL_LEGACY_TEXT,
  MODEL_LABEL_MESSAGE,
  MODEL_LABEL_NAME,
  MODEL_LABEL_TEXT,
} from './fixtures/samples';

/**
 * 站点时间字段的单位换算（2026-09-28 第十轮）。
 *
 * 站点所有时间字段都是**秒级** Unix（消息 `create_time`、创作树节点 `create_time`），
 * 而 `meta.createdAt` 与 `firstSeen` / `lastSeen` 统一用**毫秒** —— 换算只走这一个函数。
 */
describe('siteTimeToMs（秒级 → 毫秒）', () => {
  it('正常值 ×1000 取整', () => {
    expect(siteTimeToMs(1790520877)).toBe(1_790_520_877_000);
    expect(siteTimeToMs(1779538923)).toBe(1_779_538_923_000);
    // 带小数也取整（站点偶尔给 .5 这类）
    expect(siteTimeToMs(1790520877.512)).toBe(1_790_520_877_512);
  });

  it('缺省 / 0 / 负数 / NaN / undefined 一律返回 undefined —— 宁缺勿假，不编时间', () => {
    expect(siteTimeToMs(undefined)).toBeUndefined();
    expect(siteTimeToMs(null)).toBeUndefined();
    expect(siteTimeToMs(0)).toBeUndefined();
    expect(siteTimeToMs(-1)).toBeUndefined();
    expect(siteTimeToMs(Number.NaN)).toBeUndefined();
    expect(siteTimeToMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

/**
 * 图片体积：**报文里的 `size` 一律不采纳**（2026-09-28 实机反例，`docs/03` §18）。
 *
 * 站点确实会在 image 的子对象里给 `size`，但它与「我们真正下载的那个文件」不是同一个字节数 ——
 * 实机：卡片显示 378 KB（子对象的 size），而 `image_ori_raw.url` 下回来的是 3.81 MB 的 PNG
 * （3 996 293 字节）。所以宽高照旧从子对象取，`size` 一律丢掉，
 * 图片体积只由 background 实测 `primary` 得到。
 */
describe('图片体积：不从报文取 size（回归锁）', () => {
  const creation = {
    image: {
      image_thumb: { url: 'https://p3-ibyteimg.com/t.jpeg', width: 2720, height: 1520, size: 379_000 },
      image_preview: { url: 'https://p3-ibyteimg.com/p.jpeg', width: 2732, height: 1534 },
      image_ori_raw: {
        url: 'https://p3-ibyteimg.com/rc_gen_image/dfe9.jpeg~tplv-a9rns2rl98-image_raw.png',
        width: 2732,
        height: 1534,
        size: 378_043,
      },
    },
  };

  it('rawFromCreation 只取宽高：子对象带 size 也不读', () => {
    const raw = rawFromCreation(creation, 'chain');
    expect(raw?.width).toBe(2732); // image_ori_raw 的宽高（质量最高优先）
    expect(raw?.height).toBe(1534);
    expect(raw?.raw).toContain('image_raw.png');
    expect(raw?.size).toBeUndefined();
  });

  it('toDraft 因此不会把假体积写进 meta.size —— 交给 bg 实测兜底', () => {
    const raw = rawFromCreation(creation, 'chain');
    const draft = toDraft(raw!, { convId: 'c1', convKind: 'chat', convTitle: 't' });
    expect(draft).not.toBeNull();
    expect(draft?.meta.size).toBeUndefined();
  });
});

/**
 * 「模型提示」读取（2026-09-29 第十四轮 §34）—— **纯诊断用途**。
 *
 * 为什么要有：用户要研究「不同模型 → 创作树登记延迟不同」这个假设（§33 那次误判就是被登记延迟坑的）。
 * 实测这两处提示**都不在成片那一批报文里**（在更早的输入消息 / 任务 ack 里），
 * 所以读取函数必须能在 chain（单块 JSON）与 SSE（`data:` 事件流）两种形态下都工作。
 */
describe('readModelHints（报文里的「本次生成用的模型」）', () => {
  it('chain 形态：两层转义的 chat_ability → ability_param.model', () => {
    expect(readModelHints(JSON.stringify(MODEL_HINT_CHAT_ABILITY))).toEqual({ model: MODEL_HINT_MODEL });
  });

  it('chain 形态：ext.ai_creation_tool_list → 挑出 text_to_video 那条的 req_key', () => {
    expect(readModelHints(JSON.stringify(MODEL_HINT_TASK_ACK))).toEqual({ tool: MODEL_HINT_TOOL });
  });

  it('SSE 形态：从 data: 事件流里同样读得到', () => {
    // 实测 SSE 的形态是「id / event / data 各占一行」（`data:` 不在 id 行里），照此构造
    const sse =
      'id: 7\nevent: STREAM_CHUNK\ndata: ' +
      JSON.stringify(MODEL_HINT_TASK_ACK) +
      '\n\nid: 12\nevent: SSE_REPLY_END\ndata: {"end_type":3}\n\n';
    expect(readModelHints(sse)).toEqual({ tool: MODEL_HINT_TOOL });
  });

  it('两批合起来才凑齐 model 与 tool（每批只带一半 —— 所以页面侧要记住）', () => {
    const first = readModelHints(JSON.stringify(MODEL_HINT_CHAT_ABILITY));
    const second = readModelHints(JSON.stringify(MODEL_HINT_TASK_ACK));
    expect({ ...first, ...second }).toEqual({ model: MODEL_HINT_MODEL, tool: MODEL_HINT_TOOL });
  });

  it('纯图片任务的批次：挑不出 text_to_video 就**不取** tool（§35.8 回归锁）', () => {
    // 旧实现 `(videoEntry ?? entries[0])` 会取到图片流程 `seedream_v50s_flow`，
    // 把图片模型当成视频模型 → 图文混合会话里视频药丸直接算不出来（2026-09-30 实测症状）
    expect(readModelHints(JSON.stringify(MODEL_HINT_IMAGE_ONLY_ACK))).toEqual({});
  });

  it('读不到就返回空对象 —— 不编造', () => {
    expect(readModelHints('')).toEqual({});
    expect(readModelHints('{"code":0,"data":{"children":[]}}')).toEqual({});
    expect(readModelHints('not-json at all')).toEqual({});
    // 结构变了（只有 ability_type、没有 ability_param.model）也不猜：只认实测那两处
    expect(readModelHints('{"chat_ability":"{\\"ability_type\\":17}"}')).toEqual({});
  });
});

/**
 * 模型药丸的**入库侧口径**（2026-09-30 第十五轮 §35.10）。
 *
 * 药丸文案由页面侧在解析后**逐条**算好写进 `raw.modelBadge`（按该资源自己的生成时刻
 * 从模型提示时间线里就近取值），`toDraft` 只负责搬运；模型提示来自**视频生成任务**，
 * 所以只有视频条目该带上它，图片一律不带（宁缺勿假）。
 */
describe('toDraft：模型药丸只写在视频条目上', () => {
  const video: RawMedia = { kind: 'video', vid: 'v1', raw: 'https://cdn.example.com/a.mp4', origin: 'chain' };
  const image: RawMedia = { kind: 'image', raw: 'https://cdn.example.com/a.png', origin: 'chain' };
  const base = { convId: 'c1', convKind: 'chat' as const, convTitle: 't' };

  it('视频条目把 raw.modelBadge 搬进 meta', () => {
    expect(toDraft({ ...video, modelBadge: 'SD-2.5' }, base)?.meta.modelBadge).toBe('SD-2.5');
  });

  it('图片条目即使带了也不写（模型提示来自视频生成任务，对图片不成立）', () => {
    expect(toDraft({ ...image, modelBadge: 'SD-2.5' }, base)?.meta.modelBadge).toBeUndefined();
  });

  it('没拿到药丸文案时字段缺省 —— 界面不显示药丸', () => {
    expect(toDraft(video, base)?.meta.modelBadge).toBeUndefined();
  });
});

/**
 * 模型提示**时间线**（2026-09-30 §35.10）—— 修「同一会话换过模型 → 药丸串味」的关键。
 *
 * 每条提示都要落回**产生它的那条消息**的 `create_time`（秒级，与资源 `createdAt` 同源），
 * 这样页面侧才能按资源自己的时刻就近取用。
 */
describe('readModelTimeline：带时间的模型提示', () => {
  it('单条提示带出它所在消息的 create_time', () => {
    expect(readModelTimeline(JSON.stringify(MODEL_HINT_CHAT_ABILITY))).toEqual([
      { at: 1790690259, model: MODEL_HINT_MODEL },
    ]);
    expect(readModelTimeline(JSON.stringify(MODEL_HINT_TASK_ACK))).toEqual([
      { at: 1790690260, tool: MODEL_HINT_TOOL },
    ]);
  });

  it('同一份报文里的多条提示按时间升序，各自保留自己的值（报文顺序颠倒也能排对）', () => {
    const chain = {
      messages: [
        MODEL_HINT_TASK_ACK.downlink_body.pull_singe_chain_downlink_body.messages[0], // 较晚
        MODEL_HINT_CHAT_ABILITY.downlink_body.pull_singe_chain_downlink_body.messages[0], // 较早
      ],
    };
    expect(readModelTimeline(JSON.stringify(chain))).toEqual([
      { at: 1790690259, model: MODEL_HINT_MODEL },
      { at: 1790690260, tool: MODEL_HINT_TOOL },
    ]);
  });

  it('站点文案也进时间线（§35.11 起的主力来源），并带上自己消息的时间', () => {
    expect(readModelTimeline(JSON.stringify(MODEL_LABEL_MESSAGE))).toEqual([{ at: 1790731700, label: MODEL_LABEL_NAME }]);
    expect(readModelHints(JSON.stringify(MODEL_LABEL_MESSAGE))).toEqual({ label: MODEL_LABEL_NAME });
  });

  it('readModelLabelText 从「本次使用 X 生成」里抓档位名（四种档位与容错）', () => {
    expect(readModelLabelText(MODEL_LABEL_TEXT)).toBe(MODEL_LABEL_NAME);
    expect(readModelLabelText('本次使用 Seedance 2.0 Fast 生成，预计等待 5 分钟。')).toBe('Seedance 2.0 Fast');
    expect(readModelLabelText('本次使用 **Seedance 2.5** 生成')).toBe('Seedance 2.5');
    expect(readModelLabelText('本次使用 Seedance 2.0 生成')).toBe('Seedance 2.0');
    // 老版文案（§35.13）：档位名里带中文后缀，同样要能整段抓出来交给派生层
    expect(readModelLabelText(MODEL_LABEL_LEGACY_TEXT)).toBe(MODEL_LABEL_LEGACY_NAME);
    expect(readModelLabelText('这句里没有那句话')).toBeUndefined();
    expect(readModelLabelText('')).toBeUndefined();
  });

  it('没有提示的报文返回空数组（绝大多数批次都走这条早退路径）', () => {
    expect(readModelTimeline('')).toEqual([]);
    expect(readModelTimeline('{"code":0,"data":{"children":[]}}')).toEqual([]);
  });
});
