import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(decodeURIComponent(new URL('..', import.meta.url).pathname));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('chat layout follows the visual viewport and re-anchors after keyboard resize', () => {
  const viewport = read('src/platform/chatViewport.ts');
  const chat = read('src/ui/views/ChatView.vue');
  const css = read('src/ui/styles/ui-v2.css');
  assert.match(viewport, /visualViewport/);
  assert.match(viewport, /--qn-visual-viewport-height/);
  const shared=read('src/ui/useConversationViewport.ts');
  assert.match(chat, /useConversationViewport\(stream,input\)/);
  assert.match(shared,/setTimeout\([\s\S]*?180/);
  assert.match(shared, /visualViewport\?\.addEventListener\('resize',viewport\)/);
  assert.match(chat, /scrollToLatest/);
  assert.match(css, /height: var\(--qn-visual-viewport-height/);
  assert.match(css, /\.shell-chat \.chat-stream \{ flex: 1 1 auto/);
});

test('Android shell asks the system to resize rather than pan above the keyboard', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:windowSoftInputMode="adjustResize"/);
});
