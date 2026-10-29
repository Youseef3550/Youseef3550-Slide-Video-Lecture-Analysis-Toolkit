const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function node() {
    const classes = new Set();
    return {
        attrs: {}, children: [], disabled: false, isConnected: true,
        classList: {add: name => classes.add(name), remove: name => classes.delete(name)},
        getAttribute(name) { return this.attrs[name] ?? null; },
        setAttribute(name, value) { this.attrs[name] = value; },
        removeAttribute(name) { delete this.attrs[name]; },
        set innerHTML(value) { this.html = value; this.children = []; this.icon = {className: ''}; },
        get innerHTML() { return this.html; },
        querySelector() { return this.icon; },
        appendChild(child) { this.children.push(child); child.parent = this; },
        contains(child) { return this.children.includes(child); },
        remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
    };
}
const timers = new Map();
let next = 0;
const context = vm.createContext({
    document: {createElement: node}, Date,
    setInterval: fn => { timers.set(++next, fn); return next; },
    clearInterval: id => timers.delete(id),
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'progress-time.js'), 'utf8')
    .replace(/^export /gm, ''), context);
const button = node();
button.innerHTML = 'Merge clips';
button.setAttribute('aria-label', 'Merge clips');
const stop = context.startProcessButton(button, 'Merging clips');
assert.equal(button.icon.className, 'fas fa-spinner fa-spin');
assert.equal(button.disabled, true, 'No stop control is offered before cancellation is available');
assert.equal(button.attrs['aria-busy'], 'true');
assert(!button.children[0].textContent.includes('%'), 'Indeterminate work must not invent a percentage');
assert.equal(timers.size, 1);
stop.update({cancellable: true, percent: 25});
assert.equal(button.icon.className, 'fas fa-stop');
assert.equal(button.disabled, false);
assert.equal(button.children[0].textContent, 'Merging clips 25%');
assert.equal(button.attrs['aria-label'], 'Stop merging clips');
stop.update({stopping: true});
assert.equal(button.disabled, true);
assert.equal(button.icon.className, 'fas fa-spinner fa-spin');
stop.update({stopping: false, percent: null});
assert.equal(button.disabled, false, 'A failed stop request can be retried');
assert.equal(button.children[0].textContent, 'Merging clips');
stop();
assert.equal(button.innerHTML, 'Merge clips');
assert.equal(button.attrs['aria-busy'], undefined);
assert.equal(button.attrs['aria-label'], 'Merge clips');
assert.equal(button.disabled, false);
assert.equal(timers.size, 0);
const older = context.startProcessButton(button, 'Working');
const newer = context.startProcessButton(button, 'Working again', {cancellable: true});
older();
assert.equal(timers.size, 1, 'An old cleanup cannot remove the next operation');
assert.equal(button.disabled, false);
newer();
assert.equal(button.innerHTML, 'Merge clips');
assert.equal(timers.size, 0);
console.log('PASS: consistent spinner/stop icon, real progress, disabled/stopping/error states, accessibility and cleanup');
