/**
 * 模型标识药丸（2026-09-30 第十五轮；**§35.11 起以站点文案为主来源**）
 * —— **纯函数**：无副作用、不碰 DOM、不读写存储。
 *
 * 把报文里读到的模型提示折算成卡片上那个药丸的文案：`SD-2.5` / `SD-2.0` / `2.0-Fast` / `2.0-Mini`。
 *
 * ⚠️ 三个来源的**可信度不同**（都是实测结论，详见 `site-contract.ts` §2.6）：
 *   ① `label`（站点文案「本次使用 **Seedance 2.0 Mini** 生成」）—— **最可信**，站点自报档位；
 *   ② `model`（`chat_ability.ability_param.model`，用户选的）—— 带 `_std` / `_mini` 后缀可用，
 *      **裸 `seedance_v2.0` 有歧义**（标准版 / Fast / Mini 都用它）；
 *   ③ `tool`（`ai_creation_tool_list[].req_key`）—— **不参与派生**：实测 `seedance_v20_fast_flow`
 *      同时出现在 Fast 与 **Mini** 档位（`0704#mini实验` 12 条全是 Mini 却被标成 2.0-Fast）。
 *
 * 认不出 / 读不到 ⇒ 返回 `undefined`（界面不显示药丸）—— 宁缺勿假。
 */

import {
  MODEL_LABEL_ALIASES,
  MODEL_LABEL_RE,
  MODEL_NAME_RE,
  MODEL_SINGLE_VARIANT_VERSIONS,
  MODEL_STD_SUFFIX,
  MODEL_VARIANT_LABELS,
} from './site-contract';

/** 输入 = 报文里读到的三路模型提示（都可能缺） */
export interface ModelBadgeInput {
  /** 站点文案里的档位名，如 `Seedance 2.0 Mini`（最可信，优先级最高） */
  label?: string;
  /** `chat_ability.ability_param.model`，实测 `seedance_v2.5` / `seedance_v2.0_std` / `seedance_v2.0_mini` */
  model?: string;
  /** `ext.ai_creation_tool_list[].req_key`（**不参与派生**，只作诊断原始值） */
  tool?: string;
}

/** 派生结果：药丸文案 + 悬停用的完整名 */
export interface ModelBadge {
  /** 药丸文案，如 `SD-2.5` */
  short: string;
  /** 完整模型名（与站点文案一致），如 `Seedance 2.0 Fast` —— 只用于悬停说明 */
  full: string;
}

/**
 * 时间线条目（`core/extract/common.ts::readModelTimeline()` 产出的结构）。
 * 这里用**最小结构化类型**，免得 `model-badge` 与 `extract` 互相 import 绕成环。
 */
export interface ModelEventLike {
  /** 提示所在消息的 `create_time`（秒级，与 `RawMedia.createdAt` 同源） */
  at?: number | null;
  label?: string;
  model?: string;
  tool?: string;
}

/**
 * 模型提示 → 药丸文案。读不到 / 认不出 → `undefined`（界面不显示药丸）。
 *
 * 优先级：**站点文案（`label`）> `model` 白名单**。`tool` 刻意不参与（见文件头说明）。
 */
