const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function element() {
    return {
        listeners: {}, attrs: {}, value: '1', readyState: 4, currentTime: 0, playbackRate: 1,
        volume: 1, muted: false, paused: true, classList: {toggle() {}},
        addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
        emit(name) { return Promise.all((this.listeners[name] || []).map(fn => fn())); },
        setAttribute(name, value) { this.attrs[name] = value; },
        removeAttribute(name) { delete this.attrs[name]; },
        getAttribute(name) { return this.attrs[name]; },
        load() {},
        appendChild() {},
        pause() { this.paused = true; void this.emit('pause'); },
        async play() { this.paused = false; await this.emit('play'); },
    };
}
(async () => {
    const ids = Object.fromEntries(['videoPlayer', 'compatibleAudioMode', 'compatibleAudioVolume',
        'compatibleAudioControls', 'compatibleAudioStatus'].map(id => [id, element()]));
    const video = ids.videoPlayer, audio = element();
    video.currentSrc = '/caption_copy/video/copy';
    video.attrs.src = video.currentSrc;
    video.currentTime = 25.125;
    const state = {currentVideoId: 'video'};
    const requests = [], documentListeners = {};
    const preferences = new Map([['lectureseek-audio-mode', 'native']]);
    let fail = false, hasAudio = true;
    video.canPlayType = () => 'probably';
    const context = vm.createContext({
        state, selectedMediaExportId: () => 'copy', setTimeout,
        startElapsedTimer: () => () => {},
        localStorage: {getItem: key => preferences.get(key), setItem: (key, value) => preferences.set(key, value)},
        document: {getElementById: id => ids[id], createElement: tag => tag === 'audio' ? audio : element(), body: {append() {}},
            addEventListener(name, fn) { documentListeners[name] = fn; }},
        fetch: async (url, options) => {
            requests.push({url, options});
            return {ok: !fail, json: async () => fail ? {detail: 'No audio stream'} : options
                ? url.startsWith('/audio_info/') ? {has_audio: hasAudio, stream: hasAudio ? {codec_name: 'aac'} : null}
                    : {job_id: 'job'} : {status: 'complete', download_url: '/audio.wav'}};
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'compatible-audio.js'), 'utf8')
        .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
    context.initCompatibleAudio();
    assert.equal(ids.compatibleAudioControls.hidden, true, 'Native audio needs no extra volume slider');
    const mode = ids.compatibleAudioMode;
    mode.value = 'compatible';
    await mode.emit('change');
    assert.equal(preferences.get('lectureseek-compatible-audio:/caption_copy/video/copy'), 'on');
    assert.equal(requests[0].url, '/compatible_audio/video');
    assert.equal(JSON.parse(requests[0].options.body).media_export_id, 'copy');
    assert.equal(audio.src, '/audio.wav');
    assert.equal(video.muted, true);
    assert.equal(video.paused, true, 'Preparation does not autoplay');
    assert.equal(ids.compatibleAudioStatus.hidden, true, 'Successful setup leaves no persistent instructional message');
    await audio.emit('loadedmetadata');
    assert.equal(audio.currentTime, 25.125);
    await video.play();
    assert.equal(audio.paused, false);
    video.currentTime = 50;
    video.seeking = true;
    await video.emit('seeking');
    assert.equal(audio.paused, true);
    assert.equal(audio.currentTime, 50);
    video.seeking = false;
    await video.emit('seeked');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(audio.paused, false);
    video.playbackRate = 1.5;
    await video.emit('ratechange');
    assert.equal(audio.playbackRate, 1.5);
    audio.currentTime = 48;
    await video.emit('timeupdate');
    assert.equal(audio.currentTime, 50, 'Drift is corrected');
    ids.compatibleAudioVolume.value = '0.4';
    await ids.compatibleAudioVolume.emit('input');
    assert.equal(video.volume, 0.4);
    assert.equal(audio.volume, 0.4);
    await audio.emit('waiting');
    assert.equal(video.paused, true, 'Audio buffering pauses video');
    await audio.emit('canplay');
    assert.equal(ids.compatibleAudioStatus.hidden, true, 'Successful buffering clears its status');
    assert.equal(video.paused, false, 'Playback resumes after audio buffering');
    await audio.emit('waiting');
    context.document.hidden = true;
    await audio.emit('canplay');
    assert.equal(video.paused, true, 'Do not request video playback while the page is hidden');
    assert.match(ids.compatibleAudioStatus.textContent, /background/);
    context.document.hidden = false;
    await documentListeners.visibilitychange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(video.paused, false, 'Resume pending playback when the page becomes visible');
    assert.equal(ids.compatibleAudioStatus.hidden, true);
    await audio.emit('waiting');
    const normalPlay = video.play;
    video.play = async () => { throw Object.assign(new Error('video-only background media was paused to save power'), {name: 'AbortError'}); };
    await audio.emit('canplay');
    assert.equal(ids.compatibleAudioStatus.textContent, 'Playback paused by the browser to save power. Press Play to continue.');
    video.play = normalPlay;
    await video.play();
    assert.equal(ids.compatibleAudioStatus.hidden, true, 'A successful manual Play clears the power-saving notice');
    video.pause = function () { this.paused = true; };
    await audio.emit('waiting');
    await video.emit('pause');
    await audio.emit('canplay');
    assert.equal(video.paused, false, 'Asynchronous native pause events preserve buffering resume');
    video.pause = function () { this.paused = true; void this.emit('pause'); };
    video.pause();
    assert.equal(audio.paused, true);
    mode.value = 'native';
    await mode.emit('change');
    assert.equal(preferences.get('lectureseek-compatible-audio:/caption_copy/video/copy'), 'off');
    assert.equal(video.muted, false);
    assert.equal(ids.compatibleAudioControls.hidden, true);
    mode.value = 'compatible';
    await mode.emit('change');
    video.attrs.src = '/video/other';
    await video.emit('loadstart');
    assert.equal(ids.compatibleAudioControls.hidden, true);
    assert.equal(video.muted, false);
    fail = true;
    await mode.emit('change');
    assert.match(ids.compatibleAudioStatus.textContent, /No audio stream/);
    assert.equal(video.muted, false);
    fail = false;
    mode.value = 'native';
    await mode.emit('change');
    video.attrs.src = '/video/native';
    mode.value = 'auto';
    await mode.emit('change');
    assert.equal(ids.compatibleAudioControls.hidden, true, 'Automatic mode keeps controls hidden when native audio works');
    const preparations = () => requests.filter(request => request.url.startsWith('/compatible_audio/')).length;
    const before = preparations();
    video.webkitAudioDecodedByteCount = 50;
    video.paused = false;
    video.currentTime = 10;
    await video.emit('timeupdate');
    video.currentTime = 15;
    await video.emit('timeupdate');
    assert.equal(preparations(), before, 'Decoded native audio never creates a redundant WAV');
    video.webkitAudioDecodedByteCount = 0;
    video.currentTime = 20;
    await video.emit('timeupdate');
    video.currentTime = 24;
    await video.emit('timeupdate');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(preparations(), before + 1, 'Audio present but not decoded triggers automatic fallback');
    assert.equal(ids.compatibleAudioControls.hidden, false);
    await audio.emit('loadedmetadata');
    assert.equal(video.paused, false, 'Automatic fallback resumes prior playback');
    mode.value = 'native';
    await mode.emit('change');
    hasAudio = false;
    video.attrs.src = '/video/silent';
    mode.value = 'auto';
    await mode.emit('change');
    const silentPreparations = preparations();
    video.paused = false;
    video.currentTime = 30;
    await video.emit('timeupdate');
    video.currentTime = 35;
    await video.emit('timeupdate');
    assert.equal(preparations(), silentPreparations, 'A video without an audio stream does not trigger conversion');
    assert.equal(ids.compatibleAudioControls.hidden, true);
    console.log('PASS: automatic/native/compatible audio, conditional controls, no persistent help, sync, playback, buffering and cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
