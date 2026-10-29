const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function element(tag = 'div') {
    const classes = new Set();
    return {
        tag, children: [], listeners: {}, value: '', hidden: false, open: false,
        classList: {toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
            contains: name => classes.has(name)},
        addEventListener(name, callback) { this.listeners[name] = callback; },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        focus() { this.focused = true; },
        close() { this.open = false; this.listeners.close?.(); },
        set textContent(value) { this.text = value; this.children = []; },
        get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); },
    };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
    const ids = Object.fromEntries([
        'librarySearchDialog', 'librarySearchResults', 'librarySearchStatus', 'librarySearchMoreBtn',
        'openLibrarySearchBtn', 'librarySearchQuery', 'librarySearchKind', 'librarySearchForm',
        'videoPlayer', 'uploadedVideos',
        'projectSearchForm', 'projectSearchScope',
    ].map(id => [id, element()]));
    ids.librarySearchKind.value = 'all';
    ids.projectSearchScope.value = 'all';
    ids.videoPlayer.duration = 100;
    ids.videoPlayer.currentTime = 0;
    const state = {currentVideoId: 'video-a'};
    const requests = [], opened = [];
    const revealed = [];
    let deferred = null, fail = false, failLoad = false;
    let response = {
        total: 2, warnings: [], results: [{
            video_id: 'video-b', filename: '<b>Lecture.mp4</b>', kind: 'section',
            title: 'Model', snippet: 'Literal C++ <script> evidence.', timestamp: 12.125,
            source: 'Saved version: Earlier transcript',
        }],
    };
    const context = vm.createContext({
        state, AbortController, URLSearchParams,
        revealOutlineSearchResult: result => { revealed.push(result); return {}; },
        showNotification() {},
        document: {getElementById: id => ids[id], createElement: element,
            createTextNode: text => ({textContent: text}), querySelector: () => null, addEventListener() {}},
        openOptionsDialog: dialog => { dialog.open = true; },
        clipTimestamp: time => `timestamp:${time}`,
        loadUploadedVideo: async id => {
            opened.push(id);
            if (failLoad) return false;
            state.currentVideoId = id;
            return true;
        },
        fetch: async (url, options) => {
            requests.push({url, options});
            if (deferred) return await deferred;
            return {ok: !fail, json: async () => fail ? {detail: 'Search unavailable'} : response};
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'library-search.js'), 'utf8')
        .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, ''), context);
    context.initLibrarySearch();
    const submit = async query => {
        ids.librarySearchQuery.value = query;
        ids.librarySearchForm.listeners.submit({preventDefault() {}});
        await flush();
    };
    ids.projectSearchForm.listeners.submit({preventDefault() {}});
    assert.equal(ids.librarySearchDialog.open, true);
    await submit('');
    assert.equal(requests.length, 0);
    assert.equal(ids.librarySearchStatus.textContent, '', 'Empty search needs no instructional message');
    await submit('C++');
    assert.match(requests[0].url, /q=C%2B%2B/);
    const row = ids.librarySearchResults.children[0];
    assert.equal(row.children[0].textContent, '<b>Lecture.mp4</b> — timestamp:12.125');
    assert.equal(row.children[2].textContent, 'Literal C++ <script> evidence.');
    assert.equal(row.children[2].children.find(child => child.tag === 'mark').textContent, 'C++');
    assert.equal(row.children[2].children.some(child => child.tag === 'script'), false);
    assert.equal(ids.librarySearchMoreBtn.hidden, false);
    response = {...response, results: [{...response.results[0], timestamp: null, kind: 'summary'}]};
    ids.librarySearchMoreBtn.listeners.click();
    await flush();
    assert.match(requests.at(-1).url, /offset=1/);
    assert.equal(ids.librarySearchResults.children.length, 2);
    assert.equal(ids.librarySearchMoreBtn.hidden, true);
    state.outlineRowEditing = true;
    await row.children[0].listeners.click();
    assert.equal(opened.length, 0);
    assert.match(ids.librarySearchStatus.textContent, /Save or cancel/);
    state.outlineRowEditing = false;
    failLoad = true;
    await row.children[0].listeners.click();
    assert.match(ids.librarySearchStatus.textContent, /Could not load/);
    assert.equal(ids.videoPlayer.currentTime, 0);
    failLoad = false;
    await row.children[0].listeners.click();
    assert.equal(state.currentVideoId, 'video-b');
    assert.equal(ids.videoPlayer.currentTime, 12.125);
    assert.equal(ids.librarySearchDialog.open, false);
    assert.equal(revealed[0].kind, 'section');
    assert.equal(revealed[0].timestamp, 12.125, 'Opening a section result must reveal its outline row as well as seek');
    ids.librarySearchDialog.open = true;
    const untimed = ids.librarySearchResults.children[1].children[0];
    ids.videoPlayer.currentTime = 25;
    await untimed.listeners.click();
    assert.equal(ids.videoPlayer.currentTime, 25, 'Untimed summaries do not seek');
    ids.librarySearchDialog.open = true;
    response = {total: 1, warnings: ['Unreadable transcript'], results: []};
    await submit('word');
    assert.equal(ids.librarySearchStatus.classList.contains('outline-error'), true);
    assert.match(ids.librarySearchStatus.textContent, /Unreadable transcript/);
    fail = true;
    await submit('other');
    assert.match(ids.librarySearchStatus.textContent, /Search unavailable/);
    fail = false;
    let resolve;
    deferred = new Promise(done => { resolve = done; });
    await submit('older');
    const pendingSignal = requests.at(-1).options.signal;
    ids.librarySearchQuery.value = 'newer';
    ids.librarySearchQuery.listeners.input();
    assert.equal(ids.librarySearchStatus.textContent, '', 'Typing needs no Press Search reminder');
    assert.equal(pendingSignal.aborted, true);
    deferred = null;
    response = {total: 0, warnings: [], results: []};
    await submit('newer');
    resolve({ok: true, json: async () => ({total: 1, warnings: [], results: [{snippet: 'stale'}]})});
    await flush();
    assert.equal(ids.librarySearchResults.children.length, 0, 'Stale search responses cannot replace new results');
    assert.match(ids.librarySearchStatus.textContent, /0 matches/);
    ids.librarySearchKind.value = 'section';
    ids.librarySearchKind.listeners.change();
    await flush();
    assert.match(requests.at(-1).url, /kind=section/);
    ids.projectSearchScope.value = 'current';
    ids.projectSearchScope.listeners.change();
    await flush();
    assert.match(requests.at(-1).url, /project_id=video-b/);
    state.currentVideoId = null;
    const count = requests.length;
    await submit('word');
    assert.equal(requests.length, count, 'Open-project search must not silently search all projects without an open project');
    assert.match(ids.librarySearchStatus.textContent, /Open a project first/);
    state.currentVideoId = 'video-b';
    ids.projectSearchScope.value = 'all';
    ids.projectSearchScope.listeners.change();
    await flush();
    assert(!requests.at(-1).url.includes('project_id='));
    ids.librarySearchDialog.close();
    assert.equal(requests.at(-1).options.signal.aborted, true);
    console.log('PASS: literal highlighted search, pagination, source labels, safe seeking, errors and stale request guards');
})().catch(error => { console.error(error); process.exitCode = 1; });
