import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('company work shortcuts keep feedback/review only and announcements live in chat header', () => {
  const work = source('../src/ui/views/WorkHomeView.vue');
  assert.doesNotMatch(work, /to:\s*\{\s*name:\s*'announcements'/);
  const chat = source('../src/ui/views/ChatView.vue');
  assert.doesNotMatch(chat, /<h1>工作群<\/h1>/);
  assert.match(chat, /name="megaphone"/);
  assert.match(chat, /member-count/);
  assert.match(chat, /成员状态同步中/);
});

test('notification long press copies only the authoritative dynamic number', () => {
  const notifications = source('../src/ui/views/NotificationsView.vue');
  assert.match(notifications, /const label = `#\$\{n\.worklog_id\}`/);
  assert.match(notifications, /navigator\.clipboard\.writeText\(label\)/);
  assert.doesNotMatch(notifications, /task_id.*clipboard|sha256.*clipboard/i);
});

test('announcement detail shows read counts without member online roster', () => {
  const announcement = source('../src/ui/components/AnnouncementOverlay.vue');
  const template = announcement.match(/<template>([\s\S]*?)<\/template>/)?.[1] || '';
  assert.match(template, /已读 \{\{ ann\.read_count \}\} 人<\/button>[\s\S]*?未读 \{\{ ann\.unread_count \}\} 人/);
  assert.doesNotMatch(template, /announcement-audience-list|member\.online/);
});
