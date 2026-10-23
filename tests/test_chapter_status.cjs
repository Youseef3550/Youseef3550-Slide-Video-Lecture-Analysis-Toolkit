const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'chapters.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const timers = new Map();
let nextId = 0;
const status = {};
const context = vm.createContext({
    elements: {summaryStatus: status},
    setTimeout(callback, delay) { timers.set(++nextId, {callback, delay}); return nextId; },
    clearTimeout(id) { timers.delete(id); },
});
vm.runInContext(source, context);
context.setSummaryStatus('complete', 'Chapters ready.');
assert.equal(status.hidden, false);
assert.equal(timers.size, 1);
assert.equal([...timers.values()][0].delay, 5000);
[...timers.values()][0].callback();
assert.equal(status.hidden, true, 'Success disappears after five seconds');
timers.clear();
context.setSummaryStatus('complete', 'Saved');
context.setSummaryStatus('generating', 'Still running');
assert.equal(timers.size, 0, 'A previous success cannot hide a running operation');
assert.equal(status.hidden, false);
context.setSummaryStatus('error', 'Failed');
assert.equal(timers.size, 0, 'Errors persist until replaced');
assert.equal(status.hidden, false);
context.setSummaryStatus('complete', 'Saved again');
assert.equal(status.hidden, false);
assert.equal(timers.size, 1);
console.log('PASS: chapter success expires after 5s; running and error states persist');
