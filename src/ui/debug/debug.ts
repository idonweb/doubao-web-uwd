/**
 * 诊断页（真机联调用）—— 把「插件为什么没解析到资源」变成一个可复制的报告。
 *
 * 打开方式：弹窗右上角齿轮旁的「诊断」链接，或直接访问
 *   chrome-extension://<扩展ID>/ui/debug.html
 *
 * 它不是控制台，而是**取证工具**：把 page / content / bg 三层的关键事实按时间排好，
 * 一键复制成 JSON 发给开发者，就不必让人工去 DevTools 里翻 SSE 报文了。
 */

import './debug.css';

import { EXT_NAME } from '../../core/constants';
import { getDiag, clearDiag, getState, listLibrary, onDiagChanged } from '../shared/api';
import { esc, fmtClock, resolveTheme, toast } from '../shared/dom';
import { icon } from '../shared/icons';
import type { DiagRecord } from '../../core/diagnostics';
import type { LibraryResponse, StateResponse } from '../../core/types';

const rootEl = document.getElementById('app');
if (!rootEl) throw new Error('#app 不存在');
const root: HTMLElement = rootEl;

let records: DiagRecord[] = [];
let state: StateResponse | null = null;
let lib: LibraryResponse | null = null;

function environmentCard(): string {
  const page = state?.page;
  const injected = page?.injected === true && page.kind !== 'none';
  const libraryCount = lib ? Object.keys(lib.library).length : 0;

  return `<div class="card">
    <h2>当前环境</h2>
    <dl class="kv">
      <dt>扩展</dt><dd>${esc(EXT_NAME)} v${esc(state?.version ?? '-')}</dd>
      <dt>目标标签页</dt><dd>${esc(page?.url || '（未取到）')}</dd>
      <dt>页面类型</dt>
      <dd class="${page?.kind === 'none' ? 'bad' : 'ok'}">${esc(page?.kind ?? '-')}${
        state?.stale ? ' · 内容脚本未注入（需刷新页面）' : ''
      }</dd>
      <dt>会话 ID</dt><dd>${esc(page?.convId || '-')}</dd>
      <dt>会话标题</dt><dd>${esc(page?.title || '-')}</dd>
      <dt>内容脚本</dt><dd class="${injected ? 'ok' : 'bad'}">${injected ? '已注入' : '未应答'}</dd>
      <dt>过滤纯缩略图开关</dt><dd>${state?.config.skipThumbOnly ? '开启' : '关闭'}</dd>
      <dt>资源库条数</dt><dd class="${libraryCount ? 'ok' : 'warn'}">${libraryCount}</dd>
      <dt>诊断记录</dt><dd>${records.length}</dd>
    </dl>
  </div>`;
}

function stepsCard(): string {
  return `<div class="card">
    <h2>取证步骤（照做一遍即可）</h2>
    <div class="steps">
      <ol>
        <li>回到豆包标签页，<b>按 F5 刷新</b>（让内容脚本重新注入并重新挂 hook）。</li>
        <li>刷新后<b>先回来点一次「刷新」</b>，确认「内容脚本 = 已注入」。</li>
        <li>在豆包页<b>新生成一条内容</b>（视频或图片都行），等它生成完。</li>
        <li>回到本页再点「刷新」，看日志里出现了哪些事件：
          <ul>
            <li><code>hook.ready</code> / <code>hook.fetch</code> → 注入与 hook 是否成功</li>
            <li><code>net.fetch</code> / <code>net.xhr</code> → <b>有没有截到 <code>/chat/completion</code></b></li>
            <li><code>parse.sse</code> → 解析出了几条（<code>raws=0</code> 就是字段路径变了）</li>
            <li><code>dom.vidscan</code> → 页面里已有视频的反推结果</li>
            <li><code>vid.step</code> / <code>vid.resolve</code> → 无水印原片三步 API：<code>vid.step</code> 会写清
              <b>哪一步失败、HTTP 状态、耗时与原因</b>（卡片长期停在「解析中」时看这两行）</li>
            <li><code>bg.upsert</code> → 入库结果（<code>skipped</code> 多说明被「过滤纯缩略图」挡了）</li>
          </ul>
        </li>
        <li>点右上角<b>「复制全部」</b>（或<b>「导出 JSON」</b>存成文件），把内容发给我。</li>
      </ol>
      <p>如果日志里完全没有 <code>net.fetch</code>/<code>net.xhr</code>，说明豆包换了别的请求方式或接口路径——
      这时请改用 DevTools 兜底取证：<code>F12 → Network → 筛选 completion → 点开请求 → Response</code>，
      把响应内容（可只发前几行）一并给我。</p>
      <p>本页不是豆包页，插件会<b>自动跟随最近打开的豆包页</b>（见上方「目标标签页」）。若你同时开着多个豆包页，
      请把要看的那一个切到前台，再回本页点「刷新」。</p>
    </div>
  </div>`;
}

