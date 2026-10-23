const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const buttons = Object.fromEntries(['jumpBackSecondBtn', 'jumpForwardSecondBtn'].map(id => [id, {
    number: {}, attrs: {},
    addEventListener(name, callback) { this[name] = callback; },
    setAttribute(name, value) { this.attrs[name] = value; },
    querySelector() { return this.number; },
    setPointerCapture() {},
}]));
const interval = {value: '1', addEventListener(name, callback) { this[name] = callback; }};
const backInterval = {value: '1', addEventListener(name, callback) { this[name] = callback; }};
const listeners = {}, windowListeners = {}, documentListeners = {}, timeouts = new Map(), repeats = new Map();
const frames = [];
let timer = 0;
const player = {duration: NaN, readyState: 0, currentTime: 0, paused: true,
    addEventListener(name, callback) {
        const previous = listeners[name];
        listeners[name] = () => { previous?.(); callback(); };
    }};
const document = {hidden: false,
    getElementById: id => id === 'seekForwardInterval' ? interval : id === 'seekBackInterval' ? backInterval : buttons[id],
    addEventListener(name, callback) { documentListeners[name] = callback; }};
const context = vm.createContext({
    document, window: {addEventListener(name, callback) { windowListeners[name] = callback; }},
    setTimeout: fn => { timeouts.set(++timer, fn); return timer; },
    clearTimeout: id => timeouts.delete(id),
    setInterval: fn => { repeats.set(++timer, fn); return timer; },
    clearInterval: id => repeats.delete(id),
    requestAnimationFrame: fn => frames.push(fn),
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'video.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
context.initSecondJumps(player);
const back = buttons.jumpBackSecondBtn, forward = buttons.jumpForwardSecondBtn;
const click = button => button.click({detail: 0});
const down = button => button.pointerdown({button: 0, pointerId: 1});
const painted = () => {
    listeners.seeked();
    for (let index = 0; index < 2; index++) {
        for (const fn of frames.splice(0)) fn();
    }
};
const hold = () => {
    for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn(); }
    for (const fn of repeats.values()) fn();
};
assert.equal(back.disabled, true);
player.duration = 600.5;
player.readyState = 4;
listeners.loadedmetadata();
assert.equal(back.disabled, false);
player.currentTime = 12.125;
click(forward);
assert.equal(player.currentTime, 13.125);
painted();
click(back);
assert.equal(player.currentTime, 12.125);
painted();
assert.equal(player.paused, true);
interval.value = '60';
interval.change();
assert.equal(forward.number.textContent, '1m');
assert.match(forward.attrs['aria-label'], /1 minute/);
click(forward);
assert.equal(player.currentTime, 72.125);
painted();
assert.equal(back.number.textContent, '1m', 'Changing either selector updates both jump buttons');
assert.equal(backInterval.value, '60');
backInterval.value = '60';
backInterval.change();
assert.equal(back.number.textContent, '1m');
down(forward);
assert.equal(player.currentTime, 132.125, 'Pointer down performs the first step immediately');
hold();
assert.equal(player.currentTime, 132.125, 'Holding cannot replace a frame while its seek is still decoding');
painted();
hold();
assert.equal(player.currentTime, 192.125);
forward.pointerup();
painted();
forward.click({detail: 1});
assert.equal(player.currentTime, 192.125, 'Pointer click after release must not seek twice');
assert.equal(repeats.size, 0);
for (const stop of [
    () => forward.pointercancel(), () => forward.lostpointercapture(), () => forward.blur(),
    () => windowListeners.blur(),
    () => { document.hidden = true; documentListeners.visibilitychange(); document.hidden = false; },
    () => interval.change(),
]) {
    player.currentTime = 100;
    down(forward); stop(); painted();
    assert.equal(timeouts.size, 0);
    assert.equal(repeats.size, 0);
}
interval.value = '1';
interval.change();
assert.equal(backInterval.value, '1');
assert.equal(back.number.textContent, '1s');
assert.equal(forward.number.textContent, '1s');
player.currentTime = 100;
forward.keydown({key: ' ', repeat: false, preventDefault() {}});
forward.keydown({key: ' ', repeat: true, preventDefault() {}});
assert.equal(player.currentTime, 101);
painted();
hold();
hold();
assert.equal(player.currentTime, 102);
forward.keyup({key: ' ', preventDefault() {}});
painted();
assert.equal(repeats.size, 0);
player.paused = false;
player.currentTime = 0.5;
click(back);
assert.equal(player.currentTime, 0);
painted();
player.currentTime = 600;
click(forward);
assert.equal(player.currentTime, 600.5);
painted();
assert.equal(player.paused, false);
down(forward);
player.readyState = 0;
listeners.emptied();
assert.equal(forward.disabled, true);
assert.equal(timeouts.size, 0);
assert.equal(repeats.size, 0);
player.readyState = 4;
listeners.loadedmetadata();
player.currentTime = 100;
click(forward);
click(forward);
assert.equal(player.currentTime, 101, 'Rapid clicks queue rather than cancel an unfinished seek');
listeners.seeked();
assert.equal(player.currentTime, 101);
frames.shift()();
assert.equal(player.currentTime, 101, 'The next jump waits until the destination frame can paint');
frames.shift()();
assert.equal(player.currentTime, 102, 'Queued clicks run after the previous destination frame paints');
painted();
down(forward);
hold();
listeners.emptied();
painted();
hold();
assert.equal(timeouts.size, 0, 'A source reset cannot revive a held jump');
console.log('PASS: decoded-frame pacing, queued clicks, 1s/1min, hold cleanup, keyboard, clamps and unchanged playback');
