// 构建前清理 dist / release 目录。仅删除本项目自己的产物目录，绝不动其它路径。
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const dir of ['dist', 'release', '.build-tmp']) {
  const target = path.join(root, dir);
  // 安全护栏：只允许删除项目根目录下的一级子目录
  if (path.dirname(target) !== root) throw new Error(`拒绝删除项目外的路径: ${target}`);
  await rm(target, { recursive: true, force: true });
}

console.log('[clean] dist / release / .build-tmp 已清理');
