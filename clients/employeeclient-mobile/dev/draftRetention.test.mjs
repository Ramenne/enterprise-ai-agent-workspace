import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { ref } from 'vue';

const source = await readFile(new URL('../src/session/drafts.ts', import.meta.url), 'utf8');
const body = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');

function fixture(storage = new Map()) {
  const denied = new Set();
  let failWrite = false;
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { if (failWrite) throw Error('quota'); storage.set(key, String(value)); },
    removeItem: key => storage.delete(key),
  };
  const api = new Function('ref', 'personalDenied', 'clearPendingWrites', 'localStorage', body +
    '\nreturn { loadDrafts, listDrafts, saveDraft, deleteDraft, clearDrafts };')(
    ref, account => denied.has(account), () => {}, localStorage);
  const draft = (id, scope = 'personal') => ({ id, scope, project_id: 'p', intake_kind: 'problem', title: id,
    detail: '', severity: 'normal', updatedAt: 1 });
  return { ...api, storage, denied, draft, setFailWrite: v => { failWrite = v; } };
}

test('an app-code reload keeps both personal drafts under the same account', () => {
  const oldCode = fixture();
  oldCode.saveDraft('a', oldCode.draft('one'));
  oldCode.saveDraft('a', oldCode.draft('two'));
  const newCode = fixture(oldCode.storage); // 新模块实例，同一 Android WebView 存储。
  assert.deepEqual(newCode.loadDrafts('a').map(d => d.id), ['two', 'one']);
  assert.equal(JSON.parse(newCode.storage.get('qn.drafts.a')).length, 2);
});

test('a temporary personal scope barrier never overwrites hidden drafts through company save/delete', () => {
  const f = fixture();
  f.saveDraft('a', f.draft('one'));
  f.saveDraft('a', f.draft('two'));
  f.denied.add('a');
  assert.deepEqual(f.listDrafts('a'), []);
  f.saveDraft('a', f.draft('offline-note'));
  f.saveDraft('a', f.draft('company', 'company'));
  assert.deepEqual(f.loadDrafts('a').map(d => d.id), ['company']);
  f.deleteDraft('a', 'company');
  assert.deepEqual(f.loadDrafts('a'), []);
  f.denied.delete('a');
  assert.deepEqual(f.loadDrafts('a').map(d => d.id), ['offline-note', 'two', 'one']);
});

test('storage failure and corrupt data are reported without claiming save or replacing original bytes', () => {
  const f = fixture();
  f.saveDraft('a', f.draft('one'));
  const original = f.storage.get('qn.drafts.a');
  f.setFailWrite(true);
  assert.throws(() => f.saveDraft('a', f.draft('two')), /quota/);
  assert.equal(f.storage.get('qn.drafts.a'), original);
  f.setFailWrite(false);
  f.storage.set('qn.drafts.a', '{broken');
  assert.throws(() => f.loadDrafts('a'), /无法读取/);
  assert.throws(() => f.saveDraft('a', f.draft('two')), /无法读取/);
  assert.equal(f.storage.get('qn.drafts.a'), '{broken');
});
