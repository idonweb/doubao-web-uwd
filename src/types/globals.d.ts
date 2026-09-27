/**
 * 全局类型补充
 * - 允许 side-effect 形式 import CSS（esbuild 会把它们打进 dist/ui/*.css）
 */

declare module '*.css';
