const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'main.js'), 'utf8');
const start = source.indexOf('    const navigationControls =');
const end = source.indexOf("    bind(elements.chapterGrouping, 'change'", start);
const saved = new Map([['lectureseek-navigation-kinds', '["sections","slides"]']]);
function setup() {
    const ids = Object.fromEntries(['navigateChapters', 'navigateSections', 'navigateSlides', 'navigationGrouping']
        .map(id => [id, {listeners: {}, focus() { this.focused = true; }}]));
    ids.navigationGrouping.querySelector = () => ids.navigationGrouping;
    ids.navigationGrouping.contains = target => Object.values(ids).includes(target);
    const events = {}, state = {navigationKinds: ['chapters'], chapterGrouping: 'topic'};
    let refreshes = 0;
    const context = vm.createContext({
        state,
        localStorage: {getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value)},
        document: {getElementById: id => ids[id], addEventListener: (name, fn) => { events[name] = fn; }},
        bind: (element, name, fn) => { element.listeners[name] = fn; },
        updateChapterCaptions: () => refreshes++,
        showNotification: message => { throw new Error(message); },
    });
    vm.runInContext(source.slice(start, end), context);
    return {ids, state, events, refreshes: () => refreshes};
}
const first = setup();
assert.equal(first.ids.navigateChapters.checked, false);
assert.equal(first.ids.navigateSections.checked, true);
assert.equal(first.ids.navigateSlides.checked, true);
first.ids.navigateChapters.checked = true;
first.ids.navigateChapters.listeners.change();
assert.equal(JSON.stringify(first.state.navigationKinds), '["chapters","sections","slides"]');
assert.equal(first.state.chapterGrouping, 'topic');
assert.equal(first.refreshes(), 1);
const second = setup();
assert.equal(second.ids.navigateChapters.checked, true, 'Checkbox choices survive reinitialization');
second.ids.navigationGrouping.open = true;
second.ids.navigationGrouping.listeners.keydown({key: 'Escape', stopPropagation() {}});
assert.equal(second.ids.navigationGrouping.open, false);
assert.equal(second.ids.navigationGrouping.focused, true);
second.ids.navigationGrouping.open = true;
second.events.click({target: second.ids.navigateSections});
assert.equal(second.ids.navigationGrouping.open, true, 'Checkbox changes keep the menu open');
second.events.click({target: {}});
assert.equal(second.ids.navigationGrouping.open, false);
for (const id of ['navigateChapters', 'navigateSections', 'navigateSlides']) second.ids[id].checked = false;
second.ids.navigateSlides.listeners.change();
assert.equal(JSON.stringify(second.state.navigationKinds), '[]');
console.log('PASS: navigation checkbox persistence, combined/empty selections, Escape, outside click and independent grouping');
