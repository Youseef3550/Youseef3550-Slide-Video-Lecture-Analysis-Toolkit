const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'api-module.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const requests = [];
const loaded = [];
const errors = [];
const timers = [];
const context = vm.createContext({
    startProcessButton: require('./process_button_stub.cjs'),
    finishProcessButton: require('./process_button_stub.cjs').finish,
    startElapsedTimer: (container, elapsed = 0) => {
        timers.push(elapsed);
        return () => {};
    },
    console, Date, setTimeout, clearTimeout,
    state: {currentVideoId: 'video', currentTranscript: [], whisperTranscriptPollGeneration: 0},
    elements: {transcriptContainer: {}, regenerateTranscriptBtn: {textContent: 'Regenerate', removeAttribute() {}}},
    document: {getElementById: () => null, addEventListener: () => {}},
    showError: (message) => { if (message) errors.push(message); },
    showNotification: () => {},
    loadTranscript: (transcript) => loaded.push(transcript),
    fetch: async (url) => {
        requests.push(url);
        return {ok: true, status: 200, text: async () => JSON.stringify({
            status: 'complete', transcript: [{text: 'Finished', start: 0}],
        })};
    },
});
vm.runInContext(source, context);
(async () => {
    await context.regenerateTranscript({resumeOnly: true});
    assert.deepEqual(requests, ['/whisper_transcript_status/video']);
    assert.equal(loaded.length, 1);
    assert.deepEqual(errors, []);
    context.renderWhisperProgress({status: 'running', steps_elapsed: 125}, Date.now());
    assert.equal(timers.at(-1), 125, 'Reconnect uses server elapsed, not a fresh browser clock');
    context.renderWhisperProgress({status: 'running', phase: 'identifying_speakers', progress: 0,
        steps_elapsed: 50}, Date.now());
    assert.match(context.elements.transcriptContainer.innerHTML, /overall percentage unavailable/);
    assert.match(context.elements.transcriptContainer.innerHTML, /<progress aria-label="Speaker identification in progress"><\/progress>/);
    assert(!context.elements.transcriptContainer.innerHTML.includes('0%'));
    assert.equal(timers.at(-1), 50);
    vm.runInContext('activeTranscriptAction = null;', context);
    const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'index.html'), 'utf8');
    const toolbar = template.match(/<div class="transcript-export-actions">[\s\S]*?<\/div>/)[0];
    assert.match(toolbar, /id="identifySpeakersBtn"/);
    assert.equal(template.match(/id="identifySpeakersBtn"/g).length, 1);
    assert.match(template, /id="chapterBasis"/);
    for (const mode of ['topics', 'speakers', 'topics_speakers']) assert(template.includes(`value="${mode}"`));
    assert.match(toolbar, /id="speakerMode"/);
    assert.match(toolbar, /value="standard" selected/);
    assert.match(toolbar, /value="fast"/);
    assert.match(toolbar, /Short speaker changes may be less precise/);
    const jsonResponse = data => ({ok: true, status: 200, text: async () => JSON.stringify(data)});
    for (const mode of ['standard', 'fast']) {
        const calls = [];
        context.document.getElementById = id => id === 'speakerMode' ? {value: mode} : null;
        context.fetch = async (url, options) => {
            calls.push({url, options});
            if (url === '/runtime_status') return jsonResponse({speaker_modes: ['standard', 'fast']});
            if (url.startsWith('/generate_whisper_transcript/')) return jsonResponse({success: true});
            return jsonResponse({status: 'complete', transcript: [{text: 'Finished', start: 0}]});
        };
        await context.regenerateTranscript({speakersOnly: true});
        const post = calls.find(call => call.options?.method === 'POST');
        assert(post, 'Speaker identification is submitted');
        const payload = JSON.parse(post.options.body);
        assert.equal(payload.speaker_mode, mode);
        assert.equal(payload.speakers_only, true);
        assert.equal(payload.diarization, true);
        assert.equal(calls.some(call => call.url === '/runtime_status'), mode === 'fast');
    }
    const unsupportedRequests = [];
    context.state.currentTranscript = [{text: 'Keep the existing transcript', start: 0}];
    context.fetch = async (url, options) => {
        unsupportedRequests.push({url, options});
        return jsonResponse({});
    };
    await context.regenerateTranscript({speakersOnly: true});
    assert.deepEqual(unsupportedRequests.map(call => call.url), ['/runtime_status']);
    assert.match(errors.at(-1), /Fast speaker mode needs a server restart/);
    console.log('PASS: reconnect to transcription progress without restarting the job');
})().catch(error => {console.error(error); process.exitCode = 1;});
