const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'chapters.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const context = vm.createContext({});
vm.runInContext(source, context);
const chapter = (timestamp, times) => ({timestamp, sections: times.map(timestamp => ({timestamp}))});
const original = [chapter('00:00', ['00:00', '00:10', '00:20']), chapter('00:30', ['00:30', '00:40'])];
const checkbox = (chapter_index, section_index, checked = true) => ({
    checked, dataset: {clipSelection: JSON.stringify({chapter_index, section_index})},
});
const container = boxes => ({
    querySelectorAll: selector => selector.endsWith(':checked') ? boxes.filter(box => box.checked) : boxes,
});
const selected = [checkbox(0, 1), checkbox(1, null), checkbox(1, 1)];
const edit = {action: 'update', chapter: 0, section: 1, timestamp: '00:15'};
const keys = context.captureChapterSelection(container(selected), original, edit);
const updated = [chapter('00:00', ['00:00', '00:10', '00:15', '00:20']), ...original.slice(1)];
const rendered = [checkbox(0, 1, false), checkbox(0, 2, false), checkbox(0, 3, false),
    checkbox(1, null, false), checkbox(1, 1, false)];
context.restoreChapterSelection(container(rendered), updated, keys);
assert.deepEqual(rendered.map(box => box.checked), [false, true, false, true, true],
    'Retimed row and other selections survive; the new gap does not inherit the old index selection');
const moved = [chapter('00:00', ['00:00']), chapter('00:10', ['00:10', '00:20']), ...original.slice(1)];
const movedBoxes = [checkbox(1, 0, false), checkbox(2, null, false), checkbox(2, 1, false)];
context.restoreChapterSelection(container(movedBoxes), moved,
    context.captureChapterSelection(container(selected), original));
assert(movedBoxes.every(box => box.checked), 'Selections follow sections moved to a new chapter and shifted chapters');
const chapterSelection = [checkbox(0, null), checkbox(0, 0), checkbox(0, 2)];
const chapterEdit = {action: 'update', chapter: 0, timestamp: '00:02'};
const retimed = [chapter('00:02', ['00:02', '00:10', '00:20']), original[1]];
const chapterBoxes = [checkbox(0, null, false), checkbox(0, 0, false), checkbox(0, 2, false)];
context.restoreChapterSelection(container(chapterBoxes), retimed,
    context.captureChapterSelection(container(chapterSelection), original, chapterEdit));
assert(chapterBoxes.every(box => box.checked), 'Chapter retiming also preserves its retimed first section');
const deleted = context.captureChapterSelection(container(selected), original,
    {action: 'delete', chapter: 0, section: 1});
assert.equal(deleted.has('section:10'), false, 'A replacement gap must not inherit a deleted selection');
const deletedChapter = context.captureChapterSelection(container(chapterSelection), original,
    {action: 'delete', chapter: 0});
assert.equal(deletedChapter.size, 0);
const merged = [chapter('00:00', ['00:00', '00:20']), original[1]];
const mergedBoxes = [checkbox(0, 0, false), checkbox(0, 1, false), checkbox(1, 1, false)];
context.restoreChapterSelection(container(mergedBoxes), merged,
    context.captureChapterSelection(container([checkbox(0, 0), checkbox(0, 1), checkbox(1, 1)]), original));
assert.deepEqual(mergedBoxes.map(box => box.checked), [true, false, true]);
assert(source.indexOf('restoreChapterSelection(chaptersContainer, chapters, selected)')
    < source.indexOf("document.dispatchEvent(new CustomEvent('chaptersUpdated', { detail: chapters }))"),
    'Selection is restored before toolbar listeners read it');
console.log('PASS: selection survives edits, new gaps, chapter splits, retiming and merges without selecting replacement rows');
