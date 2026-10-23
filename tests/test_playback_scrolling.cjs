const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'static', 'js', name), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const scrolls = [];
const container = {
    classList: {contains() { return false; }},
    scrollTop: 100, scrollLeft: 20, clientHeight: 300, clientWidth: 200,
    getBoundingClientRect: () => ({top: 200, bottom: 500, left: 0, right: 200}),
    scrollTo: (options) => scrolls.push(options),
};
const line = {
    classList: {add() {}, remove() {}},
    getBoundingClientRect: () => ({top: 600, bottom: 640, height: 40}),
    scrollIntoView: () => {throw new Error('Must not scroll the page');},
};
const context = vm.createContext({
    elements: {videoPlayer: {currentTime: 5}, transcriptContainer: container},
    state: {currentTranscript: [{start: 0, duration: 10, text: 'Lecture'}]},
    document: {querySelectorAll: () => [line], addEventListener() {}},
});
vm.runInContext(read('scroll-utils.js') + '\n' + read('transcript.js'), context);
context.updateActiveTranscript();
assert.equal(scrolls[0].top, 370);
assert.equal(scrolls[0].left, undefined);
line.getBoundingClientRect = () => ({top: 250, bottom: 290, height: 40});
context.updateActiveTranscript();
assert.equal(scrolls.length, 1, 'A visible line must not trigger scrolling');
context.scrollWithinContainer(container, {
    getBoundingClientRect: () => ({left: 300, right: 420, width: 120}),
}, 'horizontal');
assert.equal(scrolls[1].left, 280);
assert.equal(scrolls[1].top, undefined, 'Timeline playback must not move vertically');
const chapterRows = [0, 60, 120].map(start => ({
    dataset: {start}, classList: {contains: () => false, add() {}, remove() {}},
    setAttribute() {}, removeAttribute() {},
    getBoundingClientRect: () => ({top: 600, bottom: 640, height: 40}),
}));
let interacting = true;
const chapterContainer = {
    ...container,
    scrollHeight: 900,
    matches(selector) {
        assert.equal(selector, ':hover, :focus-within');
        return interacting;
    },
    querySelectorAll: selector => selector === '.chapter-item' ? chapterRows : [],
};
context.elements.chaptersContainer = chapterContainer;
context.document.getElementById = () => null;
context.getComputedStyle = () => ({overflowY: 'auto'});
vm.runInContext(read('chapters.js'), context);
context.updateActiveChapter();
assert.equal(scrolls.length, 2, 'Do not move chapter rows while the pointer or keyboard focus is inside');
interacting = false;
context.elements.videoPlayer.currentTime = 65;
context.updateActiveChapter();
assert.equal(scrolls.length, 3, 'Normal playback still follows chapter changes outside the list');
interacting = true;
context.elements.videoPlayer.currentTime = 125;
context.updateActiveChapter();
assert.equal(scrolls.length, 3, 'Playback cannot scroll the target away while the user is clicking');
console.log('PASS: playback scrolls transcript/timeline containers only, visible lines stay still');
