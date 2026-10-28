const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'chapter-projects.js'), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
function element() {
    return {dataset: {}, listeners: {}, capture: {}, style: {}, value: '', disabled: false,
        classList: {remove() {}, toggle() {}},
        setAttribute(name, value) { this[name] = value; },
        addEventListener(name, handler, capture) { (capture ? this.capture : this.listeners)[name] = handler; },
        removeEventListener(name, handler, capture) { delete (capture ? this.capture : this.listeners)[name]; },
        show() { this.open = true; }, close() { this.open = false; this.listeners.close?.(); }};
}
(async () => {
    const ids = Object.fromEntries([
        'downloadSelectedClipsBtn', 'selectedClipsStatus', 'mergeSelectedClips',
        'customClipDialog', 'customClipStart', 'customClipEnd', 'customClipStatus',
        'customClipBtn', 'customClipForm', 'downloadCustomClipBtn', 'closeCustomClipBtn',
        'clipSelectionActions', 'clipSelectionCount', 'clearClipSelectionBtn', 'selectAllClipsBtn', 'unselectAllClipsBtn',
        'mergeSelectedSectionsBtn', 'deleteSelectedSectionsBtn',
        'videoProgress', 'customClipRange', 'customClipRangeSelection',
        'customClipStartMarker', 'customClipEndMarker', 'customClipSetStartBtn', 'customClipSetEndBtn', 'customClipMarkBtn',
    ].map(id => [id, element()]));
    const state = {currentVideoId: 'parent', currentTranslationLanguage: 'en'};
    const requests = [];
    const downloads = [];
    const errors = [];
    let selected = [];
    let all = [];
    let bulkMode = false;
    let fail = false;
    let cancelSave = false;
    const documentListeners = {};
    const successTimers = new Map();
    let timerId = 0;
    const player = {...element(), currentTime: 12, duration: 60};
    const context = vm.createContext({
        startProcessButton: require('./process_button_stub.cjs'),
        state,
        initClipPrivacy: () => ({open() {}, close() {}, settings: () => []}),
        setTimeout(callback, delay) {
            if (delay !== 4000) return setTimeout(callback, delay);
            successTimers.set(++timerId, callback);
            return timerId;
        },
        clearTimeout(id) { successTimers.delete(id); },
        document: {
            getElementById: id => ids[id],
            addEventListener(name, handler) { documentListeners[name] = handler; }, createElement: element,
            querySelector: selector => selector === 'video' ? player : null,
            querySelectorAll: selector => selector === '.clip-selection' ? all
                : bulkMode ? all.filter(input => input.checked) : selected,
        },
        localStorage: {getItem: () => null},
        contentLanguage: () => 'en',
        selectedMediaExportId: () => 'captioned-copy',
        selectedCaptionTrackIndex: () => 1,
        saveBlobToUserLocation: async (blob, filename) => {
            if (cancelSave) throw Object.assign(new Error('Save cancelled'), {name: 'AbortError'});
            downloads.push(filename);
        },
        showError: error => errors.push(error),
        openOptionsDialog: dialog => dialog.show(),
        fetch: async (url, options) => {
            requests.push({url, payload: options ? JSON.parse(options.body) : null});
            if (options) return {ok: !fail, json: async () => ({job_id: 'job', detail: 'Invalid timestamps'})};
            if (url.endsWith('/download')) return {ok: true, blob: async () => ({})};
            return {ok: true, json: async () => ({
                status: 'complete', download_url: '/job/download', filename: 'Video.mp4',
            })};
        },
    });
    const rangeSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'custom-clip-range.js'), 'utf8')
        .replace(/^export /gm, '');
    vm.runInContext(rangeSource, context);
    vm.runInContext(source, context);
    context.initChapterProjects();
    assert.equal(ids.clipSelectionActions.hidden, true, 'Selection bar starts hidden');
    assert.equal(ids.selectAllClipsBtn.disabled, true);
    assert.equal(ids.unselectAllClipsBtn.disabled, true);
    all = [0, 1, 2].map(index => ({checked: false, dataset: {
        clipSelection: JSON.stringify({chapter_index: index, section_index: null}),
    }}));
    bulkMode = true;
    documentListeners.chaptersUpdated();
    assert.equal(ids.selectAllClipsBtn.disabled, false);
    ids.selectAllClipsBtn.listeners.click();
    assert(all.every(input => input.checked), 'Select all includes collapsed chapter and section rows');
    assert.equal(ids.selectAllClipsBtn.disabled, true);
    assert.equal(ids.unselectAllClipsBtn.disabled, false);
    assert.equal(ids.clipSelectionCount.textContent, '3 selected');
    ids.unselectAllClipsBtn.listeners.click();
    assert(all.every(input => !input.checked));
    assert.equal(ids.unselectAllClipsBtn.disabled, true);
    assert.equal(ids.clipSelectionActions.hidden, true);
    bulkMode = false;
    const selectSections = parts => {
        selected = parts.map(([chapter_index, section_index]) => ({
            dataset: {clipSelection: JSON.stringify({chapter_index, section_index})},
        }));
        documentListeners.sectionSelectionChanged();
    };
    selectSections([[1, 4], [0, 1], [0, 0], [0, 4], [1, 0]]);
    assert.equal(ids.mergeSelectedSectionsBtn.disabled, false, 'An adjacent pair enables merge despite isolated selections');
    selectSections([[1, 2], [0, 4], [0, 3], [1, 1]]);
    assert.equal(ids.mergeSelectedSectionsBtn.disabled, false, 'Multiple groups across chapters can merge');
    selectSections([[0, 2], [1, 3]]);
    assert.equal(ids.mergeSelectedSectionsBtn.disabled, true, 'Adjacency cannot cross chapter boundaries');
    selectSections([[0, 0], [0, 2]]);
    assert.equal(ids.mergeSelectedSectionsBtn.disabled, true, 'Isolated sections alone cannot merge');
    selectSections([[0, 0], [0, 1], [1, null]]);
    assert.equal(ids.mergeSelectedSectionsBtn.disabled, true, 'Chapter rows remain excluded');
    selected = [];
    all = [];
    await ids.customClipBtn.listeners.click();
    assert.equal(ids.customClipDialog.open, true);
    assert.equal(ids.customClipStart.value, '00:00:12');
    assert.equal(ids.customClipEnd.value, '00:01:00');
    assert.equal(ids.customClipRange.hidden, false);
    assert.equal(ids.customClipStartMarker['aria-valuenow'], '12');
    ids.customClipStart.value = '00:13.250';
    ids.customClipEnd.value = '00:20.750';
    const downloadingClip = ids.customClipForm.listeners.submit({preventDefault() {}});
    assert.equal(ids.downloadCustomClipBtn['aria-busy'], 'true');
    assert.equal(ids.customClipStatus['aria-busy'], 'true');
    await downloadingClip;
    assert.equal(requests[0].url, '/custom_video/parent');
    assert.equal(requests[0].payload.start, '00:13.250');
    assert.equal(requests[0].payload.end, '00:20.750');
    assert.equal(requests[0].payload.media_export_id, 'captioned-copy');
    assert.equal(requests[0].payload.caption_track_index, 1);
    assert.deepEqual(downloads, ['Video.mp4']);
    assert.equal(ids.downloadCustomClipBtn.disabled, false);
    assert.equal(ids.downloadCustomClipBtn['aria-busy'], 'false');
    assert.equal(ids.customClipStatus['aria-busy'], 'false');
    assert.equal(ids.customClipStatus.textContent, 'Video clip downloaded.');
    successTimers.values().next().value();
    assert.equal(ids.customClipStatus.textContent, '', 'Success clears after four seconds');
    state.currentVideoId = 'other';
    await ids.customClipForm.listeners.submit({preventDefault() {}});
    assert.match(ids.customClipStatus.textContent, /video changed/);
    assert.equal(requests.length, 3, 'A changed video cannot receive a stale custom-clip request');
    state.currentVideoId = 'parent';
    fail = true;
    await ids.customClipForm.listeners.submit({preventDefault() {}});
    assert.match(ids.customClipStatus.textContent, /Invalid timestamps/);
    assert.equal(ids.downloadCustomClipBtn['aria-busy'], 'false', 'Failed downloads clear their running color');
    assert.equal(ids.customClipStatus['aria-busy'], 'false');
    fail = false;
    cancelSave = true;
    await ids.customClipForm.listeners.submit({preventDefault() {}});
    assert.equal(ids.customClipStatus.textContent, 'Download cancelled.');
    assert.equal(ids.downloadCustomClipBtn['aria-busy'], 'false', 'Cancelling clears the running button color');
    assert.equal(ids.customClipStatus['aria-busy'], 'false');
    cancelSave = false;
    await ids.downloadSelectedClipsBtn.listeners.click();
    assert.match(ids.selectedClipsStatus.textContent, /Select chapters or sections/);
    const chapters = [{title: 'Main', timestamp: '00:00', sections: [
        {title: 'Part', timestamp: '00:00'}, {title: 'Next', timestamp: '00:10'}]}];
    selected = [context.createClipSelection(chapters[0].sections[0], 0, chapters, 0)];
    documentListeners.change({target: {matches: () => true}});
    assert.equal(ids.clipSelectionActions.hidden, false);
    assert.equal(ids.clipSelectionCount.textContent, '1 selected');
    assert.equal(ids.deleteSelectedSectionsBtn.disabled, false);
    assert.equal(ids.mergeSelectedSectionsBtn.disabled, true);
    selected.push(context.createClipSelection(chapters[0].sections[1], 0, chapters, 1));
    documentListeners.change({target: {matches: () => true}});
    assert.equal(ids.mergeSelectedSectionsBtn.disabled, false, 'Adjacent sections can be merged in the outline');
    selected.pop();
    selected.push(context.createClipSelection(chapters[0], 0, chapters));
    documentListeners.change({target: {matches: () => true}});
    assert.equal(ids.clipSelectionCount.textContent, '2 selected', 'Counts chapters and sections together');
    assert.equal(ids.mergeSelectedSectionsBtn.disabled, true, 'Mixed chapter/section selection cannot merge section labels');
    assert.equal(ids.deleteSelectedSectionsBtn.disabled, true, 'Bulk section deletion excludes chapters');
    selected.pop();
    assert.equal(selected[0]['aria-label'], 'Select section: Part');
    ids.mergeSelectedClips.checked = true;
    const downloadingSelection = ids.downloadSelectedClipsBtn.listeners.click();
    assert.equal(ids.downloadSelectedClipsBtn['aria-busy'], 'true');
    assert.equal(ids.selectedClipsStatus['aria-busy'], 'true');
    await downloadingSelection;
    const batch = requests.find(request => request.url === '/selected_videos/parent');
    assert.equal(batch.payload.merge_consecutive, true);
    assert.equal(batch.payload.selections[0].section_index, 0);
    assert.equal(batch.payload.selections[0].next_timestamp, '00:10');
    assert.equal(batch.payload.media_export_id, 'captioned-copy');
    assert.equal(downloads.length, 2);
    assert.equal(ids.downloadSelectedClipsBtn['aria-busy'], 'false');
    assert.equal(ids.selectedClipsStatus['aria-busy'], 'false');
    assert.equal(errors.length, 0);
    ids.customClipStart.value = '00:30';
    ids.customClipEnd.value = '00:20';
    const requestCount = requests.length;
    await ids.customClipForm.listeners.submit({preventDefault() {}});
    assert.equal(requests.length, requestCount, 'Invalid ranges never start an export');
    ids.closeCustomClipBtn.listeners.click();
    assert.equal(ids.customClipRange.hidden, true);
    await ids.customClipBtn.listeners.click();
    documentListeners.videoSelectionChanged();
    assert.equal(ids.customClipDialog.open, false);
    assert.equal(ids.customClipRange.hidden, true, 'Changing video removes the clip markers');
    const first = selected[0];
    ids.clearClipSelectionBtn.listeners.click();
    assert.equal(first.checked, false);
    selected = [];
    documentListeners.change({target: {matches: () => true}});
    assert.equal(ids.clipSelectionActions.hidden, true, 'Removing the last selection hides the actions');
    documentListeners.chaptersUpdated();
    assert.equal(ids.clipSelectionActions.hidden, true, 'A new outline has no stale selection actions');
    console.log('PASS: custom ranges, selected parts, source captions, errors and stale-dialog guards');
})().catch(error => { console.error(error); process.exitCode = 1; });
