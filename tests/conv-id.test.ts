/**
 * 会话作用域键的**反推**（2026-10-02 §38 多标签页修复新增 `convIdFromUrl`）。
 *
 * 两处依赖它，错一处就会静默分叉：
 *   ① v2→v3 存储迁移把旧条目归位到「仍开着的标签页」；
 *   ② `tabs.onUpdated` 判断该标签页是否**离开了会话**（离开 → 清它的槽）。
 * 所以这里把三类会话页（`/chat/`、`/thread/`、`/video-sharing`）与非会话页都钉住。
 */

import { describe, expect, it } from 'vitest';

import { convIdFromUrl } from '../src/core/site-contract';

describe('convIdFromUrl：URL → 会话作用域键', () => {
  it('对话页 `/chat/<id>` → 纯 id', () => {
    expect(convIdFromUrl('https://www.doubao.com/chat/38443913133942786')).toBe('38443913133942786');
    expect(convIdFromUrl('https://www.doubao.com/chat/38443913133942786?channel=itab2')).toBe('38443913133942786');
    expect(convIdFromUrl('https://www.doubao.com/chat/local_1371803923460589')).toBe('local_1371803923460589');
  });

  it('对话分享页 `/thread/<id>` → 纯 id', () => {
    expect(convIdFromUrl('https://www.doubao.com/thread/xkmLJCEtfJndqzlD4')).toBe('xkmLJCEtfJndqzlD4');
  });

  it('★单条视频分享页 `/video-sharing?share_id=…` → `share_<share_id>`（路径里没有 ID）', () => {
    expect(
      convIdFromUrl(
        'https://www.doubao.com/video-sharing?source_type=mobile&share_id=57139820578269954&video_id=v0269cg10004daamhk27dld2vpu8bbgg',
      ),
    ).toBe('share_57139820578269954');
  });

  it('分享页缺 share_id 时依次退到 creation_id / video_id；三者皆无 → 空串（不编造）', () => {
    expect(convIdFromUrl('https://www.doubao.com/video-sharing?creation_id=c_123')).toBe('share_c_123');
    expect(convIdFromUrl('https://www.doubao.com/video-sharing?video_id=v0abc')).toBe('share_v0abc');
    expect(convIdFromUrl('https://www.doubao.com/video-sharing?source_type=mobile')).toBe('');
  });

  it('★非会话页 → 空串（首页 / 豆包其它页 / 站外 / 非法 URL）', () => {
    expect(convIdFromUrl('https://www.doubao.com/chat')).toBe('');
    expect(convIdFromUrl('https://www.doubao.com/')).toBe('');
    expect(convIdFromUrl('https://www.doubao.com/settings')).toBe('');
    expect(convIdFromUrl('https://example.com/chat/123')).toBe('');
    expect(convIdFromUrl('not a url')).toBe('');
    expect(convIdFromUrl('')).toBe('');
    expect(convIdFromUrl(undefined)).toBe('');
  });

  it('dola.com 同族域同样认（与 isDoubaoHostUrl 同源）', () => {
    expect(convIdFromUrl('https://www.dola.com/chat/abc123')).toBe('abc123');
  });
});
