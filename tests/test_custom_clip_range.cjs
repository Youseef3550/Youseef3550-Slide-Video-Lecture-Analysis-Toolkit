const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
    return {
        value: '', style: {}, listeners: {}, attributes: {}, classList: {add() {}, remove() {}},
        addEventListener(name, callback) { this.listeners[name] = callback; },
        setAttribute(name, value) { this.attributes[name] = value; },
        getBoundingClientRect() { return {left: 10, width: 600}; },
        focus() { this.focused = true; },
        setPointerCapture(id) { this.capture = id; },
        hasPointerCapture(id) { return this.capture === id; },
        releasePointerCapture() { this.capture = null; },
    };
}
const ids = Object.fromEntries(['videoProgress', 'customClipRange', 'customClipRangeSelection',
    'customClipStatus', 'customClipStart', 'customClipEnd', 'customClipStartMarker',
    'customClipEndMarker', 'customClipSetStartBtn', 'customClipSetEndBtn', 'customClipMarkBtn'].map(id => [id, element()]));
const context = vm.createContext({document: {getElementById: id => ids[id]}});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'custom-clip-range.js'), 'utf8')
    .replace(/^export /gm, ''), context);
const player = {duration: 60.125, currentTime: 12.345};
const controls = context.initCustomClipRange(player);
const start = ids.customClipStartMarker;
const end = ids.customClipEndMarker;
const event = overrides => ({button: 0, pointerId: 1, preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }, ...overrides});
controls.open();
assert.equal(ids.customClipStart.value, '00:00:12.345');
assert.equal(ids.customClipEnd.value, '00:01:00.125');
assert.equal(ids.customClipRange.hidden, false);
assert.equal(start.attributes['aria-valuetext'], '00:00:12.345');
assert.equal(ids.customClipMarkBtn.hidden, false);
assert.equal(ids.customClipMarkBtn.textContent, 'Start here');
player.currentTime = 20.125;
ids.customClipMarkBtn.listeners.click();
assert.equal(ids.customClipStart.value, '00:00:20.125');
assert.equal(ids.customClipMarkBtn.textContent, 'End here');
assert.equal(player.currentTime, 20.125, 'Capturing does not seek or pause playback');
player.currentTime = 19;
ids.customClipMarkBtn.listeners.click();
assert.equal(ids.customClipMarkBtn.textContent, 'End here');
assert.match(ids.customClipStatus.textContent, /after the clip start/);
assert.equal(ids.customClipEnd.value, '00:01:00.125', 'An invalid end must not be silently clamped');
player.currentTime = 35.750;
ids.customClipMarkBtn.listeners.click();
assert.equal(ids.customClipEnd.value, '00:00:35.750');
assert.equal(ids.customClipMarkBtn.textContent, 'Start here');
player.currentTime = 40;
ids.customClipMarkBtn.listeners.click();
assert.equal(ids.customClipStart.value, '00:00:40');
assert.equal(ids.customClipEnd.value, '00:01:00.125', 'A new capture resets the old end');
controls.close();
assert.equal(ids.customClipMarkBtn.hidden, true);
assert.equal(ids.customClipMarkBtn.textContent, 'Start here');
player.currentTime = 12.345;
controls.open();
assert.equal(context.clipSeconds('01:02:03.125'), 3723.125);
for (const input of ['wrong', '-00:01', '00:60', '00:00:99', '1', '00:01.1234']) {
    assert(Number.isNaN(context.clipSeconds(input)), input);
}
const down = event();
start.listeners.pointerdown(down);
assert(down.stopped && down.prevented, 'Dragging does not trigger timeline seeking');
start.listeners.pointermove(event({clientX: 310}));
assert.equal(ids.customClipStart.value, '00:00:30.063');
assert.equal(player.currentTime, 30.063, 'Preview the marker frame');
start.listeners.pointermove(event({clientX: 1000}));
assert(context.clipSeconds(ids.customClipStart.value) < context.clipSeconds(ids.customClipEnd.value),
    'Start marker cannot cross the end marker');
start.listeners.pointerup(event());
assert.equal(start.capture, null);
start.listeners.keydown(event({key: 'Home'}));
assert.equal(ids.customClipStart.value, '00:00:00');
start.listeners.keydown(event({key: 'ArrowRight', shiftKey: true}));
assert.equal(ids.customClipStart.value, '00:00:10');
start.listeners.keydown(event({key: 'ArrowRight', altKey: true}));
assert.equal(ids.customClipStart.value, '00:00:10.100');
end.listeners.pointerdown(event());
end.listeners.pointermove(event({clientX: -200}));
assert.equal(ids.customClipEnd.value, '00:00:10.101', 'End cannot cross the start');
end.listeners.pointercancel(event());
end.listeners.keydown(event({key: 'End'}));
assert.equal(ids.customClipEnd.value, '00:01:00.125');
player.currentTime = 25.75;
ids.customClipSetEndBtn.listeners.click();
assert.equal(ids.customClipEnd.value, '00:00:25.750');
ids.customClipStart.value = '00:15.250';
ids.customClipStart.listeners.input();
assert.equal(start.attributes['aria-valuenow'], '15.25', 'Typed timestamps reposition markers');
assert.equal(ids.customClipRangeSelection.style.left, `${100 * 15.25 / 60.125}%`);
assert(controls.validate());
ids.customClipStart.value = 'bad';
ids.customClipStart.listeners.input();
assert.equal(ids.customClipRange.hidden, true);
assert.equal(controls.validate(), false);
assert.match(ids.customClipStatus.textContent, /valid start/);
ids.customClipStart.value = '00:30';
ids.customClipEnd.value = '00:20';
assert.equal(controls.validate(), false);
ids.customClipEnd.value = '01:01';
assert.equal(controls.validate(), false, 'Out-of-duration values cannot be submitted');
controls.open();
start.listeners.pointerdown(event());
controls.close();
assert.equal(start.capture, null, 'Closing releases pointer capture');
assert.equal(ids.customClipRange.hidden, true);
assert.equal(ids.customClipMarkBtn.hidden, true);
player.currentTime = player.duration;
controls.open();
ids.customClipMarkBtn.listeners.click();
assert.equal(ids.customClipMarkBtn.textContent, 'Start here');
assert.match(ids.customClipStatus.textContent, /before the video ends/);
assert(controls.validate(), 'Opening at the video end chooses a nonempty range');
assert.equal(ids.customClipStart.value, '00:01:00.124');
controls.close();
player.duration = 60.1259;
player.currentTime = 20;
controls.open();
ids.customClipMarkBtn.listeners.click();
player.currentTime = player.duration;
ids.customClipMarkBtn.listeners.click();
assert.equal(ids.customClipEnd.value, '00:01:00.125', 'Capturing video end stays inside millisecond duration');
assert(controls.validate());
controls.close();
console.log('PASS: precise clip markers, sequential playback capture, drag clamping, keyboard, pins and cleanup');
