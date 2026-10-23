const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodes = [];
function element(tag) {
    const classes = new Set();
    const node = {
        tag, children: [], dataset: {}, attributes: {}, listeners: {}, textContent: '',
        classList: {contains: name => classes.has(name), add: name => classes.add(name)},
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name]; },
        append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } },
        querySelector: () => node.children.find(child => child.tag === 'summary'),
        addEventListener(name, handler) { this.listeners[name] = handler; },
        focus() { this.focused = true; },
    };
    nodes.push(node);
    return node;
}
const help = element('details'), summary = element('summary');
summary.textContent = '? Chapter help';
help.append(summary);
const instruction = element('small');
instruction.textContent = 'Original video stays unchanged.';
instruction.closest = () => null;
instruction.matches = () => false;
instruction.before = node => { instruction.wrapper = node; };
const root = {
    querySelectorAll: selector => selector.startsWith('details.ui-disclosure') ? [summary]
        : selector === 'details.contextual-help' ? nodes.filter(node => node.className === 'contextual-help'
            || node.classList.contains('contextual-help')) : instruction.wrapper ? [] : [instruction],
};
const context = vm.createContext({document: {createElement: element}});
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'contextual-help.js'), 'utf8')
    .replace(/^export /gm, '');
vm.runInContext(source, context);
context.initContextualHelp(root);
assert.equal(summary.textContent, '?');
assert.equal(summary.attributes['aria-label'], 'Chapter help');
assert(help.classList.contains('contextual-help'));
const disclosure = instruction.wrapper;
assert.equal(disclosure.open, undefined, 'Disclaimers start collapsed');
assert.equal(disclosure.children[0].textContent, '?');
assert.equal(disclosure.children[1], instruction, 'Help retains the original content');
disclosure.open = true;
disclosure.listeners.keydown({key: 'Escape', stopPropagation() {}});
assert.equal(disclosure.open, false);
assert.equal(disclosure.children[0].focused, true);
context.initContextualHelp(root);
assert.equal(summary.attributes['aria-label'], 'Chapter help', 'Repeated initialization preserves the accessible name');
console.log('PASS: quiet question-mark help, accessible names, collapsed disclaimers, Escape and repeat initialization');
