const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function node() {
    return {
        hidden: true, checked: false, value: '', dataset: {}, listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; },
    };
}
const buttons = ['chapters', 'slides', 'both', 'none'].map(action => {
    const button = node();
    button.dataset.readyAction = action;
    return button;
});
const prompt = node();
prompt.querySelectorAll = () => buttons;
const remember = node(), preference = node(), detect = { disabled: false };
const nodes = { transcriptReadyPrompt: prompt, rememberTranscriptReady: remember,
    transcriptReadyAction: preference, detectScenesBtn: detect };
const listeners = {};
const doc = {
    getElementById: id => nodes[id],
    addEventListener: (name, callback) => { listeners[name] = callback; },
};
const values = new Map(), storage = {
    getItem: key => values.get(key),
    setItem: (key, value) => values.set(key, value),
};
const timers = [];
const state = { currentVideoId: 'video', currentTranscriptSource: 'whisper',
    currentTranscript: [{ start: 0, text: 'First transcript' }], videoChapters: [], videoScenes: [] };
const calls = [], notices = [];
const context = vm.createContext({ setTimeout: callback => timers.push(callback) });
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'transcript-ready.js'), 'utf8')
    .replace(/^export /gm, '');
vm.runInContext(source, context);
context.initTranscriptReady({ state, doc, storage,
    chapters: async () => { calls.push('chapters'); },
    slides: async () => { calls.push('slides'); },
    notify: message => notices.push(message),
});
const ready = () => {
    listeners.newTranscriptReady({ detail: { videoId: state.currentVideoId } });
    while (timers.length) timers.shift()();
};
const click = action => buttons.find(button => button.dataset.readyAction === action).listeners.click();

(async () => {
    assert(prompt.hidden, 'Opening a saved project does not prompt or start processing');
    assert.equal(preference.value, 'ask');
    ready();
    assert(!prompt.hidden);
    assert.deepEqual(calls, [], 'New transcripts require a choice by default');
    remember.checked = true;
    click('both');
    await Promise.resolve();
    assert(prompt.hidden);
    assert.deepEqual(calls, ['chapters', 'slides'], 'Both starts independent operations together');
    assert.equal(preference.value, 'both');
    ready();
    assert.equal(calls.length, 2, 'Duplicate ready notifications do not rerun processing');

    state.currentTranscript = [{ start: 0, text: 'Another new transcript' }];
    ready();
    await Promise.resolve();
    assert.equal(calls.length, 4, 'Remembered Both starts processing for future new transcripts');

    state.currentTranscript = [{ start: 0, text: 'With existing results' }];
    state.videoChapters = [{}];
    state.videoScenes = [{}];
    ready();
    assert.equal(calls.length, 4, 'Remembered choices never overwrite existing results');
    state.videoChapters = state.videoScenes = [];

    preference.value = 'ask';
    preference.listeners.change();
    state.currentTranscript = [{ start: 0, text: 'Manual choice' }];
    ready();
    remember.checked = true;
    click('none');
    assert.equal(calls.length, 4);
    assert.equal(preference.value, 'none', 'Remembering Not now keeps future actions manual');

    preference.value = 'ask';
    preference.listeners.change();
    state.currentTranscript = [{ start: 0, text: 'Switching projects' }];
    ready();
    listeners.videoSelectionChanged();
    state.currentVideoId = 'other';
    click('chapters');
    assert.equal(calls.length, 4, 'A stale prompt cannot process a different project');
    assert(prompt.hidden);

    ready();
    click('slides');
    assert.deepEqual(calls.slice(-1), ['slides']);
    state.currentTranscript = [{ start: 0, text: 'Busy' }];
    ready();
    state.summaryGenerationInProgress = true;
    click('chapters');
    assert(/already running/.test(notices.at(-1)));
    assert.equal(calls.length, 5);

    const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
    for (const action of ['chapters', 'slides', 'both', 'none']) assert(template.includes(`data-ready-action="${action}"`));
    assert(template.includes('id="transcriptReadyAction"'), 'Settings can reset a remembered choice');
    assert(template.includes('Always do this when I upload new videos'));
    console.log('PASS: new transcript prompt, parallel actions, remembered choices, deduplication and project guards');
})().catch(error => { console.error(error); process.exitCode = 1; });
