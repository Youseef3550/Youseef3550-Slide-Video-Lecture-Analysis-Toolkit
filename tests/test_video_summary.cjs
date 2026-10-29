const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'video-summary.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const ids = {};
for (const id of ['generateVideoSummaryBtn', 'videoSummaryText', 'videoSummaryStatus', 'videoSummaryPanel']) {
    ids[id] = {textContent: '', addEventListener(name, callback) { this[name] = callback; }};
}
const events = {};
const state = {currentVideoId: 'video', currentTranslationLanguage: 'en',
    currentTranscript: [{start: 0, text: 'First'}, {start: 1000, text: 'Last'}]};
const requests = [];
let deferred;
let fail = false;
let saved = true;
let loadFailed = false;
const context = vm.createContext({
    startProcessButton: require('./process_button_stub.cjs'),
    state, elements: {summaryModel: {value: 'groq:test'}}, startElapsedTimer: () => () => {},
    document: {getElementById: id => ids[id], addEventListener(name, callback) { events[name] = callback; }},
    fetch: async (url, options) => {
        requests.push({url, data: JSON.parse(options.body)});
        if (url.endsWith('/load')) return {ok: !loadFailed, json: async () =>
            loadFailed ? {detail: 'Could not load saved summary'} : {exists: saved, summary: saved ? 'Saved paragraph.' : ''}};
        if (deferred) await new Promise(resolve => { deferred.resolve = resolve; });
        return {ok: !fail, json: async () => fail ? {detail: 'Provider busy'} :
            {success: true, summary: 'The opening and ending together in one short paragraph.'}};
    },
});
vm.runInContext(source, context);
const tick = () => new Promise(resolve => setImmediate(resolve));
context.initVideoSummary();
(async () => {
    await tick();
    assert.equal(ids.videoSummaryText.textContent, 'Saved paragraph.');
    assert.equal(ids.videoSummaryPanel.hidden, false);
    assert.equal(ids.videoSummaryPanel.open, false, 'Saved summaries start collapsed');
    assert.equal(ids.videoSummaryStatus.hidden, true, 'No redundant saved-summary status');
    await ids.generateVideoSummaryBtn.click();
    assert.equal(requests[1].data.transcript.length, 2, 'Whole transcript is sent, including ending');
    assert.equal(requests[1].data.transcript_language, 'en');
    assert.equal(requests[1].data.model, 'groq:test');
    assert.match(ids.videoSummaryText.textContent, /opening and ending/);
    assert.equal(ids.videoSummaryPanel.open, true, 'Show the summary when generation was explicitly requested');
    assert.equal(ids.videoSummaryStatus.hidden, true);
    assert.equal(ids.generateVideoSummaryBtn.textContent, 'Generate summary');
    const count = requests.length;
    state.currentTranscript[0].speaker_name = 'Alex';
    events.transcriptUpdated();
    await tick();
    assert.equal(requests.length, count, 'Speaker renaming does not hide or reload the same text summary');
    fail = true;
    await ids.generateVideoSummaryBtn.click();
    assert.match(ids.videoSummaryStatus.textContent, /Provider busy/);
    assert.equal(ids.videoSummaryStatus.hidden, false, 'Errors remain visible outside the disclosure');
    assert.match(ids.videoSummaryText.textContent, /opening and ending/, 'Failure preserves prior paragraph');
    fail = false;
    deferred = {};
    const generating = ids.generateVideoSummaryBtn.click();
    assert.equal(ids.generateVideoSummaryBtn.disabled, true);
    state.currentVideoId = 'other';
    events.videoSelectionChanged();
    await tick();
    assert.equal(ids.videoSummaryText.textContent, 'Saved paragraph.');
    assert.equal(ids.generateVideoSummaryBtn.disabled, true, 'An old generation cannot spawn duplicates after switching');
    deferred.resolve();
    await generating;
    assert.equal(ids.videoSummaryText.textContent, 'Saved paragraph.', 'Late generation cannot overwrite another video');
    assert.equal(ids.generateVideoSummaryBtn.disabled, false);
    state.currentVideoId = null;
    events.videoSelectionChanged();
    await tick();
    assert.equal(ids.videoSummaryText.textContent, '');
    assert.equal(ids.generateVideoSummaryBtn.disabled, true);
    assert.equal(ids.videoSummaryPanel.hidden, true, 'No empty summary card');
    assert.equal(ids.videoSummaryStatus.hidden, true, 'No empty-state instruction above chapters');
    saved = false;
    state.currentVideoId = 'no-summary';
    events.videoSelectionChanged();
    await tick();
    assert.equal(ids.videoSummaryPanel.hidden, true, 'An open transcript without a summary still has no summary card');
    assert.equal(ids.videoSummaryStatus.hidden, true);
    assert.equal(ids.generateVideoSummaryBtn.disabled, false, 'Generation remains available in Chapter actions');
    loadFailed = true;
    state.currentVideoId = 'load-error';
    events.videoSelectionChanged();
    await tick();
    assert.equal(ids.videoSummaryPanel.hidden, true);
    assert.equal(ids.videoSummaryStatus.hidden, false);
    assert.match(ids.videoSummaryStatus.textContent, /Could not load saved summary/);
    console.log('PASS: saved summary loads, full transcript, language, failures, speaker renames and video-selection races');
})().catch(error => { console.error(error); process.exitCode = 1; });