function logCard(): string {
  if (!records.length) {
    return `<div class="card"><h2>诊断记录</h2><div class="empty">还没有记录。先按上面的步骤做一遍，再点「刷新」。</div></div>`;
  }

  const rows = [...records]
    .reverse()
    .map((record) => {
      const hasText = Boolean(record.text);
      const body = hasText ? `<pre>${esc(record.text ?? '')}</pre>` : '';
      const tag = hasText ? 'details' : 'div';
      const summary = `<summary>
        <span class="t">${esc(fmtClock(record.t))}</span>
        <span class="src">${esc(record.src)}</span>
        <span class="ev">${esc(record.event)}</span>
        <span class="detail">${esc(record.detail ?? '')}</span>
      </summary>`;
      return `<${tag} class="row ${esc(record.level)}"${tag === 'details' ? '' : ' style="cursor:default"'}>${summary}${body}</${tag}>`;
    })
    .join('');

  return `<div class="card">
    <h2>诊断记录（${records.length} 条，最新在上）</h2>
    <div class="log">${rows}</div>
  </div>`;
}

function render(): void {
  document.documentElement.dataset.theme = resolveTheme(state?.config.theme ?? 'system');
  root.innerHTML = `
    <div class="wrap">
      <div class="head">
        <h1>${icon('alert', 'ic-sm')}诊断（真机联调）</h1>
        <span class="spacer"></span>
        <button class="btn sm" data-act="copy">${icon('copy', 'ic-sm')}复制全部</button>
        <button class="btn sm" data-act="download">导出 JSON</button>
        <button class="btn sm danger" data-act="clear">${icon('trash', 'ic-sm')}清空</button>
        <button class="btn sm primary" data-act="reload">${icon('refresh', 'ic-sm')}刷新</button>
      </div>
      ${environmentCard()}
      ${stepsCard()}
      ${logCard()}
    </div>`;
}

/** 组装可复制的报告：环境摘要在最前，方便一眼判断属于哪一类问题 */
function report(): string {
  const page = state?.page;
  const summary = {
    生成时间: new Date().toLocaleString('zh-CN'),
    扩展版本: state?.version,
    页面类型: page?.kind,
    内容脚本已注入: page?.injected === true && page?.kind !== 'none',
    页面需刷新: state?.stale ?? null,
    会话ID: page?.convId || null,
    会话标题: page?.title || null,
    页面URL: page?.url || null,
    配置: state?.config,
    资源库条数: lib ? Object.keys(lib.library).length : null,
    资源库条目: lib
      ? Object.values(lib.library).map((item) => ({
          id: item.id,
          kind: item.kind,
          state: item.state,
          variants: item.variants.length,
          primary: item.primary.slice(0, 120),
        }))
      : null,
    诊断记录数: records.length,
  };
  return JSON.stringify({ summary, records }, null, 2);
}

async function reload(): Promise<void> {
  // follow=true：本页自己就是 active tab，不让 bg 跟随的话环境卡片永远是 none（docs/03 §3 缺陷 2）
  const [diag, st, library] = await Promise.all([getDiag(), getState({ follow: true }), listLibrary()]);
  records = diag;
  state = st;
  lib = library;
  render();
}

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;

  if (act === 'reload') {
    void reload().then(() => toast('已刷新'));
    return;
  }

  if (act === 'copy') {
    void navigator.clipboard
      .writeText(report())
      .then(() => toast('已复制，粘贴给我即可'))
      .catch(() => toast('复制失败，请用「导出 JSON」', true));
    return;
  }

  if (act === 'download') {
    const blob = new Blob([report()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `uwd-diag-${Date.now()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }

  if (act === 'clear') {
    void clearDiag().then(() => reload()).then(() => toast('诊断记录已清空'));
  }
});

onDiagChanged(() => {
  void getDiag().then((next) => {
    records = next;
    render();
  });
});

void reload();
