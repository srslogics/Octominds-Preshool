import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function csvCell('), source.indexOf('let inventorySearchTimer;'));
function fixture() {
  const calls = [], downloads = [], messages = [];
  let center = 'A';
  const context = vm.createContext({
    inventoryState: {search: '', stockStatus: 'all'}, currentUser: {id: 'test'},
    inventoryBranchId: () => center,
    inventoryPath: (path, params, branch) => ({path, params, branch}),
    apiRequest: async query => {
      calls.push(query); center = 'B';
      return {total: 2, items: [{id: String(query.params.page), name: '=SUM(1,2)', sku: '+cmd', quantity_on_hand: 0}]};
    },
    Blob, URL: {createObjectURL: blob => {downloads.push(blob); return 'blob:test';}, revokeObjectURL: () => {}},
    document: {createElement: () => ({click() {}})}, showToast: (...args) => messages.push(args),
  });
  vm.runInContext(functions, context);
  return {context, calls, downloads, messages};
}
test('CSV escapes formula prefixes, whitespace, quotes and line breaks', () => {
  const {context} = fixture();
  for (const value of ['=1+1', '+cmd', '-cmd', '@SUM(A1)', '  =1', '\tcmd', '\rtext']) {
    assert.ok(context.csvCell(value).startsWith('"\''));
  }
  assert.equal(context.csvCell(-2), '"-2"');
  assert.equal(context.csvCell('say "hi"'), '"say ""hi"""');
});
test('multi-page export freezes center even when selection changes', async () => {
  const {context, calls, downloads} = fixture();
  await context.exportInventory();
  assert.deepEqual(calls.map(q => q.branch), ['A', 'A']);
  assert.equal(downloads.length, 1);
  assert.match(await downloads[0].text(), /'\=SUM/);
});
test('changing catalogue total aborts rather than silently exporting partial data', async () => {
  const {context, downloads, messages} = fixture();
  let page = 0;
  context.apiRequest = async () => ({total: ++page === 1 ? 2 : 3, items: [{id: String(page)}]});
  await context.exportInventory();
  assert.equal(downloads.length, 0);
  assert.match(messages[0][0], /changed during export/);
});
