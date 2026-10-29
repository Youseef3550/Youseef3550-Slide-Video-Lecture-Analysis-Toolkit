const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'content-editor.js'), 'utf8')
    .replace(/^import .+;$/gm, '').replace(/^export /gm, '');
const context = vm.createContext({});
assert(!source.includes('The earlier title and timestamp will be kept'),
    'Merge confirmation must not promise to keep the first title');
assert(source.includes('Review its editable title and summary before saving.'),
    'Reorganization merge must describe its actual editable result');
vm.runInContext(source, context);
const outline = [
    {timestamp: '00:00', title: 'First', summary: 'One', sections: [
        {timestamp: '00:00', title: 'A', point: 'Alpha'},
        {timestamp: '00:10', title: 'B', point: 'Beta'},
        {timestamp: '00:20', title: 'C', point: 'Gamma'}]},
    {timestamp: '00:30', title: 'Second', summary: 'Two', sections: [
        {timestamp: '00:30', title: 'D', point: 'Delta'},
        {timestamp: '00:40', title: 'E', point: 'Epsilon'}]},
];
const apply = op => JSON.parse(JSON.stringify(context.applyOutlineOperation(outline, op)));
const merged = apply({action: 'merge_section', chapter: 0, section: 0});
assert.equal(merged[0].sections.length, 2);
assert.equal(merged[0].sections[0].title, 'A');
assert.equal(merged[0].sections[0].timestamp, '00:00');
assert.match(merged[0].sections[0].point, /Alpha[\s\S]*B[\s\S]*Beta/);
const chapter = apply({action: 'merge_chapter', chapter: 0});
const crossChapter = apply({action: 'merge_section', chapter: 0, section: 2});
assert.equal(crossChapter[0].sections.at(-1).timestamp, '00:20');
assert.match(crossChapter[0].sections.at(-1).point, /Gamma[\s\S]*Delta/);
assert.equal(crossChapter[1].timestamp, '00:40');
assert.equal(crossChapter[1].sections.length, 1);
const consumed = context.applyOutlineOperation(crossChapter, {action: 'merge_section', chapter: 0, section: 2});
assert.equal(consumed.length, 1, 'A fully consumed chapter must not leave an overlapping boundary');
assert.equal(chapter.length, 1);
assert.equal(chapter[0].title, 'First');
assert.equal(chapter[0].sections.length, 5);
const promoted = apply({action: 'promote', chapter: 0, section: 1});
assert.equal(promoted.length, 3);
assert.equal(promoted[1].title, 'B');
assert.equal(promoted[1].timestamp, '00:10');
assert.equal(promoted[0].sections.length, 1);
const forward = apply({action: 'move_section', chapter: 0, section: 2, target: 1});
assert.equal(forward[1].timestamp, '00:20');
assert.equal(forward[1].sections[0].title, 'C');
const back = apply({action: 'move_section', chapter: 1, section: 0, target: 0});
assert.equal(back[1].timestamp, '00:40');
assert.equal(back[0].sections.at(-1).title, 'D');
assert.throws(() => apply({action: 'move_section', chapter: 0, section: 1, target: 1}), /video order/);
assert.throws(() => apply({action: 'promote', chapter: 0, section: 0}), /already starts/);
assert.equal(outline[0].sections.length, 3, 'Draft transforms must not mutate the saved source');
const retimed = JSON.parse(JSON.stringify(outline));
retimed[0].sections[1].timestamp = '00:00';
assert.throws(() => context.applyOutlineOperation(retimed, {action: 'promote', chapter: 0, section: 1}, outline),
    /Save timestamp changes/, 'Regrouping must not replay against different saved boundaries');
const renamed = JSON.parse(JSON.stringify(outline));
renamed[0].sections[1].title = 'Renamed';
assert.equal(context.applyOutlineOperation(renamed, {action: 'promote', chapter: 0, section: 1}, outline)[1].title, 'Renamed');
const firstTimeField = {value: '00:00'};
let titleTimeField;
const timestampChapter = {timestamp: '00:00', sections: [{timestamp: '00:00'}, {timestamp: '00:30'}]};
const fieldContext = vm.createContext({
    editing: {kind: 'chapters', draft: []},
    document: {createElement: () => ({
        listeners: {}, setAttribute() {},
        addEventListener(name, handler) { this.listeners[name] = handler; },
    })},
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'utils.js'), 'utf8')
    .replace(/^export /gm, ''), fieldContext);
vm.runInContext(source.slice(source.indexOf('    function input('), source.indexOf('    function actionButton(')),
    fieldContext);
