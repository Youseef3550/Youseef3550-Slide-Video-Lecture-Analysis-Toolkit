const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'chapters.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
function row(start, type) {
    const classes = new Set([type]);
    return {
        dataset: {start}, attributes: {},
        classList: {
            contains: name => classes.has(name),
            add: name => classes.add(name),
            remove: name => classes.delete(name),
        },
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
    };
}
const chapters = [row(10, 'chapter-item'), row(60, 'chapter-item')];
const sections = [row(10, 'chapter-section'), row(30, 'chapter-section')];
chapters[0].nextElementSibling = {
    hidden: true,
    classList: {contains: name => name === 'chapter-sections'},
    querySelectorAll: () => sections,
};
const all = [...chapters, ...sections];
const toggle = {checked: true, addEventListener(name, handler) { this[name] = handler; }};
const status = {hidden: true, textContent: ''};
const storage = new Map();
const errors = [];
let scrolls = 0;
let hovering = false;
const container = {
    classList: {contains: () => false},
    querySelectorAll(selector) {
        if (selector === '.chapter-item') return chapters;
        if (selector.includes('.active')) return all.filter(item => item.classList.contains('active'));
        return [];
    },
    matches: () => hovering,
};
const elements = {chaptersContainer: container, videoPlayer: {currentTime: 0}};
const context = vm.createContext({
    elements,
    state: {videoChapters: [
        {title: 'Introduction', sections: [{title: 'Welcome'}, {title: 'Goals'}]},
        {title: 'Discussion'},
    ]},
    document: {getElementById: id => id === 'chapterPlaybackTracking' ? toggle
        : id === 'chapterNowPlaying' ? status : null},
    localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
    showError: message => errors.push(message),
    getComputedStyle: () => ({overflowY: 'visible'}),
    scrollWithinContainer: () => scrolls++,
});
vm.runInContext(source, context);
context.initChapterPlaybackTracking();
assert.equal(toggle.checked, true);
assert.equal(status.hidden, true, 'Nothing is playing before the first chapter starts');
elements.videoPlayer.currentTime = 15;
context.updateActiveChapter();
assert.equal(status.textContent, 'Now playing: Chapter 1: Introduction / Section 1.1: Welcome');
assert.equal(status.hidden, false);
assert.equal(chapters[0].attributes['aria-current'], 'location');
assert.equal(sections[0].attributes['aria-current'], 'location');
assert.equal(chapters[0].nextElementSibling.hidden, true, 'Tracking does not force open collapsed sections');
const priorScrolls = scrolls;
context.updateActiveChapter();
assert.equal(scrolls, priorScrolls, 'Do not scroll repeatedly within a section');
hovering = true;
elements.videoPlayer.currentTime = 30;
context.updateActiveChapter();
assert.equal(scrolls, priorScrolls, 'Do not disturb the user interacting with the chapter list');
assert.equal(status.textContent, 'Now playing: Chapter 1: Introduction / Section 1.2: Goals');
assert.equal(sections[0].attributes['aria-current'], undefined);
elements.videoPlayer.currentTime = 60;
context.updateActiveChapter();
assert.equal(status.textContent, 'Now playing: Chapter 2: Discussion');
assert.equal(sections[1].attributes['aria-current'], undefined);
toggle.checked = false;
toggle.change();
assert.equal(storage.get('chapterPlaybackTracking'), 'false');
assert.equal(status.hidden, true);
assert.equal(all.some(item => item.classList.contains('active')), false);
assert.equal(all.some(item => item.attributes['aria-current']), false);
elements.videoPlayer.currentTime = 15;
context.updateActiveChapter();
assert.equal(status.hidden, true);
assert.equal(scrolls, priorScrolls);
context.initChapterPlaybackTracking();
assert.equal(toggle.checked, false, 'The disabled preference survives initialization');
toggle.checked = true;
toggle.change();
assert.equal(status.textContent, 'Now playing: Chapter 1: Introduction / Section 1.1: Welcome');
assert.equal(storage.get('chapterPlaybackTracking'), 'true');
assert.equal(elements.videoPlayer.currentTime, 15, 'Tracking never seeks or changes playback');
assert.equal(errors.length, 0);
console.log('PASS: playback chapter/section status, collapsed sections, boundaries, backward seeking, accessible highlights and persistent opt-out');
