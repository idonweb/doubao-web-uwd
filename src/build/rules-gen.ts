// 构建期入口：把「站点私有契约」投影到 manifest 与 DNR 规则上，
// 保证 site-contract.ts 是这些常量的唯一来源（方案 §3.5）。
// 由 scripts/build.mjs 用 esbuild 打成 Node ESM 后 import 执行。
import { buildDnrRules } from '../core/media-url';
import { DOUBAO_URL_PATTERNS, HOST_PERMISSIONS } from '../core/site-contract';

export function buildRules() {
  return buildDnrRules();
}

/** manifest 里与站点相关的字段（host_permissions / content_scripts.matches） */
export function siteMatchPatterns() {
  return {
    hostPermissions: [...HOST_PERMISSIONS],
    contentScriptMatches: [...DOUBAO_URL_PATTERNS],
  };
}
