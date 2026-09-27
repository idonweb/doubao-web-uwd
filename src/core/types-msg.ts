/** 消息信封类型（单独成文件，避免 types.ts 与 messaging.ts 循环依赖） */

export type SrcTag = 'page' | 'content' | 'ui' | 'bg';

export interface Envelope<T = unknown> {
  /** 信封版本 */
  v: 1;
  /** 发送方所在世界 */
  src: SrcTag;
  /** 消息类型，取值来自 constants.MSG */
  type: string;
  payload?: T;
}
