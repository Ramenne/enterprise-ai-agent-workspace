import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/ui/components/AnnouncementOverlay.vue', import.meta.url), 'utf8');
const template = source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'));

test('announcement detail keeps read counts and removes self-list action controls', () => {
  assert.match(template, /已读 \{\{ ann\.read_count \}\} 人<\/button>[\s\S]*?未读 \{\{ ann\.unread_count \}\} 人/);
  assert.doesNotMatch(template, /从我的列表删除|仅自己/);
  assert.doesNotMatch(template, /announcement-audience-list|member\.online/);
});
