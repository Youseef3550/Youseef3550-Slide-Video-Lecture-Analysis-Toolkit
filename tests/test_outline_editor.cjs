const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'outline-editor.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
function element(tag) {
    return {
        tag, children: [], listeners: {}, attributes: {}, classList: {add() {}, remove() {}},
        setAttribute(name, value) { this.attributes[name] = value; },
        append(...children) { this.children.push(...children); },
        after(node) { this.afterNode = node; },
        replaceChildren() { this.children = []; },
        addEventListener(name, handler) { this.listeners[name] = handler; },
        remove() { this.removed = true; },
        focus() {},
    };
}
(async () => {
    const chapters = [{timestamp: '00:00', title: 'Demo', sections: [
        {timestamp: '00:00', title: 'A'}, {timestamp: '00:20', title: 'B'}]},
    {timestamp: '00:40', title: 'Next'}];
    const state = {currentVideoId: 'vid', videoChapters: chapters, currentTranscript: [
        {start: 0, duration: 50, text: 'Demo'}]};
    let form, payload, saved, savedOptions, dispatched, fail = false;
    let selections = [], confirmation;
    const batchButtons = {mergeSelectedSectionsBtn: element('button'), deleteSelectedSectionsBtn: element('button')};
    const errors = [], notifications = [];
    const listeners = {};
    const player = {currentTime: 5, readyState: 4, paused: false, playbackRate: 1.75};
    const anchor = {after(el) { form = el; }, closest() { return null; }, focus() {}};
    const context = vm.createContext({
        startProcessButton: require('./process_button_stub.cjs'),
        state, URLSearchParams, contentLanguage: () => '', showError: message => errors.push(message),
        showNotification: message => notifications.push(message),
        CustomEvent: function (type, init) { this.type = type; this.detail = init?.detail; },
        window: {confirm: message => { confirmation = message; return true; }},
        document: {
            addEventListener(name, handler) { listeners[name] = handler; },
            createElement: element, createTextNode: text => text,
            getElementById: id => id === 'videoPlayer' ? player : batchButtons[id] || null,
            querySelectorAll: () => selections,
            dispatchEvent(event) { dispatched = listeners[event.type]?.(event); },
        },
        updateChapters: (content, options) => { saved = content; savedOptions = options; },
        fetch: async (url, options) => {
            if (!options) return {ok: true, json: async () => ({content: chapters, revision: 'saved', duration: 60})};
            payload = JSON.parse(options.body);
            return {ok: !fail, json: async () => fail ? {detail: 'End crosses next chapter'}
                : {content: chapters, revision: 'next'}};
        },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'utils.js'), 'utf8')
        .replace(/^export /gm, ''), context);
    vm.runInContext(source, context);
    context.initOutlineEditor();
    const open = detail => listeners.outlineEditRequested({detail: {...detail, anchor}});
    const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
    const field = name => descendants(form)
        .find(child => child.attributes?.['aria-label'] === name);
    for (const [request, label] of [
        [{action: 'update', chapter: 0, section: 0}, 'Delete section'],
        [{action: 'update', chapter: 0}, 'Delete chapter'],
    ]) {
        await open(request);
        const remove = field(label);
        assert(remove, 'Delete control has a descriptive accessible label');
        assert.equal(remove.className, 'btn btn-secondary btn-icon delete-action');
        assert.equal(remove.textContent, '', 'Delete control has no visible text');
        assert.equal(remove.title, label);
        assert.equal(remove.innerHTML, '<i class="fas fa-trash" aria-hidden="true"></i>');
        assert.equal(typeof remove.listeners.click, 'function', 'Delete retains its confirmation handler');
        const review = form.children.find(child => child.className === 'chapter-summary-toggle review-reason-edit');
        assert.equal(Boolean(review.open), false, 'Review reason starts collapsed');
        assert.equal(review.children[0].textContent, 'Review reason');
        assert.equal(field('Review reason').maxLength, 1000);
        for (const [name, value, expected] of [['Start', 4.125, '00:04.125'],
            ['End', 16.875, '00:16.875'], ['Start', 3600, '1:00:00.000'],
            ['End', 3723.125, '1:02:03.125']]) {
            const input = field(name);
            const pin = input.afterNode.children[1];
            assert.equal(pin.attributes['aria-label'], `Set ${name.toLowerCase()} to current video time`);
            assert.equal(pin.title, `${name} here`);
            player.currentTime = value;
            pin.listeners.click();
            assert.equal(input.value, expected);
            assert.equal(player.paused, false, 'Marking a timestamp never pauses playback');
            assert.equal(player.playbackRate, 1.75);
            player.readyState = 0;
            player.currentTime = 9;
            pin.listeners.click();
            assert.equal(input.value, expected);
            player.readyState = 4;
        }
        player.currentTime = 5;
        form.children.find(child => child.className === 'outline-editor-actions').children[1].listeners.click();
    }
    await open({action: 'insert_boundary', chapter: 0, section: 1});
    assert.deepEqual(form.children.map(child => child.textContent), ['Add section', 'Start new chapter here', 'Cancel']);
    assert.equal(state.outlineRowEditing, true);
    form.children[1].listeners.click();
    await dispatched;
    assert.equal(field('Start').value, '00:20.000', 'Split starts at the following section, not the playhead');
    assert.equal(field('End').value, '00:40', 'Split extends to the next chapter');
    assert.equal(field('Title').value, 'B', 'Reuse the following section title as an editable default');
    await form.listeners.submit({preventDefault() {}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(payload.action, 'add_chapter');
    assert.equal(payload.chapter, 1);
    assert.equal(payload.section, null);
    assert.equal(payload.item.timestamp, '00:20.000');
    assert.equal(payload.item.end_timestamp, '00:40');
    assert.equal(payload.item.flag_reason, '', 'Collapsed review reason is still included when saving');
    await open({action: 'insert_boundary', chapter: 0, section: 1});
    form.children[0].listeners.click();
    await dispatched;
    assert.equal(field('Start').value, '00:05.000', 'Adding a section retains the existing gap/playhead behavior');
    await form.listeners.submit({preventDefault() {}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(payload.action, 'add_section');
    assert.equal(payload.chapter, 0);
    assert.equal(payload.section, 1);
    await open({action: 'insert_boundary', chapter: 0, section: 2});
    form.children[1].listeners.click();
    await dispatched;
    assert(Number(field('Start').value.split(':')[1]) > 20, 'A split after the last section stays within that section');
    assert.equal(field('End').value, '00:40');
    form.children.find(child => child.className === 'outline-editor-actions').children[1].listeners.click();
    await open({action: 'update', chapter: 0, section: 0});
    const help = form.children.find(child => child.className === 'contextual-help');
    assert.equal(help.children[0].textContent, '?');
    assert.equal(Boolean(help.open), false, 'End-time explanation is hidden until help is opened');
    const summary = form.children.find(child => child.className === 'chapter-summary-toggle chapter-summary-edit');
    assert.equal(summary.children[0].textContent, 'Section summary');
    assert.equal(Boolean(summary.open), false, 'Section summaries are collapsed for quick editing');
    field('Section summary').value = 'My edited section summary';
    field('Review reason').value = 'Keep this optional note';
    assert.equal(field('Start').value, '00:00');
    assert.equal(field('End').value, '00:20');
    field('End').value = '00:12.345';
    await form.listeners.submit({preventDefault() {}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(payload.item.end_timestamp, '00:12.345');
    assert.equal(payload.item.point, 'My edited section summary', 'Collapsed summary values still save normally');
    assert.equal(payload.item.flag_reason, 'Keep this optional note', 'Collapsed review notes still save normally');
    assert.equal(payload.revision, 'saved');
    assert.equal(saved, chapters);
    assert.equal(savedOptions.preserveExpansion, true);
    assert.equal(state.outlineRowEditing, false);
    await open({action: 'update', chapter: 1});
    assert.equal(field('End').value, '01:00.000', 'Last end uses verified media duration, including silent tail');
    await open({action: 'update', chapter: 0});
    assert.equal(field('End').value, '00:40');
    fail = true;
    field('End').value = '00:45';
    await form.listeners.submit({preventDefault() {}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(field('End').value, '00:45', 'Invalid end remains editable after the error');
    assert.equal(form.children.at(-1).className, 'outline-error');
    assert.match(form.children.at(-1).textContent, /End crosses/);
    assert.equal(state.outlineRowEditing, true);
    form.children.find(child => child.className === 'outline-editor-actions').children[1].listeners.click();
    fail = false;
    selections = [0, 1, 3, 4, 6].map(section_index => ({dataset: {clipSelection: JSON.stringify({chapter_index: 0, section_index})}}));
    await batchButtons.mergeSelectedSectionsBtn.listeners.click();
    assert.equal(payload.action, 'merge');
    assert.equal(payload.selections.length, 5);
    assert.match(confirmation, /each adjacent group/);
    assert.match(confirmation, /Isolated selections and unselected sections stay unchanged/);
    assert.equal(payload.revision, 'saved');
    assert.equal(savedOptions.preserveExpansion, true);
    assert.equal(state.outlineRowEditing, false);
    assert.match(notifications.at(-1), /merged/);
    await batchButtons.deleteSelectedSectionsBtn.listeners.click();
    assert.equal(payload.action, 'delete');
    assert.equal(notifications.at(-1), 'Section labels deleted.');
    fail = true;
    await batchButtons.deleteSelectedSectionsBtn.listeners.click();
    assert.match(errors.at(-1), /End crosses/);
    console.log('PASS: start/end defaults, precise end payload, media duration and recoverable end errors');
})().catch(error => { console.error(error); process.exitCode = 1; });
