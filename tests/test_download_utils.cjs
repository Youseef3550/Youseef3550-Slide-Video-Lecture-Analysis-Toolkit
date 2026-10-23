const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'utils.js'), 'utf8')
    .replace(/^export /gm, '');

async function checkDownload(extension, pickerAvailable, clickFails = false) {
    const blob = new Blob(['complete file bytes']);
    const links = [], urls = [], revoked = [], timers = [];
    let pickerCalls = 0;
    const container = { appendChild(link) { links.push(link); } };
    const context = vm.createContext({
        window: pickerAvailable ? {
            showSaveFilePicker() {
                pickerCalls++;
                throw new Error('The app must not create a save-picker placeholder');
            },
        } : {},
        document: {
            body: container,
            createElement(tag) {
                assert.equal(tag, 'a');
                return {
                    style: {}, clicks: 0, removed: false,
                    click() {
                        this.clicks++;
                        if (clickFails) throw new Error('Download blocked');
                    },
                    remove() { this.removed = true; },
                };
            },
        },
        URL: {
            createObjectURL(value) { urls.push(value); return 'blob:download'; },
            revokeObjectURL(value) { revoked.push(value); },
        },
        setTimeout(callback, delay) { timers.push({ callback, delay }); },
    });
    vm.runInContext(source, context);
    const filename = `lecture.${extension}`;
    if (clickFails) {
        await assert.rejects(context.saveBlobToUserLocation(blob, filename), /Download blocked/);
    } else {
        await context.saveBlobToUserLocation(blob, filename);
    }
    assert.equal(pickerCalls, 0);
    assert.equal(links.length, 1);
    assert.equal(links[0].clicks, 1);
    assert.equal(links[0].download, context.datedExportFilename(filename));
    assert.equal(links[0].href, 'blob:download');
    assert.equal(links[0].removed, true);
    assert.equal(urls[0], blob, 'Download uses the complete original blob');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 60000, 'Keep the URL alive while the browser starts downloading');
    timers[0].callback();
    assert.deepEqual(revoked, ['blob:download']);
}

(async () => {
    const context = vm.createContext({});
    vm.runInContext(source, context);
    const date = new Date(2026, 9, 20, 23, 45);
    for (const filename of ['Lecture.zip', '01-Chapter.mp4', '01_02-Part.mp4', 'captions.en.vtt', 'Slides.pdf', 'Transcript.docx']) {
        const dot = filename.lastIndexOf('.');
        assert.equal(context.datedExportFilename(filename, date),
            `${filename.slice(0, dot)}_2026-10-20${filename.slice(dot)}`);
    }
    assert.equal(context.datedExportFilename('Lecture_2026-10-19.zip', date), 'Lecture_2026-10-19.zip',
        'Saved exports keep their creation date without a second suffix');
    assert.equal(context.datedExportFilename('Lecture', date), 'Lecture_2026-10-20');
    assert.equal(context.datedExportFilename('Lecture.mp4', new Date(2026, 0, 2)), 'Lecture_2026-01-02.mp4');
    for (const extension of ['zip', 'mp4', 'pdf', 'docx']) {
        await checkDownload(extension, true);
        await checkDownload(extension, false);
    }
    await checkDownload('zip', true, true);
    console.log('PASS: one complete download, no save-picker placeholder, cleanup and visible errors');
})().catch(error => { console.error(error); process.exitCode = 1; });
