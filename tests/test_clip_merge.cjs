const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function element() {
    return {
        children: [], listeners: {}, value: '', dataset: {}, options: [], classes: new Set(),
        classList: {toggle() {}},
        set textContent(value) { this.children = [{textContent: value}]; },
        get textContent() { return this.children.map(child => child.textContent).join(''); },
        get firstChild() { return this.children[0]; },
        append(...children) { this.children.push(...children); this.options.push(...children); },
        replaceChildren() { this.children = []; },
        setAttribute(name, value) { this[name] = value; },
        addEventListener(name, handler) { this.listeners[name] = handler; },
        close() { this.open = false; },
    };
}
(async () => {
    const ids = Object.fromEntries([
        'clipMergeDialog', 'clipMergeStatus', 'clipMergeList', 'startClipMergeBtn',
        'clipMergeFiles', 'clipMergeTitle', 'clipMergeOutput', 'cancelClipMergeBtn', 'openClipMergeBtn',
        'extraOptionsMenu', 'downloadMergedClipsBtn', 'openMergedProjectBtn', 'uploadedVideos', 'openClipTrimBtn',
    ].map(id => [id, element()]));
    const remembered = new Map();
    const uploads = [], opened = [], downloads = [], projectChoices = [];
    const trimRequests = [];
    let progressReads = 0, cancelMode = false, cancelled = false;
    const context = vm.createContext({
        FormData, localStorage: {
            getItem: key => remembered.get(key) || null,
            setItem: (key, value) => remembered.set(key, value),
        },
        document: {getElementById: id => ids[id], createElement: element},
        openOptionsDialog: dialog => { dialog.open = true; },
        loadUploadedVideo: async id => opened.push(id),
        saveBlobToUserLocation: async (blob, name) => downloads.push(name),
        startElapsedTimer: () => () => {},
        startProcessButton: button => {
            const finish = () => {};
            finish.update = options => { button.disabled = !options.cancellable || options.stopping; };
            return finish;
        },
        setTimeout: callback => setTimeout(callback, 0),
        fetch: async (url, options) => {
            if (url === '/merge_uploaded_clips' || url === '/trim_uploaded_clips') {
                uploads.push(options.body.getAll('files').map(file => file.name));
                trimRequests.push({url, ranges: JSON.parse(options.body.get('trim_ranges'))});
                const project = options.body.get('save_project') === 'true';
                projectChoices.push(project);
                return {ok: true, json: async () => ({job_id: 'job', project_id: project ? 'project' : null})};
            }
            if (url.endsWith('/cancel')) cancelled = true;
            if (url === '/download') return {ok: true, blob: async () => new Blob(['video'])};
            return {ok: true, json: async () => ({
                status: cancelled ? 'cancelled' : cancelMode || progressReads++ === 0 ? 'running' : 'complete',
                steps: [{message: 'Preparing clips'}], title: 'Compilation',
                filename: 'Merged.mp4', download_url: '/download',
            })};
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'custom-clip-range.js'), 'utf8')
        .replace(/^export /gm, ''), context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'clip-merge.js'), 'utf8')
        .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
    context.initClipMerge();
    ids.openClipTrimBtn.listeners.click();
    assert.equal(ids.clipMergeDialog.open, true);
    ids.clipMergeTitle.value = 'Compilation';
    ids.clipMergeOutput.value = 'video';
    ids.clipMergeFiles.listeners.change({target: {files: [
        new File(['red'], 'Red.mp4'), new File(['blue'], 'Blue.mp4'),
    ]}});
    ids.clipMergeList.children[1].children[1].listeners.click();
    await ids.startClipMergeBtn.listeners.click();
    assert.deepEqual(uploads[0], ['Blue.mp4', 'Red.mp4'], 'Upload order follows the reordered list');
    assert.equal(ids.downloadMergedClipsBtn.hidden, false);
    assert.equal(ids.openMergedProjectBtn.hidden, true);
    assert.match(ids.clipMergeStatus.textContent, /No project was created/);
    assert.equal(JSON.parse(remembered.get('lectureseek-upload-merge')).project_id, null);
    await ids.downloadMergedClipsBtn.listeners.click({currentTarget: ids.downloadMergedClipsBtn});
    assert.deepEqual(downloads, ['Merged.mp4']);
    ids.clipMergeOutput.value = 'project';
    await ids.startClipMergeBtn.listeners.click();
    assert.equal(ids.openMergedProjectBtn.hidden, false);
    assert.match(ids.clipMergeStatus.textContent, /independent project/);
    assert.deepEqual(projectChoices, [false, true]);
    await ids.openMergedProjectBtn.listeners.click();
    assert.deepEqual(opened, ['project']);
    assert.equal(ids.uploadedVideos.value, 'project');
    ids.clipMergeList.children[1].children[3].listeners.click();
    assert.equal(ids.startClipMergeBtn.textContent, 'Trim clip');
    const start = ids.clipMergeList.children[0].children[4].children[0].children.find(child => child['aria-label']);
    const end = ids.clipMergeList.children[0].children[4].children[1].children.find(child => child['aria-label']);
    start.value = '00:01.250';
    start.listeners.input();
    end.value = '00:02.750';
    end.listeners.input();
    ids.clipMergeOutput.value = 'video';
    await ids.startClipMergeBtn.listeners.click();
    assert.equal(trimRequests.at(-1).url, '/trim_uploaded_clips');
    assert.deepEqual(trimRequests.at(-1).ranges, [{start: '00:01.250', end: '00:02.750'}]);
    const lastCount = trimRequests.length;
    const badEnd = ids.clipMergeList.children[0].children[4].children[1].children.find(child => child['aria-label']);
    badEnd.value = '00:00';
    badEnd.listeners.input();
    await ids.startClipMergeBtn.listeners.click();
    assert.equal(trimRequests.length, lastCount, 'Invalid trim does not upload files');
    assert.match(ids.clipMergeStatus.textContent, /End after Start/);
    badEnd.value = '';
    badEnd.listeners.input();
    cancelMode = true;
    const waiting = ids.startClipMergeBtn.listeners.click();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(ids.startClipMergeBtn.disabled, false, 'The running merge button itself remains available to stop');
    await ids.startClipMergeBtn.listeners.click();
    await waiting;
    assert.match(ids.clipMergeStatus.textContent, /cancelled/);
    assert.equal(ids.startClipMergeBtn.disabled, false);
    console.log('PASS: trimming, merge ordering, output choices, validation, project opening and cancellation');
})().catch(error => { console.error(error); process.exitCode = 1; });
