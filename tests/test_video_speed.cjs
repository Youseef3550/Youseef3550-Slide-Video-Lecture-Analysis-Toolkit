const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function element() {
    return {value: '', listeners: {}, hidden: false, disabled: false, classList: {toggle() {}},
        addEventListener(name, fn) { this.listeners[name] = fn; },
        setAttribute(name, value) { this[name] = value; },
        show() { this.open = true; }, close() { this.open = false; }};
}
(async () => {
    const ids = Object.fromEntries(['videoSpeedDialog', 'videoSpeedStatus', 'exportVideoSpeed',
        'videoSpeedScope', 'videoSpeedStart', 'videoSpeedEnd', 'videoSpeedOutput', 'videoSpeedStartHere',
        'videoSpeedEndHere', 'startVideoSpeedBtn', 'downloadVideoSpeedBtn', 'openSpeedProjectBtn',
        'openVideoSpeedBtn', 'videoSpeedRange', 'videoPlayer'].map(id => [id, element()]));
    Object.assign(ids.videoPlayer, {currentTime: 12.125, readyState: 4, playbackRate: 1.75});
    ids.videoSpeedScope.value = 'full';
    ids.videoSpeedOutput.value = 'video';
    const requests = [], downloads = [], errors = [], opened = [];
    const storage = new Map();
    const state = {currentVideoId: 'parent', currentTranscriptSource: 'uploaded', currentTranslationLanguage: 'de'};
    let status = 'complete', reject = false, cancelled = false;
    const context = vm.createContext({
        state, setTimeout: fn => setTimeout(fn, 0),
        document: {getElementById: id => ids[id], querySelector: () => null},
        localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
        selectedMediaExportId: () => 'caption-copy', selectedCaptionTrackIndex: () => 1,
        contentLanguage: () => 'en', clipTimestamp: seconds => String(seconds),
        openOptionsDialog: dialog => dialog.show(),
        openDerivedProject: async project => opened.push(project.video_id),
        startProcessButton: require('./process_button_stub.cjs'), showError: message => errors.push(message),
        saveBlobToUserLocation: async (_, filename) => downloads.push(filename),
        fetch: async (url, options) => {
            requests.push({url, options});
            if (url.endsWith('/download')) return {ok: true, blob: async () => ({})};
            if (url.endsWith('/cancel')) { cancelled = true; return {ok: true, json: async () => ({})}; }
            if (options) {
                const payload = JSON.parse(options.body);
                return {ok: !reject, status: 400, json: async () => reject ? {detail: 'Invalid range'}
                    : {job_id: 'job', kind: payload.output === 'project' ? 'project' : 'video'}};
            }
            return {ok: true, json: async () => ({
                status: cancelled ? 'cancelled' : status, download_url: '/video/download', filename: 'Fast.mp4',
                ...(url.startsWith('/chapter_project_jobs/') ? {project: {video_id: 'child', filename: 'Fast.mp4'}} : {}),
            })};
        },
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'video-speed.js'), 'utf8')
        .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, context);
    context.initVideoSpeed();
    ids.openVideoSpeedBtn.listeners.click();
    assert.equal(ids.exportVideoSpeed.value, '1.75');
    await ids.startVideoSpeedBtn.listeners.click();
    let payload = JSON.parse(requests.find(request => request.options).options.body);
    assert.equal(payload.speed, 1.75);
    assert.equal(payload.media_export_id, 'caption-copy');
    assert.equal(payload.language, 'de');
    assert.equal(payload.chapter_language, 'en');
    assert.equal(payload.start, '00:00');
    assert.equal(payload.end, '');
    assert.equal(ids.downloadVideoSpeedBtn.hidden, false);
    assert.equal(ids.openSpeedProjectBtn.hidden, true);
    await ids.downloadVideoSpeedBtn.listeners.click({currentTarget: ids.downloadVideoSpeedBtn});
    assert.deepEqual(downloads, ['Fast.mp4']);
    assert.equal(ids.videoSpeedStatus.textContent, '');
    ids.videoSpeedScope.value = 'range';
    ids.videoSpeedScope.listeners.change();
    assert.equal(ids.videoSpeedRange.hidden, false);
    ids.videoSpeedStartHere.listeners.click();
    assert.equal(ids.videoSpeedStart.value, '12.125');
    ids.videoSpeedEnd.value = '00:20';
    ids.videoSpeedOutput.value = 'project';
    await ids.startVideoSpeedBtn.listeners.click();
    payload = JSON.parse(requests.filter(request => request.options && !request.url.endsWith('/cancel')).at(-1).options.body);
    assert.equal(payload.start, '12.125');
    assert.equal(payload.end, '00:20');
    assert.equal(ids.openSpeedProjectBtn.hidden, false);
    state.outlineRowEditing = true;
    await ids.openSpeedProjectBtn.listeners.click();
    assert.equal(opened.length, 0, 'Opening a new project cannot discard unsaved row edits');
    state.outlineRowEditing = false;
    await ids.openSpeedProjectBtn.listeners.click();
    assert.deepEqual(opened, ['child']);
    reject = true;
    await ids.startVideoSpeedBtn.listeners.click();
    assert.equal(ids.videoSpeedStatus.textContent, 'Invalid range');
    assert.equal(ids.startVideoSpeedBtn.disabled, false);
    reject = false;
    status = 'running';
    const running = ids.startVideoSpeedBtn.listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    await ids.startVideoSpeedBtn.listeners.click();
    await running;
    assert(cancelled);
    assert.equal(ids.videoSpeedStatus.textContent, 'Speed export cancelled.');
    assert.equal(ids.startVideoSpeedBtn.disabled, false);
    state.currentVideoId = 'other';
    const count = requests.length;
    await ids.startVideoSpeedBtn.listeners.click();
    assert.equal(requests.length, count);
    assert.match(ids.videoSpeedStatus.textContent, /selected video changed/);
    console.log('PASS: speed MP4/project output, ranges, source pinning, retimed languages, save, editing guards, cancellation and errors');
})().catch(error => { console.error(error); process.exitCode = 1; });
