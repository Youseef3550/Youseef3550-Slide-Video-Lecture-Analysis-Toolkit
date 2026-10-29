const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = name => fs.readFileSync(path.join(__dirname, '..', 'static', 'js', name), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
function element() {
    const classes = new Set();
    return {
        listeners: {}, value: '', files: [], disabled: false, hidden: false,
        classList: {toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
            contains: name => classes.has(name)},
        addEventListener(name, callback) { this.listeners[name] = callback; },
        appendChild() {},
        setAttribute(name, value) { this[name] = value; },
        removeAttribute(name) { delete this[name]; },
        set textContent(value) { this.firstChild = {textContent: value}; },
        get textContent() { return this.firstChild?.textContent || ''; },
    };
}
(async () => {
    const ids = Object.fromEntries([
        'videoSplitDialog', 'videoSplitStatus', 'splitVideoFile', 'splitVideoCuts', 'startVideoSplitBtn',
        'cancelVideoSplitBtn', 'downloadVideoSplitBtn', 'extraOptionsMenu', 'splitVideoFileLabel',
        'videoSplitHeading', 'chapterCutPoints', 'openUploadedSplitBtn', 'openProjectSplitBtn',
        'chapterBasis', 'chapterCutPointsField',
    ].map(id => [id, element()]));
    const state = {currentVideoId: null};
    const errors = [], requests = [], downloads = [], remembered = new Map();
    let running = false, cancelled = false, fail = false;
    const context = vm.createContext({
        state, FormData, Blob, setTimeout: callback => setTimeout(callback, 0),
        document: {getElementById: id => ids[id], createElement: element, dispatchEvent() {}},
        localStorage: {getItem: key => remembered.get(key) || null,
            setItem: (key, value) => remembered.set(key, value)},
        openOptionsDialog: dialog => { dialog.open = true; },
        showError: message => errors.push(message), selectedMediaExportId: () => 'caption-copy',
        startElapsedTimer: () => () => {},
        startProcessButton: button => {
            const finish = () => {};
            finish.update = options => { button.disabled = !options.cancellable || options.stopping; };
            return finish;
        },
        saveBlobToUserLocation: async (blob, name) => downloads.push(name),
        fetch: async (url, options) => {
            if (url === '/split_uploaded_video' || url.startsWith('/split_video/')) {
                requests.push({url, options});
                return {ok: !fail, json: async () => fail ? {detail: 'Cut outside video'} : {job_id: 'split', parts: 3}};
            }
            if (url.endsWith('/cancel')) cancelled = true;
            if (url === '/download') return {ok: true, blob: async () => new Blob(['zip'])};
            return {ok: true, json: async () => ({status: cancelled ? 'cancelled' : running ? 'running' : 'complete',
                steps: [{message: 'Creating part'}], filename: 'Video_parts.zip', download_url: '/download'})};
        },
    });
    vm.runInContext(source('custom-clip-range.js'), context);
    vm.runInContext(source('video-split.js'), context);
    context.initVideoSplit();
    assert.equal(ids.chapterCutPointsField.hidden, true);
    ids.chapterBasis.value = 'timestamps';
    ids.chapterBasis.listeners.change();
    assert.equal(ids.chapterCutPointsField.hidden, false);
    ids.openProjectSplitBtn.listeners.click();
    assert.match(errors.at(-1), /Load a video/);
    ids.openUploadedSplitBtn.listeners.click();
    assert.equal(ids.splitVideoFileLabel.hidden, false);
    ids.splitVideoCuts.value = '00:01, 00:02.500';
    await ids.startVideoSplitBtn.listeners.click();
    assert.match(ids.videoSplitStatus.textContent, /Choose one video/);
    ids.splitVideoFile.files = [new File(['video'], 'source.mp4')];
    ids.splitVideoCuts.value = '00:02, 00:01';
    await ids.startVideoSplitBtn.listeners.click();
    assert.equal(requests.length, 0);
    assert.equal(ids.videoSplitStatus.classList.contains('outline-error'), true);
    ids.splitVideoCuts.value = '00:01\n00:02.500';
    await ids.startVideoSplitBtn.listeners.click();
    assert.equal(requests[0].url, '/split_uploaded_video');
    assert.equal(requests[0].options.body.get('file').name, 'source.mp4');
    assert.deepEqual(JSON.parse(requests[0].options.body.get('cut_points')), ['00:01', '00:02.500']);
    assert.equal(ids.downloadVideoSplitBtn.hidden, false);
    await ids.downloadVideoSplitBtn.listeners.click({currentTarget: ids.downloadVideoSplitBtn});
    assert.deepEqual(downloads, ['Video_parts.zip']);
    state.currentVideoId = 'project';
    ids.chapterCutPoints.value = '00:03, 00:05';
    ids.openProjectSplitBtn.listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ids.splitVideoFileLabel.hidden, true);
    state.currentVideoId = 'different-project';
    await ids.startVideoSplitBtn.listeners.click();
    assert.equal(requests[1].url, '/split_video/project', 'Source is pinned when the dialog opens');
    assert.deepEqual(JSON.parse(requests[1].options.body), {
        cut_points: ['00:03', '00:05'], media_export_id: 'caption-copy',
    });
    running = true;
    const pending = ids.startVideoSplitBtn.listeners.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ids.splitVideoCuts.disabled, true);
    assert.equal(ids.startVideoSplitBtn.disabled, false, 'The running split button itself can stop the job');
    await ids.startVideoSplitBtn.listeners.click();
    await pending;
    assert.match(ids.videoSplitStatus.textContent, /cancelled/);
    assert.equal(ids.splitVideoCuts.disabled, false);
    running = cancelled = false;
    fail = true;
    await ids.startVideoSplitBtn.listeners.click();
    assert.match(ids.videoSplitStatus.textContent, /Cut outside video/);
    assert.equal(ids.videoSplitStatus.classList.contains('outline-error'), true);
    assert.equal(ids.downloadVideoSplitBtn.hidden, true);
    assert.equal(ids.startVideoSplitBtn.disabled, false);
    assert.ok(remembered.has('lectureseek-video-split-job'));

    const generationRequests = [];
    const button = element(), status = element();
    context.elements = {generateSummaryBtn: button, exportChaptersBtn: element()};
    Object.assign(state, {currentVideoId: 'project', currentTranscript: [{start: 0, duration: 10, text: 'Source'}]});
    context.showNotification = () => {};
    context.setContentLanguage = () => {};
    context.CustomEvent = function () {};
    context.fetch = async (url, options) => {
        generationRequests.push({url, body: JSON.parse(options.body)});
        return {ok: true, text: async () => JSON.stringify({success: true, chapters: []})};
    };
    vm.runInContext(source('chapters.js') + '\nsetSummaryStatus = () => testStatus; updateChapters = () => {};', Object.assign(context, {testStatus: status}));
    ids.chapterCutPoints.value = '00:02.125; 00:06';
    await context.generateChapters();
    assert.deepEqual(generationRequests[0].body.cut_points, ['00:02.125', '00:06']);
    assert.equal(generationRequests[0].body.basis, 'timestamps');
    assert.equal(generationRequests[0].body.consider_slides, false);
    ids.chapterCutPoints.value = 'bad';
    await context.generateChapters();
    assert.equal(generationRequests.length, 1, 'Invalid cut points do not start generation');
    assert.equal(state.summaryGenerationInProgress, false);
    console.log('PASS: uploaded/project ZIP splitting, validation, pinned source, cancellation, downloads and exact chapter requests');
})().catch(error => { console.error(error); process.exitCode = 1; });