export function modelBadgeOf(input: ModelBadgeInput | null | undefined): ModelBadge | undefined {
  if (!input) return undefined;

  /*
   * ① 站点文案：形态认识就**以它为准**（站点自报档位）。
   * 若文案报了档位但变体不在白名单（站点将来加的新档位）→ **不猜、也不降级**，
   * 免得下面 `model` 又给出一个与文案矛盾的标准版结论。
   */
  const label = input.label?.trim();
  if (label) {
    const match = MODEL_LABEL_RE.exec(label);
    if (match) {
      const version = match[1];
      /*
       * 变体词的三个来源（按顺序）：
       *   ① 文案里直接跟的英文档位词（`Seedance 2.0 Fast` / `Mini`）；
       *   ② **老版别名**：「Seedance 2.0 **全能视频模型**」—— 实测它就是 2.0 Fast（§35.13）；
       *   ③ 都没有 → 标准版。
       */
      const word =
        match[2]?.toLowerCase() ?? MODEL_LABEL_ALIASES.find(([alias]) => label.includes(alias))?.[1];
      if (!word) return standardBadge(version);
      const entry = MODEL_VARIANT_LABELS.find(([key]) => key === word);
      return entry ? variantBadge(version, entry[1]) : undefined;
    }
  }

  // ② `model`：只认带明确后缀（`_std` / `_mini` / …）或**客观单档位**的版本，裸 `seedance_v2.0` 不用
  return badgeFromModel(input.model);
}

/** `seedance_v2.0_std` / `seedance_v2.0_mini` / `seedance_v2.5` → 药丸 */
function badgeFromModel(model?: string): ModelBadge | undefined {
  const value = model?.trim();
  if (!value) return undefined;
  const match = MODEL_NAME_RE.exec(value);
  if (!match) return undefined;
  const version = match[1];
  const suffix = match[2]?.toLowerCase();
  if (!suffix) {
    // 无后缀：实测有歧义（同一个值对应标准版 / Fast / Mini）→ 只有「站点未提供变体的版本」才可用
    return MODEL_SINGLE_VARIANT_VERSIONS.includes(version) ? standardBadge(version) : undefined;
  }
  if (suffix === MODEL_STD_SUFFIX) return standardBadge(version);
  const entry = MODEL_VARIANT_LABELS.find(([key]) => key === suffix);
  return entry ? variantBadge(version, entry[1]) : undefined;
}

/** 标准版：`2.0` → `SD-2.0` */
function standardBadge(version: string): ModelBadge {
  return { short: `SD-${version}`, full: `Seedance ${version}` };
}

/** 变体版：`2.0` + `Fast` → `2.0-Fast`（与用户指定的简称一致） */
function variantBadge(version: string, variant: string): ModelBadge {
  return { short: `${version}-${variant}`, full: `Seedance ${version} ${variant}` };
}

/**
 * 从模型提示**时间线**里挑出「某条资源适用的提示」（2026-09-30 §35.10）。
 *
 * ⚠️ 这是模型药丸正确性的关键：**一个会话里可以换模型**（实测同一会话两条视频分别出自
 * `Seedance 2.0` 与 `Seedance 2.0 Fast`），所以不能拿「最近一次提示」粘给所有条目。
 * 规则：对每个字段**各自独立**地取「时间 ≤ 资源生成时刻」的最后一条 ——
 * 该字段在资源生成之前**还没出现**就不给值（**严格对齐**：不拿「未来」的提示去标过去的资源）；
 * 只有「资源没有生成时刻」时才退到最后一条（兜底）。
 * 三个字段可能来自**不同消息**（`label` / `tool` 在任务 ack 那批、`model` 在用户输入那批），
 * 因此必须分开取，不能只挑其中一条事件。
 */
export function pickModelHintAt(events: ReadonlyArray<ModelEventLike>, at?: number | null): ModelBadgeInput {
  const out: ModelBadgeInput = {};
  const target = typeof at === 'number' && at > 0 ? at : null;
  for (const field of ['label', 'model', 'tool'] as const) {
    const candidates = events.filter((event) => Boolean(event[field]));
    if (!candidates.length) continue;
    let chosen = candidates[candidates.length - 1];
    if (target !== null) {
      // 无时间的候选（消息没带 create_time）视为可用 —— 它们排在最后，只作兜底
      const before = candidates.filter((event) => event.at == null || event.at <= target);
      if (!before.length) continue; // 该字段在资源生成之前还没出现 → 这个字段不给值
      chosen = before[before.length - 1];
    }
    const value = chosen[field];
    if (value) out[field] = value;
  }
  return out;
}
