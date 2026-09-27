// 把 dist/ 打包成 release/doubao-web-uwd-<version>.zip（用系统自带 PowerShell，零依赖）。
import { readFile, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');

try {
  await stat(distDir);
} catch {
  console.error('[zip] dist/ 不存在，请先运行 npm run build');
  process.exit(1);
}

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const zipPath = path.join(releaseDir, `doubao-web-uwd-${pkg.version}.zip`);

await mkdir(releaseDir, { recursive: true });

const script = `Compress-Archive -Path "${distDir}\\*" -DestinationPath "${zipPath}" -Force`;
const code = await new Promise((resolve) => {
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'inherit',
  });
  ps.on('close', resolve);
});

if (code !== 0) {
  console.error('[zip] 打包失败');
  process.exit(1);
}
console.log(`[zip] 已生成 ${path.relative(root, zipPath)}`);
