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
const events = [];
const listeners = {};
const context = vm.createContext({
    startProcessButton: require('./process_button_stub.cjs'),
    finishProcessButton: require('./process_button_stub.cjs').finish,
    startElapsedTimer: (container, elapsed = 0) => {
        timers.push(elapsed);
        return () => {};
    },
    console, Date, setTimeout, clearTimeout,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    state: {currentVideoId: 'video', currentTranscript: [], whisperTranscriptPollGeneration: 0},
    elements: {transcriptContainer: {}, regenerateTranscriptBtn: {textContent: 'Regenerate', removeAttribute() {}}},
    document: {getElementById: () => null, querySelector: () => null, createElement: () => ({
        textContent: '', get innerHTML() { return this.textContent; },
    }),
        addEventListener: (type, handler) => { listeners[type] = handler; },
        dispatchEvent(event) { events.push(event); }},
    showError: (message) => { if (message) errors.push(message); },
    showNotification: () => {},
    loadTranscript: (transcript) => loaded.push(transcript),
    refreshTranscriptVersions: async () => {},
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
    assert.equal(events.filter(event => event.type === 'newTranscriptReady').length, 1);
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
    assert.match(toolbar, /value="standard"/);
    assert.match(toolbar, /value="fast" selected/);
    assert.match(toolbar, /Short speaker changes may be less precise/);
    const jsonResponse = data => ({ok: true, status: 200, text: async () => JSON.stringify(data)});
    const speakerButton = {textContent: 'Label speakers', removeAttribute() {}};
    context.document.getElementById = id => id === 'identifySpeakersBtn' ? speakerButton : null;
    context.renderWhisperProgress({status: 'in_progress'}, Date.now());
    const staleCalls = [];
    context.fetch = async (url, options) => {
        staleCalls.push({url, options});
        if (url === '/runtime_status') return jsonResponse({speaker_modes: ['standard', 'fast']});
        return jsonResponse(url.startsWith('/generate_whisper_transcript/')
            ? {success: true} : {status: 'complete', transcript: [{text: 'Finished', start: 0}]});
    };
    await context.regenerateTranscript({speakersOnly: true});
    assert(staleCalls.some(call => call.options?.method === 'POST'),
        'Completed background processing must not block speaker identification');
    context.renderWhisperProgress({status: 'in_progress'}, Date.now());
    staleCalls.length = 0;
    context.fetch = async (url, options) => {
        staleCalls.push({url, options});
        return jsonResponse({status: 'in_progress'});
    };
    await context.regenerateTranscript({speakersOnly: true});
    assert.equal(staleCalls.length, 1, 'A real running transcript job is checked but not replaced');
    assert(!staleCalls.some(call => call.options?.method === 'POST'));
    context.finishTranscriptAction('another-video');
    assert(vm.runInContext('activeTranscriptAction !== null', context), 'Cleanup is scoped to its video');
    context.finishTranscriptAction('video');
    assert(vm.runInContext('activeTranscriptAction === null', context));
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
    assert.equal(events.filter(event => event.type === 'newTranscriptReady').length, 1,
        'Labeling existing speakers does not trigger a new-transcript prompt');
    const unsupportedRequests = [];
    context.state.currentTranscript = [{text: 'Keep the existing transcript', start: 0}];
    context.fetch = async (url, options) => {
        unsupportedRequests.push({url, options});
        return jsonResponse({});
    };
    await context.regenerateTranscript({speakersOnly: true});
    assert.deepEqual(unsupportedRequests.map(call => call.url), ['/runtime_status']);
    assert.match(errors.at(-1), /Fast speaker mode needs a server restart/);
    const controls = Object.fromEntries(['.transcript-job-message', 'progress', '[data-job-details]',
        '[data-job-stop]', '[data-job-dismiss]'].map(key => [key, {
        hidden: false, removeAttribute(name) { delete this[name]; },
    }]));
    const indicator = {hidden: true, querySelector: key => controls[key]};
    const browse = {};
    context.document.getElementById = id => ({
        transcriptJobStatus: indicator, browseDuringTranscriptionBtn: browse,
        identifySpeakersBtn: speakerButton, speakerMode: {value: 'standard'},
    })[id] || null;
    const running = batch => ({status: 'in_progress', phase: 'identifying_speakers',
        steps: [{elapsed: 20, message: `Detecting speakers: embeddings ${batch}%`}], steps_elapsed: 30});
    let statusPolls = 0;
    const completionTimers = new Map();
    let timerId = 0;
    context.clearTimeout = id => completionTimers.delete(id);
    const backgroundRequests = [];
    context.fetch = async (url, options) => {
        backgroundRequests.push({url, options});
        statusPolls++;
        if (statusPolls <= 2) return jsonResponse(running(statusPolls * 25));
        return jsonResponse({status: 'complete', transcript: [{text: 'Labeled', start: 0}]});
    };
    const beforeBackgroundLoads = loaded.length;
    context.setTimeout = (callback, milliseconds) => {
        if (milliseconds === 5000) {
            const id = ++timerId;
            completionTimers.set(id, () => { completionTimers.delete(id); callback(); });
            return id;
        }
        return setImmediate(() => {
        if (statusPolls === 1) {
            assert.equal(indicator.hidden, false);
            assert.match(controls['.transcript-job-message'].textContent, /embeddings 25%/);
            assert.equal(controls.progress.value, undefined, 'Speaker percent is a substep, not overall progress');
            browse.onclick();
            assert.equal(controls['[data-job-details]'].hidden, false);
            assert.equal(controls['[data-job-stop]'].hidden, false);
            context.elements.transcriptContainer.innerHTML = 'Chosen saved transcript';
            context.state.currentTranscript = [{text: 'Chosen saved transcript'}];
            listeners.transcriptVersionSelected();
        } else {
            assert.equal(context.elements.transcriptContainer.innerHTML, 'Chosen saved transcript');
            assert.match(controls['.transcript-job-message'].textContent, /embeddings 50%/);
        }
        callback();
        });
    };
    await context.regenerateTranscript({resumeOnly: true, speakersOnly: true});
    assert.equal(statusPolls, 3, `Browsing does not cancel progress polling: ${errors.at(-1)}`);
    assert.equal(loaded.length, beforeBackgroundLoads + 1, 'Completion preserves the selected saved transcript');
    assert(!backgroundRequests.some(request => request.options?.method === 'POST'));
    assert.match(controls['.transcript-job-message'].textContent, /complete/);
    assert.equal(controls['[data-job-details]'].textContent, 'View result');
    assert.equal(controls['[data-job-stop]'].hidden, true);
    assert.equal(controls['[data-job-dismiss]'].hidden, false);
    assert(vm.runInContext('activeTranscriptAction === null', context));
    assert.equal(completionTimers.size, 1, 'Completion clears after five seconds');
    [...completionTimers.values()][0]();
    assert.equal(indicator.hidden, true);
    context.fetch = async () => jsonResponse({status: 'error', error: "name 'Path' is not defined"});
    await context.regenerateTranscript({resumeOnly: true, speakersOnly: true, background: true});
    assert.match(controls['.transcript-job-message'].textContent, /failed: name 'Path' is not defined/);
    assert.equal(context.elements.transcriptContainer.innerHTML, 'Chosen saved transcript');
    assert.equal(controls['[data-job-details]'].hidden, true);
    assert.equal(completionTimers.size, 0, 'Errors have no expiration timer');
    controls['[data-job-dismiss]'].onclick();
    assert.equal(indicator.hidden, true);
    context.renderWhisperProgress(running(75), Date.now());
    browse.onclick();
    controls['[data-job-details]'].onclick();
    assert.match(context.elements.transcriptContainer.innerHTML, /transcript-processing/);
    context.fetch = async (url, options) => {
        assert.equal(url, '/cancel_whisper_transcript/video');
        assert.equal(options.method, 'POST');
        return jsonResponse({success: true, transcript: [{text: 'Restored'}]});
    };
    await controls['[data-job-stop]'].onclick();
    assert.match(controls['.transcript-job-message'].textContent, /stopped/);
    assert(vm.runInContext('activeTranscriptAction === null', context));
    context.renderWhisperProgress(running(80), Date.now());
    listeners.videoSelectionChanged();
    assert.equal(indicator.hidden, true, 'Old project progress does not leak into another project');
    assert.match(template, /id="transcriptJobStatus"[\s\S]*?<\/section>\s*<div class="main-content">/);

    // Exercise the real asynchronous upload-completion path, not just its ready-event helper.
    context.state.currentTranscript = [];
    context.resetVideoStates = () => listeners.videoSelectionChanged();
    context.FormData = class { append() {} };
    context.showLoading = () => {};
    context.setupVideoPlayer = () => {};
    context.elements.loadingIndicator = {querySelector: () => ({})};
    context.elements.generateSummaryBtn = {};
    context.elements.exportChaptersBtn = {};
    context.elements.detectScenesBtn = {};
    context.elements.scenesContainer = {};
    context.elements.videoPlayer = {
        set src(value) { setImmediate(() => this.onloadedmetadata()); },
    };
    context.uploadVideoWithProgress = async () => ({json: async () => ({
        success: true, video_id: 'uploaded-new', video_url: '/video/uploaded-new', transcript_in_progress: true,
    })});
    let finishUpload;
    context.fetch = async () => new Promise(resolve => { finishUpload = resolve; });
    context.setInterval = () => 1;
    context.clearInterval = () => {};
    const readyBeforeUpload = events.filter(event => event.type === 'newTranscriptReady').length;
    await context.processVideoUpload({name: 'new.mp4'});
    browse.onclick();
    finishUpload(jsonResponse({status: 'complete', transcript: [{text: 'New uploaded transcript', start: 0}]}));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(context.state.currentTranscript[0].text, 'New uploaded transcript');
    assert.equal(events.filter(event => event.type === 'newTranscriptReady').length, readyBeforeUpload + 1,
        'Uploaded-video completion prompts for chapters/slides even after browsing in the background');
    assert.equal(events.at(-1).detail.videoId, 'uploaded-new');
    context.renderWhisperProgress(running(10), Date.now());
    assert.equal(completionTimers.size, 0, 'A prior completion timer must not hide a new job');
    context.state.currentTranscript = [];
    context.elements.transcriptContainer.innerHTML = '';
    context.loadTranscript = transcript => {
        loaded.push(transcript);
        context.state.currentTranscript = transcript;
        context.elements.generateSummaryBtn.disabled = !transcript.length;
        context.elements.transcriptContainer.innerHTML = transcript[0]?.text || '';
    };
    context.renderWhisperProgress({...running(50), available_transcript: [
        {start: 0, text: 'Available before speakers finish'},
    ]}, Date.now());
    assert.equal(context.state.currentTranscript[0].text, 'Available before speakers finish');
    assert.equal(context.elements.generateSummaryBtn.disabled, false);
    assert.equal(context.elements.transcriptContainer.innerHTML, 'Available before speakers finish');
    assert.match(controls['.transcript-job-message'].textContent, /embeddings 50%/);
    context.renderWhisperProgress({...running(60), available_transcript: [{text: 'Other snapshot'}]}, Date.now());
    assert.equal(context.state.currentTranscript[0].text, 'Available before speakers finish',
        'Further speaker polls must not replace the transcript being used for chapters');
    context.finishTranscriptAction(context.state.currentVideoId);
    let reconnectChecks = 0;
    context.fetch = async (url, options) => {
        if (url === '/runtime_status') return jsonResponse({speaker_modes: ['standard', 'fast']});
        if (options?.method === 'POST') return jsonResponse({success: false, error: 'Generate a transcript first'});
        reconnectChecks++;
        return jsonResponse(reconnectChecks === 1 ? running(70)
            : {status: 'complete', transcript: [{text: 'Labeled', start: 0}]});
    };
    const errorsBeforeReconnect = errors.length;
    await context.regenerateTranscript({speakersOnly: true});
    assert.equal(reconnectChecks, 2, 'An already running job is reconnected and polled after a rejected retry');
    assert.equal(errors.length, errorsBeforeReconnect, 'A temporary missing-transcript response must not hide an active job');
    const compactCss = fs.readFileSync(path.join(__dirname, '..', 'static', 'compact-layout.css'), 'utf8');
    assert.match(compactCss, /\.project-search-bar\s*\{[^}]*flex-wrap:\s*nowrap/);
    console.log('PASS: reconnect to transcription progress without restarting the job');
})().catch(error => {console.error(error); process.exitCode = 1;});
