const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'templates', 'index.html'), 'utf8');
const buttons = new Map([...html.matchAll(/<button\b([^>]*)>/g)].map(([, attributes]) => [
    attributes.match(/\bid="([^"]+)"/)?.[1],
    attributes.match(/\bclass="([^"]+)"/)?.[1]?.split(/\s+/) || [],
]));
const options = ['settingsBtn', 'transcriptOptionsBtn', 'summaryOptionsBtn'];
const actions = [
    'identifySpeakersBtn', 'regenerateTranscriptAction', 'uploadTranscriptBtn',
    'translateTranscriptBtn', 'downloadCaptionSrtBtn', 'downloadCaptionVttBtn',
    'refreshCaptionPreviewBtn', 'exportChaptersBtn', 'refreshSavedExportsBtn',
    'detectScenesBtn', 'refreshSlideTitlesBtn', 'downloadScreenshotsBtn',
    'downloadSlidesPdfBtn', 'downloadSlideTextWordBtn',
    'openCaptionStyleBtn', 'downloadTranscriptBtn',
    'downloadSavedCaptionVideoBtn', 'refreshCaptionVideosBtn',
];
for (const id of options) {
    assert(buttons.get(id)?.includes('btn-options'), `${id} must remain an options control`);
    assert(!buttons.get(id).includes('btn-action'), `${id} must not look like a processing action`);
}
for (const id of actions) {
    assert(buttons.get(id)?.includes('btn-action'), `${id} must stand out as an action`);
}
assert(buttons.get('exportCaptionedVideoBtn').includes('btn-primary'));
assert(buttons.get('deleteTranscriptVersionBtn').includes('btn-danger'));
const dialog = id => html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?<\\/dialog>`))[0];
for (const [, attributes] of html.matchAll(/<dialog\b([^>]*)>/g)) {
    if (attributes.includes('id="captionLargePreviewDialog"')) {
        assert(attributes.includes('caption-large-preview-dialog'), 'Only the enlarged image preview may use a larger dialog');
    } else {
        assert(attributes.includes('options-dialog'), 'Option dialogs must share side-panel positioning');
    }
}
const layout = fs.readFileSync(path.join(root, 'static', 'compact-layout.css'), 'utf8');
const theme = fs.readFileSync(path.join(root, 'static', 'theme.css'), 'utf8');
const rule = selector => {
    const start = theme.indexOf(`${selector} {`);
    assert(start >= 0, `${selector} must have a shared style`);
    return theme.slice(start, theme.indexOf('}', start) + 1);
};
const menuRows = rule('.action-menu > .row-actions-content > .btn');
for (const declaration of ['width: 100%', 'min-height: 28px', 'padding: 4px 8px',
    'justify-content: flex-start', 'text-align: start', 'background: transparent',
    'box-shadow: none', 'white-space: normal']) assert(menuRows.includes(declaration), declaration);
assert(rule('.action-menu > .row-actions-content > .btn:focus-visible').includes('outline: 2px'),
    'Compact menu rows keep keyboard focus visible');
assert(rule('.action-menu > .row-actions-content > .btn-danger').includes('var(--err-fg)'));
assert(rule('.controls-bar > .action-menu > .row-actions-content').includes('position: absolute'),
    'Opening toolbar menus must not push chapter/transcript content down');
assert(rule('.controls-bar > .action-menu > .row-actions-content').includes('overflow-y: auto'));
assert(!theme.includes('box-shadow: inset 3px 0 0'), 'Secondary actions must not compete with primary actions');
assert(rule('.btn.btn-options').includes('background-color: var(--surface-1)'));
for (const token of ['--running-fg:', '--running-bg:', '--running-accent:']) {
    assert.equal(theme.split(token).length - 1, 2, `${token} must support both light and dark themes`);
}
for (const selector of [
    '.btn:is([aria-busy="true"], :has(.fa-spinner.fa-spin), :has(> .progress-elapsed.is-running))',
    '#videoSummaryStatus > .progress-elapsed.is-running',
    '#transcriptContainer > .progress-elapsed.is-running',
    '#regenerateTranscriptAction',
    '#translationProgressText',
    '#captionVideoProgress > .progress-elapsed.is-running',
    '.ocr-progress-container:is([data-status="queued"], [data-status="running"], [data-status="stopping"])',
]) {
    assert(theme.includes(selector), `${selector} must share the active-work highlight`);
}
assert(theme.includes('accent-color: var(--running-accent)'), 'Native progress indicators share the active color');
assert(layout.includes('padding: 4px 8px'), 'Shared buttons keep a compact hit target');
assert(layout.includes('--popup-width: var(--panel-width, 420px)'), 'Desktop popups must match the panel, not widen across the video');
assert(layout.includes('--popup-top: min(var(--panel-top, 12px)'), 'Narrow-screen popups must share a viewport-clamped panel position');
for (const selector of ['html .options-dialog', 'html .modal-content', 'html .debug-content', 'html .config-dialog-content']) {
    assert(layout.includes(selector), `${selector} must use shared popup placement`);
}
const transcriptOptions = dialog('transcriptOptionsDialog');
for (const id of ['openCaptionStyleBtn', 'downloadTranscriptBtn', 'exportCaptionedVideoBtn',
    'downloadCaptionSrtBtn', 'downloadCaptionVttBtn', 'captionStylePreset']) {
    assert(!transcriptOptions.includes(`id="${id}"`), `${id} must not be inside Transcript options`);
}
assert(dialog('captionStyleDialog').includes('id="exportCaptionedVideoBtn"'));
assert(dialog('captionStyleDialog').includes('id="captionStylePreview"'));
assert(dialog('captionStyleDialog').includes('id="savedCaptionVideoSelect"'));
assert(dialog('captionStyleDialog').includes('<option value="box" selected>'));
assert(dialog('captionStyleDialog').includes('<option value="medium" selected>'));
assert(!dialog('captionStyleDialog').includes('<option value="xl">'));
const captionDialog = dialog('captionStyleDialog');
assert(captionDialog.includes('<summary>Caption help</summary>'));
assert(captionDialog.includes('id="captionTranscriptLabel" hidden'), 'Do not repeat the selected transcript label');
assert(!captionDialog.match(/<details[^>]*\bopen\b/), 'Caption explanations should be collapsed by default');
assert(captionDialog.includes('> Enlarge preview</button>'), 'Keep preview action concise');
assert(transcriptOptions.includes('<summary>Advanced transcription options</summary>'));
assert(dialog('sceneDetectionOptionsDialog').includes('<summary>? Method help</summary>'));
assert(html.includes('<summary>Chapter help</summary>'));
assert(html.includes('<summary>Device help</summary>'));
assert(dialog('captionStyleDialog').includes('id="captionTranscriptVersionSelect"'));
assert(!html.includes('id="captionLanguage"'), 'Language must come from the selected transcript');
assert(dialog('captionLargePreviewDialog').includes('id="captionLargePreviewImage"'));
assert.equal([...html.matchAll(/id="savedCaptionVideoSelect"/g)].length, 1, 'Only one saved video dropdown');
assert(!html.includes('id="savedCaptionVideosDialog"'), 'No duplicate saved-video popup');
for (const id of ['downloadCaptionSrtBtn', 'downloadCaptionVttBtn']) {
    assert(dialog('transcriptDownloadDialog').includes(`id="${id}"`), 'Formats belong in the download chooser');
}
for (const id of ['previousChapterBtn', 'nextChapterBtn']) {
    assert(!buttons.get(id).includes('btn-action'), 'Playback navigation must remain neutral');
}
for (const [, attributes, text] of html.matchAll(/<button\b([^>]*)>(Cancel)<\/button>/g)) {
    assert(!attributes.includes('btn-action'), `${text} must remain neutral`);
}
const dynamicControls = [
    ['chapters.js', "download.className = 'btn btn-secondary btn-action btn-icon'"],
    ['chapters.js', "retryButton.className = 'btn btn-secondary btn-action summary-retry-btn'"],
    ['slide-downloads.js', "button.className = 'btn btn-secondary btn-action btn-icon slide-download'"],
    ['scenes.js', "reloadBtn.className = 'btn btn-secondary btn-action detection-toggle-btn'"],
    ['interactive-layer.js', 'id="extractAllBtn" class="btn btn-secondary btn-action"'],
    ['interactive-layer.js', 'id="autoExtractConfigBtn" class="btn btn-secondary btn-options"'],
    ['api-module.js', 'const process = startProcessButton(button,'],
    ['ocr.js', 'id="stopOcrBtn" class="btn btn-secondary"'],
    ['ui.js', "actionButton.className = 'btn btn-secondary btn-action error-action-btn'"],
    ['caption-export.js', "button.className = 'btn btn-secondary btn-action'"],
];
for (const [file, expected] of dynamicControls) {
    const source = fs.readFileSync(path.join(root, 'static', 'js', file), 'utf8');
    assert(source.includes(expected), `${file} must classify dynamically created controls`);
}
console.log('PASS: actions, options, navigation, cancellation and dynamic button classifications');
