const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'content-history.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
(async () => {
    const events = {}, requests = [], rendered = [];
    const control = () => ({
        disabled: true, listeners: {},
        setAttribute(name, value) { this[name] = value; },
        addEventListener(name, handler) { this.listeners[name] = handler; },
        click() { if (!this.disabled) this.listeners.click(); },
    });
    const ids = {undoContentBtn: control(), redoContentBtn: control(), contentHistoryStatus: {}};
    const state = {currentVideoId: 'video', currentTranscriptSource: 'uploaded', currentTranslationLanguage: 'de'};
    const video = {src: '/unchanged', currentTime: 45, playbackRate: 1.5, paused: false};
    const before = JSON.stringify(video);
    let available = {undo: 'Edit section', redo: null}, fail = false, polls;
    const context = vm.createContext({
        state, URLSearchParams, elements: {videoPlayer: video},
        document: {
            hidden: false, getElementById: id => ids[id], querySelector: () => null,
            addEventListener(name, handler) { events[name] = handler; },
        },
        window: {addEventListener() {}},
        setInterval(callback) { polls = callback; },
        contentLanguage: () => 'de',
        setContentLanguage: (...args) => rendered.push(['language', ...args]),
        loadTranscript: data => rendered.push(['transcript', data]),
        updateChapters: data => rendered.push(['chapters', data]),
        updateScenes: (data, player) => { assert.equal(player, video); rendered.push(['scenes', data]); },
        refreshTranscriptVersions: async () => rendered.push(['versions']),
        fetch: async (url, options) => {
            requests.push({url, options});
            if (fail) return {ok: false, json: async () => ({detail: 'History unavailable'})};
            if (options) {
                available = url.endsWith('/undo') ? {undo: null, redo: 'Edit section'} : {undo: 'Edit section', redo: null};
                return {ok: true, json: async () => ({label: 'Edit section'})};
            }
            return {ok: true, json: async () => url.includes('/content?') ? {
                transcript: {segments: []}, chapters: [], scenes: [],
                source: 'uploaded', transcript_language: null, chapter_language: null,
            } : available};
        },
    });
    const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
    vm.runInContext(source, context);
    context.initContentHistory();
    await flush();
    assert.equal(ids.undoContentBtn.disabled, false);
    assert.equal(ids.redoContentBtn.disabled, true);
    state.outlineRowEditing = true;
    events.contentEditStateChanged();
    await flush();
    assert.equal(ids.undoContentBtn.disabled, true, 'Unsaved edits block restoration');
    state.outlineRowEditing = false;
    events.contentEditStateChanged();
    await flush();
    let prevented = false;
    const key = {ctrlKey: true, key: 'z', target: {closest: () => ({})}, preventDefault() { prevented = true; }};
    events.keydown(key);
    assert.equal(prevented, false, 'Text input keeps its native Undo');
    events.keydown({...key, target: {closest: () => null}});
    await flush();
    assert.equal(prevented, true);
    assert.equal(state.currentTranscriptSource, 'uploaded', 'Undo restores the original source after removing a translation');
    assert.equal(state.currentTranslationLanguage, null);
    assert.equal(ids.redoContentBtn.disabled, false);
    assert.equal(ids.contentHistoryStatus.textContent, 'Undone: Edit section');
    assert.deepEqual(rendered.map(item => item[0]), ['language', 'transcript', 'chapters', 'scenes', 'versions']);
    assert.equal(JSON.stringify(video), before, 'Restoring saved content never reloads or seeks media');
    events.keydown({...key, shiftKey: true, target: {closest: () => null}});
    await flush();
    assert.equal(ids.contentHistoryStatus.textContent, 'Redone: Edit section');
    assert.equal(requests.filter(request => request.options).length, 2);
    fail = true;
    polls();
    await flush();
    assert.equal(ids.undoContentBtn.disabled, true);
    assert.equal(ids.contentHistoryStatus.textContent, 'History unavailable');
    console.log('PASS: saved-content Undo/Redo, source restoration, editing guards, shortcuts, errors and unchanged playback');
})().catch(error => { console.error(error); process.exitCode = 1; });
