const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static', 'js', 'action-menus.js'), 'utf8');

class Node {
    constructor(parent = null) { this.parentElement = parent; }
}
class Element extends Node {
    constructor(parent, selectorMatch = false) {
        super(parent);
        this.isMenu = selectorMatch;
        this.open = false;
        this.focused = false;
        if (selectorMatch) this.summary = { focus: () => { this.focused = true; } };
    }
    contains(node) {
        for (let current = node; current; current = current.parentElement) if (current === this) return true;
        return false;
    }
    closest() {
        for (let current = this; current; current = current.parentElement) if (current.isMenu) return current;
        return null;
    }
    querySelector() { return this.summary || null; }
}
globalThis.Node = Node;
globalThis.Element = Element;

const page = new Element(null);
const extra = new Element(page, true);
const extraButton = new Element(extra);
const help = new Element(extra, true);
const rowMenu = new Element(page, true);
const rowMenuSummary = new Element(rowMenu);
const outside = new Element(page);
const menus = [extra, help, rowMenu];
const listeners = {};
const doc = {
    addEventListener(type, handler, capture) {
        assert.strictEqual(capture, true, `${type} must use the capture phase`);
        listeners[type] = handler;
    },
    querySelectorAll: () => menus,
};

const moduleSource = source.replace(/export /g, '') + '\nmodule.exports = { initOutsideDismiss };';
const { initOutsideDismiss } = new Function('module', `${moduleSource}; return module.exports;`)({});
initOutsideDismiss(doc);
initOutsideDismiss(doc);

const press = target => listeners.pointerdown({ target, button: 0 });

extra.open = true; help.open = true;
press(extraButton);
assert(extra.open, 'Clicking inside a menu keeps it open');
assert(!help.open, 'A nested help popup closes when clicking elsewhere inside its parent menu');

help.open = true;
press(help);
assert(extra.open && help.open, 'Clicking a nested popup keeps both open');

press(rowMenuSummary);
assert(!extra.open && !help.open, 'Opening another menu closes the previous one, even if it stops propagation');

rowMenu.open = true;
listeners.pointerdown({ target: outside, button: 2 });
assert(rowMenu.open, 'Secondary-button presses do not dismiss menus');
press(outside);
assert(!rowMenu.open, 'Clicking outside closes open menus');

extra.open = true;
let prevented = false;
const escape = { key: 'Escape', target: extraButton, preventDefault() { prevented = true; }, stopPropagation() {} };
listeners.keydown(escape);
assert(!extra.open && extra.focused && prevented, 'Escape closes the open menu and returns focus to its toggle');

extra.open = true; help.open = false;
listeners.keydown({ ...escape, target: help });
assert(!extra.open, 'Escape on a closed nested help closes its open parent menu');

const template = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
assert.match(template, /<details id="extraOptionsMenu" class="extra-options">/);
console.log('PASS: popup menus close on outside clicks and Escape');
