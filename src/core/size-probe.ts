/**
 * 「实测文件字节数」的**调度规则** —— 纯函数，全部可单测（2026-10-02 第十七轮 §37）。
 *
 * 背景（`docs/03` §37）：体积的首选来源是创作树节点 `size`，树里没有的条目（候选流 /
 * 超期条目 / 图片）只能由 background 对**当前下载地址** `primary` 发一次
 * `Range: bytes=0-0` 实测（`bg/service-worker.ts::measureBytes`）。原先的调度有两个毛病：
 *
 *   ① **只测「已定局」的条目**（`state === 'pending'` 一律跳过）——
 *      于是「解析中」这一段（分享页 20~30s、新作品可达数分钟）**必然没有体积**，
 *      哪怕那个候选流文件此刻就能量出来（用户实测：另一款插件能立即给出正确大小）。
 *   ② **一个条目在一个 SW 生命周期里只测一次**（`probedSizeIds.add()` 记在**测量之前**，
 *      失败也算「测过」）—— 一次网络不顺（8s 超时 / 403 / 读不到头）就永久空白；
 *      而 `primary` 换成另一个文件时又会清掉旧体积（`library-store.ts` 的 `primaryChanged`），
 *      清掉之后仍然不会再测 → 实机表现就是「体积时有时无、过一会儿又没了」。
 *
 * 现在的规则（用户 2026-10-02 拍板）：
 *   · **入库即测**：不再看 `state`，只要当前地址是可取的 http(s) 且还没量过就测；
 *   · **按「条目 + 阶段 + 归一化地址」记账**：地址换了（= 换了一个文件）就是另一笔账，允许重测；
 *     「解析中 → 定局」也算另一笔（否则解析中的失败额度会吃掉定局时的补测，见 `sizeProbeKey`）；
 *   · **失败只重试 1 次**（`LIMITS.SIZE_PROBE_RETRY`），仍失败就等 F5 重解析，绝不轮询
 *     （踩坑 21 的死循环教训：无上限重试会把限流喂着永不恢复）；
 *   · 量到就写进 `meta.size`（`needsSizeProbe` 见它有值即跳过）—— **成功不需要记账**。
 *
 * ⚠️ 2026-10-02 §39 追加两条（实机「`3.0 MB` 少了『预览』二字」）：
 *   · 数字必须**随身携带归属**：写入时按「测量那一刻 `primary` 是原片还是候选流」打
 *     `meta.sizeFor`（见 `bg::backfillSizes`）—— 因为 `primary` 从候选流切到原片是异步的，
 *     实测可能在切换**之后**才写回，光靠 `primaryIsRaw()` 现场推断会把候选流的数字当成原片体积；
 *   · **允许「升级测量」**：原片已就绪但手里只有预览体积时（`needsRawSizeUpgrade`）仍值得测一次，
 *     否则要干等创作树真值（实机等了 ~15 分钟）。仍受同一套额度约束。
 *
 * ⚠️ 2026-10-02 §41 追加（实机「预览 → 原片要等 ~39s」）：
 *   · **写回守卫**：探测在飞期间创作树真值先落库时，迟到的预览实测值**不得**降级覆盖
 *     （`probeWriteBlocked`）—— 否则真值被打回预览体积，而升级测量没有自触发，只能等下一次入库；
 *   · **升级补测自触发**：写回「预览体积」且条目已原片就绪时，排一个一次性延迟补测
 *     （`SIZE_PROBE_UPGRADE_DELAY_MS`），兑现「~1s 内翻正」的承诺，不再等下一次 upsert。
 *
 * ⚠️ 归一化必须用 `normalizeUrl()`（去掉查询段）：站点的播放地址是**带时效签名**的，
 * 同一条流每次换签名都会得到不同的字符串，那是「同一个文件的又一份签名」而不是换了文件。
 */

import { LIMITS } from './constants';
import { rawReady, sizeForNow, sizeForOf } from './library-store';
import { normalizeUrl } from './media-url';
import type { MediaItem } from './types';

/** 记账键：条目 id + **阶段**（解析中 / 已定局）+ 归一化后的当前下载地址 —— 每笔账各自独立 */
export function sizeProbeKey(item: Pick<MediaItem, 'id' | 'primary' | 'state'>): string {
  /*
   * ⚠️ 为什么键里要有「阶段」（2026-10-02 §37 补的边界）：
   * 「入库即测」把第一次尝试提前到 `pending`，若那一次 + 它的重试**恰好都撞上 CDN 抖动**，
   * 额度就用完了 —— 而 `LibraryExpire`（定局那一刻）的补测会被额度吃掉，
   * 于是又回到「体积时有时无」，正好是本轮要修的病。
   * 「解析中 → 定局」是一次**新信息**（这个文件已经定下来了），允许另开一轮（仍各自只重试 1 次）——
   * 每个条目最多 4 个请求，有界、不轮询。
   */
  const stage = item.state === 'pending' ? 'pending' : 'settled';
  return `${item.id}::${stage}::${normalizeUrl(item.primary) || item.primary}`;
}

