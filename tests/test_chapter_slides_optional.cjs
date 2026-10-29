const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const template = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const input = template.match(/<input\b[^>]*id="chapterSlidesToggle"[^>]*>/);
assert(input);
assert(!/\bchecked\b/.test(input[0]), 'Chapter slides are off by default');
const source = fs.readFileSync(path.join(root, 'static', 'js', 'chapters.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
let removed = 0;
let sceneReads = 0;
const state = {
    get videoScenes() { sceneReads++; return []; },
};
const toggle = { checked: false };
const container = {
    querySelectorAll(selector) {
        return selector === '.slide-download' ? [{ remove() { removed++; } }] : [];
    },
};
const context = vm.createContext({
    state, elements: { chaptersContainer: container },
    document: { getElementById() { return toggle; } },
});
vm.runInContext(source, context);
context.attachChapterSlides();
assert.equal(sceneReads, 0, 'Default chapter rendering does not process slides');
assert.equal(removed, 1, 'Turning off removes previously attached download controls');
toggle.checked = true;
context.attachChapterSlides();
assert.equal(sceneReads, 1, 'Slides are processed only after opting in');
const chapterRows = [];
let menus = 0;
const renderContext = vm.createContext({
    state: {},
    elements: {
        chaptersContainer: {
            querySelectorAll(selector) {
                return selector === ':scope > .chapter-item'
                    ? chapterRows.filter(row => row.className === 'chapter-item') : [];
            },
            appendChild(row) { chapterRows.push(row); },
        },
        exportChaptersBtn: {},
    },
    timestampSeconds: () => 0,
    conciseTitle: title => title,
    createChapterProjectButton: () => ({kind: 'project'}),
    createChapterDownloadButton: () => ({kind: 'download'}),
    createClipSelection: () => ({kind: 'selection'}),
    rowActions: row => { menus++; row.children.push({kind: 'menu'}); },
    CustomEvent: function () {},
    document: {
        dispatchEvent() {},
        createElement: () => ({
            dataset: {}, children: [], listeners: {},
            classList: {add() {}, toggle() {}},
            prepend(child) { this.children.unshift(child); },
            querySelectorAll(selector) {
                return this.children.filter(child => selector.includes(`.${child.className}`));
            },
            querySelector(selector) {
                return this.children.find(child => selector.includes(`.${child.className}`)) || null;
            },
            setAttribute(name, value) { this[name] = value; },
            getAttribute(name) { return this[name]; },
            appendChild(child) { this.children.push(child); },
            append(...children) { this.children.push(...children); },
            addEventListener(name, handler) { this.listeners[name] = handler; },
            click() { this.listeners.click?.({stopPropagation() {}}); },
            closest() { return null; },
        }),
    },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'utils.js'), 'utf8')
    .replace(/^export /gm, ''), renderContext);
vm.runInContext(source, renderContext);
vm.runInContext('attachChapterSlides = () => {}; addChapterMarkersToTimeline = () => {}; updateActiveChapter = () => {}; setSummaryStatus = () => {};', renderContext);
renderContext.updateChapters([{timestamp: '00:00', title: 'First'}]);
assert.equal(chapterRows[0].children.find(child => child.className === 'chapter-number').textContent, '1.');
assert.equal(chapterRows[0].children.find(child => child.className === 'chapter-title').textContent, 'First',
    'Display numbering must not be included in the editable title');
assert.equal(chapterRows[0]['aria-label'], 'Play chapter 1: First');
const longChapter = {timestamp: '74:00.125', title: 'Long video'};
renderContext.updateChapters([longChapter]);
assert.equal(chapterRows.findLast(child => child.className === 'chapter-item')
    .children.find(child => child.className === 'chapter-timestamp').textContent, '1:14:00.125');
assert.equal(longChapter.timestamp, '74:00.125', 'Rendering does not rewrite the source timestamp');
assert.equal(menus, 0, 'Normal chapter rows have no Actions menu');
assert.deepEqual(chapterRows[0].children.filter(child => child.kind).map(child => child.kind), ['project', 'download', 'selection'],
    'Open as project is directly beside the video download icon');
renderContext.updateChapters([{timestamp: '00:00', title: 'First', summary: 'Visible summary'}]);
const summaryToggle = chapterRows.findLast(child => child.className === 'chapter-item').children.find(child => child.className === 'chapter-summary-toggle');
assert.equal(summaryToggle.className, 'chapter-summary-toggle');
assert(!summaryToggle.open, 'Summaries start collapsed in normal viewing');
assert.equal(summaryToggle.children[1].textContent, 'Visible summary');
renderContext.updateChapters([{timestamp: '00:00', title: 'First'}], {editing: true});
assert.equal(menus, 0, 'Editing chapter rows do not create Actions menus');
const sections = [{timestamp: '00:00', title: 'Part A'}, {timestamp: '00:10', title: 'Part B'}];
const list = renderContext.renderChapterSections(sections, 0, [{sections}], false);
for (const row of list.children.filter(child => child.className === 'chapter-section')) {
    assert.deepEqual(row.children.filter(child => child.kind).map(child => child.kind), ['project', 'download', 'selection'],
        'Every section has both buttons directly on the row');
    const event = {target: {closest: () => true}, key: 'Enter',
        preventDefault() { throw new Error('Button keyboard activation must not be blocked'); }};
    row.listeners.click(event);
    row.listeners.keydown(event);
}
assert.equal(menus, 0, 'Section rows have no Actions menu outside editing');
renderContext.renderChapterSections(sections, 0, [{sections}], true);
assert.equal(menus, 0, 'Editing section rows do not create Actions menus');
assert(!source.includes('rowActions('), 'Slide downloads must not recreate row Actions menus');
renderContext.updateChapters([{timestamp: '00:00', title: 'Single section chapter', summary: 'Summary',
    sections: [{timestamp: '00:00', title: 'Detail', point: 'Hidden until requested'}]}]);
const singleList = chapterRows.findLast(child => child.className === 'chapter-sections');
const singleRow = chapterRows.findLast(child => child.className === 'chapter-item');
assert.equal(singleList.className, 'chapter-sections');
assert.equal(singleList.hidden, true, 'Even one section starts collapsed');
assert.equal(singleRow.children[0].className, 'chapter-expand');
assert.equal(singleRow.children[0]['aria-expanded'], 'false');
assert.equal(singleRow.children.some(child => child.className === 'chapter-single-point'), false);
singleRow.children[0].listeners.click({stopPropagation() {}});
assert.equal(singleList.hidden, false, 'Single sections are still accessible via their toggle');
assert.equal(singleList.children[0].title, 'Hidden until requested');
let played = 0;
const player = {currentTime: 0, play: () => { played++; return Promise.resolve(); }};
renderContext.elements.videoPlayer = player;
const row = chapterRows[0];
row.listeners.click({target: {closest: () => null}});
assert.equal(player.currentTime, 0);
assert.equal(played, 1, 'The first click anywhere on the non-control row seeks and plays');
player.currentTime = 99;
row.listeners.click({target: {closest: selector => selector.includes('details') ? {} : null}});
assert.equal(player.currentTime, 0, 'Summary body is a chapter click area, not a disclosure control');
player.currentTime = 99;
row.listeners.click({target: {closest: () => ({})}});
assert.equal(player.currentTime, 99, 'Buttons, checkboxes and disclosure toggles must not seek');
row.listeners.keydown({target: row, key: 'Enter', preventDefault() {}});
assert.equal(player.currentTime, 0, 'Chapter rows support keyboard seeking');
assert.equal(row.tabIndex, 0);
const sectionRow = singleList.children[0];
player.currentTime = 99;
sectionRow.listeners.click({target: {closest: () => null}});
assert.equal(player.currentTime, 0, 'Section rows also seek on the first click');
row.closest = () => ({});
player.currentTime = 99;
row.listeners.click({target: {closest: () => null}});
assert.equal(player.currentTime, 99, 'Inline editing must not trigger playback');
const css = fs.readFileSync(path.join(root, 'static', 'compact-layout.css'), 'utf8');
assert.match(css, /\.chapter-expand::before,\s*\.chapter-summary-toggle > summary::before \{/,
    'Summary and section toggles share marker sizing');
const theme = fs.readFileSync(path.join(root, 'static', 'theme.css'), 'utf8');
assert.match(theme, /\.chapter-edit-controls \{\s*display: contents;/,
    'Chapter edit buttons share the title row instead of a full-width second row');
chapterRows.length = 0;
const openOutline = [
    {timestamp: '00:00', title: 'Demo', summary: 'Summary', sections: [
        {timestamp: '00:00', title: 'Intro'}, {timestamp: '00:10', title: 'Steps'}]},
    {timestamp: '00:30', title: 'Next', sections: [{timestamp: '00:30', title: 'End'}]},
];
renderContext.updateChapters(openOutline);
let openRow = chapterRows.find(row => row.className === 'chapter-item');
openRow.querySelector('.chapter-expand').click();
openRow.querySelector('.chapter-summary-toggle').open = true;
renderContext.updateChapters(openOutline, {preserveExpansion: true});
openRow = chapterRows.filter(row => row.className === 'chapter-item').at(-2);
assert.equal(openRow.querySelector('.chapter-expand').getAttribute('aria-expanded'), 'true',
    'Saving a section keeps its parent chapter expanded');
assert.equal(openRow.querySelector('.chapter-summary-toggle').open, true,
    'Saving keeps the chapter summary open');
const retimed = JSON.parse(JSON.stringify(openOutline));
retimed[0].timestamp = '00:01';
retimed[0].sections[0].timestamp = '00:01';
renderContext.updateChapters(retimed, {preserveExpansion: true,
    retimedChapter: {previous: '00:00', current: '00:01'}});
openRow = chapterRows.filter(row => row.className === 'chapter-item').at(-2);
assert.equal(openRow.querySelector('.chapter-expand').getAttribute('aria-expanded'), 'true',
    'Changing the chapter start must not collapse it');
renderContext.updateChapters(retimed);
openRow = chapterRows.filter(row => row.className === 'chapter-item').at(-2);
assert.equal(openRow.querySelector('.chapter-expand').getAttribute('aria-expanded'), 'false',
    'Loading or generating another outline retains collapsed defaults');
console.log('PASS: chapter slides default off, cleanup and explicit opt-in');
