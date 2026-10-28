const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodes = [];
function element(tag) {
    const classes = new Set();
    const node = {
        tag, tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, listeners: {}, textContent: '',
        classList: {contains: name => classes.has(name), add: name => classes.add(name)},
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name]; },
        append(...children) {
            for (const child of children) {
                if (child.parentElement) child.parentElement.children =
                    child.parentElement.children.filter(item => item !== child);
                child.parentElement = this;
                this.children.push(child);
            }
        },
        querySelector: selector => selector.includes('.help-content')
            ? node.children.find(child => child.className === 'help-content')
            : node.children.find(child => child.tag === 'summary'),
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
assert.equal(disclosure.children[1].children[0], instruction, 'Help retains the original content');
disclosure.open = true;
disclosure.listeners.keydown({key: 'Escape', stopPropagation() {}});
assert.equal(disclosure.open, false);
assert.equal(disclosure.children[0].focused, true);
context.initContextualHelp(root);
assert.equal(summary.attributes['aria-label'], 'Chapter help', 'Repeated initialization preserves the accessible name');
const label = element('label');
label.textContent = 'Slide changes';
label.matches = selector => selector.includes('label');
label.contains = () => false;
let wrapper;
label.before = row => { wrapper = row; };
const select = element('select');
select.labels = [label];
select.matches = selector => selector.includes('select');
select.contains = () => false;
const positioned = element('details');
positioned.dataset.helpFor = 'adaptiveDetail';
context.document.getElementById = id => id === 'adaptiveDetail' ? select : null;
context.placeContextualHelp(positioned);
assert.equal(wrapper.className, 'help-option');
assert.equal(wrapper.children[0], label, 'Help is paired with the control label, not a row below the select');
assert.equal(wrapper.children[1], positioned);
wrapper.classList.add('help-option');
context.placeContextualHelp(positioned);
assert.equal(wrapper.children.length, 2, 'Repeated placement does not add wrappers');
const hiddenInput = element('input');
hiddenInput.matches = selector => selector.includes('[hidden]');
hiddenInput.previousElementSibling = select;
const hiddenHelp = element('details');
hiddenHelp.previousElementSibling = hiddenInput;
context.placeContextualHelp(hiddenHelp);
assert.equal(wrapper.children[0], label, 'Hidden compatibility inputs do not become help anchors');
assert.equal(wrapper.children[1], hiddenHelp);
const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
assert.match(template, /data-help-for="adaptiveDetail"/);
assert.match(template, /Slide changes and major variations \(recommended\)/);
assert(!template.includes('Slides and major builds'));
console.log('PASS: inline help placement, accessible names, retained content, Escape and repeat initialization');