/** 单个文件最多尝试几次（首次 + 重试） */
export function maxProbeAttempts(): number {
  return 1 + Math.max(0, LIMITS.SIZE_PROBE_RETRY);
}

/**
 * 「原片已经就绪，但手里只有**预览体积**」→ 值得再测一次（2026-10-02 §39）。
 *
 * 场景（实机）：入库时量的是带水印候选流（3.0 MB），原片变体随后就位 —— 若就此打住，
 * 卡片会长期显示「预览 3.0 MB」等创作树真值（实机等了 ~15 分钟才变成 7.1 MB）。
 * 允许升级测量后，通常 1s 内就有原片字节数。
 *
 * ⚠️ 不会失控：仍然走同一套「条目 + 阶段 + 归一化地址」记账与 `SIZE_PROBE_RETRY` 额度
 * （最多再两次请求）；而且只在**原片确实已就绪**时才触发（`rawReady`：`state === 'raw'` 或
 * primary 是 `isRaw` 变体，两个证据任一成立）——「原片不可得 / 已超期」的条目不满足条件，不会重复测。
 *
 * ⚠️ 判据**必须**用 `rawReady()` 而不是 `primaryIsRaw()`（实机 bug，`docs/03` §39.6）：
 * 只用后者时，条目在「原片已解析、变体关系尚未稳定」的窗口会被判成未就绪 → 升级测量被跳过 →
 * 卡片一直停在「预览 1.7 MB」（诊断：`成功 3 条（原片 1 / 预览体积 2）`，之后再无测量记录）。
 */
export function needsRawSizeUpgrade(item: MediaItem): boolean {
  return sizeForOf(item) !== 'raw' && rawReady(item);
}

/** 该条目此刻还值得测体积吗（地址不可取 / 额度用完 → 否；体积已有但归属不对 → 仍要） */
export function needsSizeProbe(item: MediaItem, attempts: ReadonlyMap<string, number>): boolean {
  const hasSize = item.meta.size !== undefined;
  if (hasSize && !needsRawSizeUpgrade(item)) return false;
  if (!/^https?:/i.test(item.primary)) return false;
  return (attempts.get(sizeProbeKey(item)) ?? 0) < maxProbeAttempts();
}

/**
 * 写回守卫（2026-10-02 §41）：**预览实测值不得降级创作树真值**。
 *
 * 场景（实机 17:21~17:22，体感「预览 → 原片要等 ~39s」）：「入库即测」的探测批次起飞时
 * 条目还是 `pending`＋预览地址；探测在飞的 ~1s 里，vid 三步解析完成，**携带创作树 `size`
 * （真值）的 raw 草稿先落库**；随后探测按旧快照写回 `{ size: 预览字节, sizeFor: 'preview' }`
 * —— 无条件覆盖，把到手的真值打回「预览体积」。而升级测量只挂在「下一次 upsert」上，
 * 用户不动界面就没有下一次 → 卡片长期停在「预览 5.1 MB」（诊断样本：
 * `mjq0a8qg→5.1MB(预览)`，之后再无 `bg.size` 记录）。
 *
 * 规则：本次实测的归属（`sizeForNow(item)`，按快照地址定）是**预览**、而条目当前已拿着
 * **原片归属**的体积（`sizeForOf(current) === 'raw'`，只可能来自创作树或更早的原片实测）
 * → 这次写回是降级，必须跳过。反向（实测归属是原片）永远放行 —— 那正是升级测量本身。
 */
export function probeWriteBlocked(item: MediaItem, current: MediaItem): boolean {
  return sizeForNow(item) !== 'raw' && current.meta.size !== undefined && sizeForOf(current) === 'raw';
}

/** 记一次尝试（**必须在发请求之前调用**，避免并发重复探测），返回这是第几次 */
export function recordProbeAttempt(attempts: Map<string, number>, item: MediaItem): number {
  const key = sizeProbeKey(item);
  const used = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, used);
  return used;
}

/** 第 `used` 次尝试失败后还该不该排重试（只重试 `LIMITS.SIZE_PROBE_RETRY` 次） */
export function canRetryProbe(used: number): boolean {
  return used <= LIMITS.SIZE_PROBE_RETRY;
}
