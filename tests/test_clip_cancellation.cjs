const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'chapter-projects.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
(async () => {
    const requests = [], handlers = {};
    const button = {
        disabled: false,
        addEventListener(name, handler, capture) { assert.equal(capture, true); handlers[name] = handler; },
        removeEventListener(name, handler, capture) { assert.equal(capture, true); delete handlers[name]; },
    };
    let cancelled = false;
    const context = vm.createContext({
        startProcessButton: require('./process_button_stub.cjs'),
        DOMException,
        clearTimeout,
        setTimeout: fn => setTimeout(fn, 0),
        showError: message => { throw new Error(message); },
        fetch: async (url, options) => {
            requests.push(url);
            if (url.endsWith('/cancel')) {
                cancelled = true;
                return {ok: true, json: async () => ({status: 'cancelling'})};
            }
            return {ok: true, json: async () => options ? {job_id: 'job'}
                : {status: cancelled ? 'cancelled' : 'running', steps: []}};
        },
    });
    vm.runInContext(source, context);
    const pending = context.downloadVideoClip('/custom_video/video', {}, () => {}, button);
    const rejected = assert.rejects(pending, error => error.name === 'AbortError');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(button.disabled, false, 'Encoding exposes cancellation on its initiating button');
    await handlers.click({preventDefault() {}, stopImmediatePropagation() {}});
    await rejected;
    assert.equal(requests.filter(url => url === '/custom_video/video').length, 1);
    assert.equal(requests.filter(url => url.endsWith('/cancel')).length, 1);
    assert.equal(handlers.click, undefined);
    assert.equal(button.disabled, false);
    console.log('PASS: same-button clip cancellation, no duplicate creation, cancelled polling and listener cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
