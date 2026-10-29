const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static', 'js', 'project-history.js'), 'utf8');
const mod = new Function('module', `${source.replace(/export /g, '')}
module.exports = { readHistory, recordVisit, removeEntry, initProjectHistory }; return module.exports;`)({});

class Storage {
    constructor() { this.data = {}; }
    getItem(key) { return key in this.data ? this.data[key] : null; }
    setItem(key, value) { this.data[key] = String(value); }
}

function button() {
    const listeners = {};
    return {
        disabled: false, title: '', attrs: {}, listeners,
        setAttribute(name, value) { this.attrs[name] = value; },
        addEventListener(type, handler) { listeners[type] = handler; },
    };
}

(async () => {
    let h = { entries: [], index: -1 };
    h = mod.recordVisit(h, 'a', 'A.mp4');
    h = mod.recordVisit(h, 'a', 'A.mp4');
    h = mod.recordVisit(h, 'b');
    h = mod.recordVisit(h, 'c');
    assert.deepStrictEqual(h.entries.map(e => e.id), ['a', 'b', 'c']);
    h.index = 0;
    h = mod.recordVisit(h, 'd');
    assert.deepStrictEqual(h.entries.map(e => e.id), ['a', 'd'], 'Opening a new project drops forward history');

    const storage = new Storage();
    storage.setItem('lectureseek-project-history', '{broken');
    assert.deepStrictEqual(mod.readHistory(storage), { entries: [], index: -1 }, 'Corrupt history is ignored');

    const back = button(), next = button();
    const docListeners = {};
    const options = [{ value: 'b', dataset: { filename: 'Lecture B.mp4' } }];
    const doc = {
        getElementById: id => ({ projectBackBtn: back, projectNextBtn: next, uploadedVideos: { options } })[id],
        addEventListener: (type, handler) => { docListeners[type] = handler; },
    };
    const opened = [], notices = [];
    let busy = false, failing = new Set();
    const announce = (videoId, label = '') => docListeners.projectOpened({ detail: { videoId, label } });
    const controller = mod.initProjectHistory({
        storage, doc,
        isBusy: () => busy,
        notify: message => notices.push(message),
        open: async id => {
            opened.push(id);
            if (failing.has(id)) return false;
            announce(id);
            return true;
        },
    });
    assert(back.disabled && next.disabled, 'Buttons start disabled with no history');

    announce('a', 'Lecture A.mp4');
    announce('b');
    announce('c', 'Lecture C');
    assert(!back.disabled && next.disabled);
    assert.strictEqual(back.title, 'Back to previous project: Lecture B.mp4', 'Tooltip names the saved upload');

    await back.listeners.click();
    await controller.go(-1);
    assert.deepStrictEqual(opened, ['b', 'a']);
    assert(back.disabled && !next.disabled, 'At the oldest project only Next is available');
    assert.strictEqual(next.title, 'Next project: Lecture B.mp4');

    await next.listeners.click();
    assert.deepStrictEqual(controller.history.entries.map(e => e.id), ['a', 'b', 'c'], 'Back/Next does not rewrite history');
    assert.strictEqual(controller.history.index, 1);

    busy = true;
    await controller.go(1);
    assert.strictEqual(opened.length, 3, 'Unsaved edits block switching');
    assert(/Save or cancel/.test(notices.pop()));
    busy = false;

    failing.add('c');
    await controller.go(1);
    assert.deepStrictEqual(opened.slice(-2), ['c', 'b'], 'A missing project falls back to the current one');
    assert.deepStrictEqual(controller.history.entries.map(e => e.id), ['a', 'b']);
    assert.strictEqual(controller.history.index, 1);
    assert(/removed from project history/.test(notices.pop()));

    const persisted = JSON.parse(storage.getItem('lectureseek-project-history'));
    assert.deepStrictEqual(persisted.entries.map(e => e.id), ['a', 'b'], 'History persists across reloads');

    const template = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
    assert(template.indexOf('id="projectBackBtn"') < template.indexOf('id="undoContentBtn"'), 'Back/Next sit at the top');
    const api = fs.readFileSync(path.join(root, 'static', 'js', 'api-module.js'), 'utf8');
    assert.strictEqual((api.match(/announceProjectOpened\(/g) || []).length, 4, 'Saved, uploaded and YouTube opens are recorded');
    console.log('PASS: project Back/Next history');
})().catch(error => { console.error(error); process.exit(1); });
