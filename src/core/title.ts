/**
 * 会话标题解析的**纯函数**部分（第四轮修订 v2）。
 *
 * ## 实机问题（2026-09-26 20:28）
 * 切换对话后，资源库显示的是**上一个对话**的标题。
 *
 * ## 成因
 * SPA 切换的瞬间，页面上**能读到的标题全都还是上一个会话的**：
 *   - `document.title` 要等站点渲染完才更新（滞后一拍）；
 *   - 会话标题元素可能还挂着旧会话的节点；
 *   - 消息容器里的第一条消息更是上一段对话的内容。
 * 旧实现「读到就锁死」（`titleResolved`），于是一旦读到旧标题，它就永久粘住。
 * 上一版试图用「记住上一个会话的标题」来挡，但那是**一次性**的：
 * 只要中途有一次 `convTitle` 是空的，防护就被解除，旧标题照样漏进来。
 *
 * ## 对策：快照闸门
 * 路由一变，先把「此刻能读到的所有标题候选」记为 `stale` —— 它们属于上一个会话，
 * 一律不可采用；只有当候选中出现**快照之外**的值，才认为站点真的换到新会话了。
 * 这是**不依赖任何状态先后顺序**的判据，比「记住上一个标题」稳。
 *
 * 与 J3「宁缺勿假」同一条原则：宁可显示兜底文案（`豆包对话 <id8>`），
 * 也绝不显示一个错误的会话名。
 */

/** 纯品牌名 */
const BARE_BRAND_RE = /^(豆包|doubao|dola)$/i;

/**
 * 站点**通用标题**（首页 / 加载态 / 分享页），它不是任何具体会话的名字。
 *
 * 实测值（第四轮，`docs/03` §9.9）：`豆包 - 字节跳动旗下 AI 智能助手`、
 * `豆包 · 你的 AI 智能助手`、`豆包`。**这类值必须被当成「没有标题」**，否则会被
 * 当成会话名显示出来 —— 实测就是这样：F5 时 `document.title` 还是空的（快照为空、
 * 闸门失效），稍后它变成通用标题，于是被锁定成了会话名。
 */
const GENERIC_TITLE_RE =
  /^(?:(?:豆包|doubao|dola)\s*[-–—|·,，:：]\s*)?(?:字节跳动旗下\s*)?(?:你的\s*)?(?:ai\s*)?(?:智能助手|人工智能助手)$/i;

/** 是否为「没有信息量」的标题（空 / 纯品牌 / 站点通用名） */
export function isGenericDocTitle(title: string): boolean {
  const value = (title ?? '').trim();
  if (!value) return true;
  return BARE_BRAND_RE.test(value) || GENERIC_TITLE_RE.test(value);
}

/** 去掉站点后缀（`xxx - 豆包` / `xxx | Doubao` / `xxx · dola`）；通用标题返回空串 */
export function cleanDocTitle(raw: string): string {
  const cleaned = (raw ?? '').replace(/\s*[-|·]\s*(豆包|Doubao|dola)\s*$/i, '').trim();
  if (isGenericDocTitle(cleaned)) return '';
  return cleaned;
}

/** 归一化快照：去空、去重、保序 */
export function normalizeTitleSnapshot(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    const value = (text ?? '').trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/** 该候选是否属于「路由切换前就读到的值」（或为空） */
export function isStaleTitle(text: string, stale: readonly string[]): boolean {
  const value = (text ?? '').trim();
  if (!value) return true;
  return stale.includes(value);
}

/** 按优先级从候选里挑第一个「不属于上一个会话」的标题；都没有则返回空串 */
export function pickFreshTitle(candidates: readonly string[], stale: readonly string[]): string {
  for (const candidate of candidates) {
    const value = (candidate ?? '').trim();
    if (value && !isStaleTitle(value, stale)) return value;
  }
  return '';
}
