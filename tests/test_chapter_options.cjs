const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static', 'js', 'chapters.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const ids = {};
for (const id of ['chapterBasis', 'chapterSpeakerHelp', 'chapterSlideBoundaries', 'chapterConsiderSlides',
    'chapterSlideHelp', 'summaryOptionsBtn', 'summaryOptionsPanel', 'closeChapterOptionsBtn', 'chapterStructure']) {
    ids[id] = {listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
        dispatchEvent() {}, focus() {this.focused = true;}};
}
ids.chapterBasis.value = 'topics';
ids.chapterBasis.options = ['topics', 'speakers', 'topics_speakers', 'timestamps'].map(value => ({value}));
ids.chapterSlideBoundaries.value = 'both';
ids.chapterSlideBoundaries.options = ['none', 'chapters', 'sections', 'both'].map(value => ({value}));
Object.defineProperty(ids.chapterSlideBoundaries, 'selectedOptions', {get() {
    return this.options.filter(option => option.value === this.value);
}});
ids.chapterStructure.value = 'sections';
const state = {currentTranscript: [{text:'Hello'}], videoScenes: []};
const context = vm.createContext({state, elements: {chapterStructure:ids.chapterStructure}, Event: function () {},
    document: {getElementById:id=>ids[id], addEventListener() {}}});
vm.runInContext(source, context);
context.initChapterGenerationOptions();
assert(ids.chapterBasis.options.find(o=>o.value==='speakers').disabled);
assert(ids.chapterSlideBoundaries.disabled);
state.currentTranscript = [{speaker:'S1'}, {speaker_name:'Alice'}];
state.videoScenes = [{time_seconds:0}, {time_seconds:30}];
context.updateChapterGenerationOptions();
assert(!ids.chapterBasis.options.find(o=>o.value==='speakers').disabled);
assert(!ids.chapterSlideBoundaries.disabled);
state.currentTranscript[1] = {speaker:' '};
ids.chapterBasis.value = 'topics_speakers';
context.updateChapterGenerationOptions();
assert.equal(ids.chapterBasis.value, 'topics');
ids.chapterBasis.value = 'timestamps';
context.updateChapterGenerationOptions();
assert.equal(ids.chapterSlideBoundaries.value, 'sections');
assert(ids.chapterConsiderSlides.disabled);
ids.summaryOptionsPanel.hidden = false;
ids.closeChapterOptionsBtn.listeners.click();
assert(ids.summaryOptionsPanel.hidden);
assert(ids.summaryOptionsBtn.focused);
ids.summaryOptionsPanel.hidden = false;
ids.summaryOptionsPanel.listeners.keydown({key:'Escape',preventDefault(){},stopPropagation(){}});
assert(ids.summaryOptionsPanel.hidden);
const template = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const options = template.slice(template.indexOf('id="summaryOptionsPanel"'), template.indexOf('id="exportOptionsDialog"'));
assert(options.includes('id="translateChaptersBtn"'));
assert(options.includes('id="loadSavedChaptersBtn"'));
assert.match(options, /<button[^>]*id="edit-chapters-btn"[^>]*>Reorganize chapters<\/button>/);
assert(!options.match(/<button[^>]*id="edit-chapters-btn"[^>]*\bhidden\b/),
    'Reorganization must have a discoverable entry point');
const menus = fs.readFileSync(path.join(root, 'static', 'js', 'action-menus.js'), 'utf8');
assert(!menus.includes("'Chapter actions'"));
console.log('PASS: speaker prerequisites, slide scopes, exact timestamp preservation, close/Escape and unified chapter options');
