// 构建脚本：esbuild 打包 + 静态资源拷贝 + 构建期生成 DNR 规则。
//
// 用法：
//   node scripts/build.mjs           生产构建（压缩）
//   node scripts/build.mjs --watch   开发构建（未压缩 + watch）
//
// 产物：dist/ —— 直接作为「加载解压缩的扩展」的目录。
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const tmpDir = path.join(root, '.build-tmp');

/** 入口清单：[入口 ts 文件, 输出路径（不含扩展名）] */
const ENTRIES = [
  ['src/page/hook.ts', 'dist/page/hook'],
  ['src/content/bridge.ts', 'dist/content/bridge'],
  ['src/bg/service-worker.ts', 'dist/bg/service-worker'],
  // 弹窗即资源库（第五轮起两级窗口合并，不再有独立的 library 入口）
  ['src/ui/popup/popup.ts', 'dist/ui/popup'],
  ['src/ui/debug/debug.ts', 'dist/ui/debug'],
];

/** 需要原样拷贝的静态资源：[源, 目标] */
const STATIC_COPIES = [
  ['src/manifest.json', 'dist/manifest.json'],
  ['src/ui/popup/popup.html', 'dist/ui/popup.html'],
  ['src/ui/debug/debug.html', 'dist/ui/debug.html'],
  ['src/icons', 'dist/icons'],
];

const out = (rel) => path.join(root, rel);

async function buildAll() {
  await esbuild.build({
    entryPoints: ENTRIES.map(([entry, outfile]) => ({ in: out(entry), out: outfile })),
    outdir: root,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome114'],
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: watch ? 'inline' : false,
    minify: !watch,
    logLevel: 'info',
    // iife 下把入口包成函数，避免污染页面全局作用域
    banner: undefined,
  });
}

async function copyStatic() {
  for (const [from, to] of STATIC_COPIES) {
    await mkdir(path.dirname(out(to)), { recursive: true });
    await cp(out(from), out(to), { recursive: true });
  }
}

async function loadContractModule() {
  await mkdir(tmpDir, { recursive: true });
  const bundlePath = path.join(tmpDir, 'rules-gen.mjs');
  await esbuild.build({
    entryPoints: [out('src/build/rules-gen.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node18'],
    logLevel: 'warning',
  });
  return import(pathToFileURL(bundlePath).href);
}

async function generateRules(contract) {
  const rules = contract.buildRules();
  await writeFile(out('dist/rules.json'), JSON.stringify(rules, null, 2) + '\n', 'utf8');
  console.log(`[build] dist/rules.json 已生成（${rules.length} 条规则）`);
}

async function patchManifest(contract) {
  const file = out('dist/manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  const pkg = JSON.parse(await readFile(out('package.json'), 'utf8'));

  // 版本号以 package.json 为单一来源
  manifest.version = pkg.version;

  // 站点匹配规则以 site-contract.ts 为单一来源
  const { hostPermissions, contentScriptMatches } = contract.siteMatchPatterns();
  manifest.host_permissions = hostPermissions;
  for (const entry of manifest.content_scripts ?? []) {
    entry.matches = contentScriptMatches;
  }

  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function main() {
  await rm(out('dist'), { recursive: true, force: true });
  await buildAll();
  await copyStatic();
  const contract = await loadContractModule();
  await patchManifest(contract);
  await generateRules(contract);
  console.log(`[build] 完成，产物位于 dist/（${watch ? '开发模式' : '生产模式'}）`);
}

if (watch) {
  // 开发模式：先跑一次完整构建，再对 JS 入口开 watch
  await main();
  const ctx = await esbuild.context({
    entryPoints: ENTRIES.map(([entry, outfile]) => ({ in: out(entry), out: outfile })),
    outdir: root,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome114'],
    charset: 'utf8',
    sourcemap: 'inline',
    logLevel: 'info',
  });
  await ctx.watch();
  console.log('[build] watch 模式已启动（静态资源改动需重新运行构建）');
} else {
  await main();
  await rm(tmpDir, { recursive: true, force: true });
}

export { main };
