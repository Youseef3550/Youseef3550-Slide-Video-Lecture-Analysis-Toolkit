const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let tabOpened = false, focused = false, scrolled = null;
const list = {hidden: true, previousElementSibling: {
    querySelector: () => ({click() { list.hidden = false; }}),
}};
const row = {
    dataset: {start: '3723.125'},
    querySelector: () => ({textContent: 'Matching section'}),
    closest: () => list,
    focus(options) { focused = options.preventScroll; },
};
const container = {querySelectorAll: () => [row]};
const context = vm.createContext({
    elements: {chaptersContainer: container},
    document: {querySelector: () => ({click() { tabOpened = true; }})},
    scrollParent: value => value,
    scrollWithinContainer: (parent, target) => { assert.equal(parent, container); scrolled = target; },
});
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'chapters.js'), 'utf8');
vm.runInContext(source.slice(source.indexOf('export function revealOutlineSearchResult'),
    source.indexOf('function timestampSeconds(')).replace('export ', ''), context);
assert.equal(context.revealOutlineSearchResult({
    kind: 'section', title: 'Matching section', timestamp: 3723.125,
}), row);
assert(tabOpened && focused);
assert.equal(list.hidden, false, 'A collapsed chapter must open to expose its matching section');
assert.equal(scrolled, row);
assert.equal(context.revealOutlineSearchResult({kind: 'section', timestamp: 99}), null,
    'Historical results missing from the current outline must not reveal an unrelated row');
assert.equal(context.revealOutlineSearchResult({kind: 'transcript', timestamp: 3723.125}), null);
console.log('PASS: section results open Chapters, expand, focus and scroll the exact timestamp row');