fieldContext.input({
    querySelector: () => ({replaceWith(field) { titleTimeField = field; }}),
    nextElementSibling: {querySelector: () => firstTimeField},
}, '.chapter-timestamp', 'Chapter start', timestampChapter, 'timestamp');
titleTimeField.value = '00:10';
titleTimeField.listeners.input();
assert.equal(timestampChapter.timestamp, '00:10');
assert.equal(timestampChapter.sections[0].timestamp, '00:10');
assert.equal(firstTimeField.value, '00:10', 'First section field updates immediately, before saving');
assert.equal(timestampChapter.sections[1].timestamp, '00:30', 'Other section boundaries stay unchanged');
const longChapter = {timestamp: '74:00.125'};
fieldContext.input({
    querySelector: () => ({replaceWith(field) { titleTimeField = field; }}),
}, '.chapter-timestamp', 'Chapter start', longChapter, 'timestamp');
assert.equal(titleTimeField.value, '1:14:00.125');
assert.equal(longChapter.timestamp, '74:00.125', 'Opening an editor must not rewrite saved timestamps');
const notesContext = vm.createContext({
    document: {createElement: tag => ({
        tag, children: [], appendChild(child) { this.children.push(child); }, addEventListener() {},
        setAttribute(name, value) { this[name] = value; },
    })},
});
vm.runInContext(source.slice(source.indexOf('    function notes('), source.indexOf('    function editControls(')),
    notesContext);
const notesParent = {children: [], appendChild(child) { this.children.push(child); }};
notesContext.notes(notesParent, 'Chapter summary', {summary: 'Saved summary'}, 'summary');
const disclosure = notesParent.children[0];
assert.equal(disclosure.tag, 'details');
assert(!disclosure.open, 'Chapter summaries are collapsed while editing too');
assert.equal(disclosure.children[1].children[0].value, 'Saved summary');
assert.equal(disclosure.children[0]['aria-label'], 'Chapter summary');
assert.equal(disclosure.children[0].children[0].className, 'fas fa-align-left');
notesContext.notes(notesParent, 'Section summary', {point: 'Saved section summary'}, 'point');
const sectionDisclosure = notesParent.children[1];
assert.equal(sectionDisclosure.tag, 'details');
assert(!sectionDisclosure.open, 'Section summaries are also collapsed in the full editor');
assert.equal(sectionDisclosure.children[0]['aria-label'], 'Section summary');
assert.equal(sectionDisclosure.children[1].children[0].value, 'Saved section summary');
assert(source.includes("row.querySelector('.chapter-expand')?.click();"),
    'Reorganizing expands sections through the shared toggle, keeping its accessible state consistent');
vm.runInContext(source.slice(source.indexOf('    function actionButton('), source.indexOf('    function notes(')),
    notesContext);
notesContext.actionButton(notesParent, 'Merge with next chapter', {action: 'merge_chapter'});
const mergeButton = notesParent.children.at(-1);
assert.equal(mergeButton['aria-label'], 'Merge with next chapter');
assert.equal(mergeButton.textContent, '');
assert.equal(mergeButton.children[0].className, 'fas fa-compress-alt');
assert(!source.includes('showModal'), 'Content editing never opens a popup');
assert(source.includes("['chapters', 'slides', 'transcript']"));
context.formatTimestamp = stamp => stamp;
const laterOutline = JSON.parse(JSON.stringify(outline));
laterOutline[0].sections[1].timestamp = '00:14';
laterOutline[1].timestamp = '00:35';
laterOutline[1].sections[0].timestamp = '00:35';
laterOutline[0].sections[2].timestamp = '00:18';
const questions = [];
const later = JSON.parse(JSON.stringify(context.applyLaterStartChoices(laterOutline, outline, message => {
    questions.push(message);
    return message.includes('"B"');
})));
assert.equal(questions.length, 2, 'Only starts moved later ask; earlier moves and first-section mirrors do not');
assert.match(questions[0], /"B" now starts at 00:14 instead of 00:10[\s\S]*previous section/);
assert.equal(later[0].sections[1].split_gap, '00:10');
assert.equal(later[0].sections[2].split_gap, undefined, 'Earlier starts never ask');
assert.equal(later[1].split_gap, undefined, 'Declining keeps the time in the previous row');
assert.equal(laterOutline[0].sections[1].split_gap, undefined, 'The open draft is never mutated');
const earlierOutline = JSON.parse(JSON.stringify(outline));
earlierOutline[0].sections[1].timestamp = '00:05';
assert.equal(context.laterStartChoices(earlierOutline, outline).length, 0);
console.log('PASS: inline outline transforms preserve timing, text, source and chronological grouping');
