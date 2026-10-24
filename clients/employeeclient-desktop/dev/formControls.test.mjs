import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/ui/', import.meta.url));
const components = join(root, 'components');
const views = join(root, 'views');
const read = path => readFileSync(path, 'utf8');

test('all EmployeeClient view and form dropdowns use the shared choice control', () => {
  for (const folder of [components, views]) {
    for (const name of readdirSync(folder).filter(file => file.endsWith('.vue'))) {
      // Calendar year/month use native numeric selectors inside the native dialog.
      if (name === 'ChatDatePicker.vue') continue;
      assert.doesNotMatch(read(join(folder, name)), /<(?:select|option)\b/i, name);
    }
  }
  const ids = [
    ['AnnouncementFormOverlay.vue', 'qn-ann-pri'],
  ];
  for (const [name, id] of ids) {
    assert.match(read(join(components, name)), new RegExp(`<ChoiceSelect\\s+id="${id}"`), `${name} ${id}`);
  }
});

test('focus feedback stays inside controls and removes the original blue ring', () => {
  const css = read(join(root, 'styles/app.css'));
  assert.match(css, /button:focus-visible[^{}]*\{\s*outline:\s*none;\s*box-shadow:\s*inset/);
  assert.doesNotMatch(read(join(root, 'styles/base.css')), /outline:3px solid #72b5d2/);
  assert.match(css, /\[tabindex\]:focus-visible/);
  assert.match(css, /\.form-field > \.choice-select \.choice-select-menu \{ position: static/);
});
