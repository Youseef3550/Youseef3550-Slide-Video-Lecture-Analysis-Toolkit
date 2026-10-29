import { state } from './main.js';
import { loadTranscript } from './transcript.js';
import { updateChapters } from './chapters.js';
import { updateScenes } from './scenes.js';
import { elements } from './elements.js';
import { contentLanguage, setContentLanguage } from './content-languages.js';
import { refreshTranscriptVersions } from './transcript-versions.js';

export function initContentHistory() {
    const undo = document.getElementById('undoContentBtn');
    const redo = document.getElementById('redoContentBtn');
    const status = document.getElementById('contentHistoryStatus');
    let busy = false, generation = 0;
    const editing = () => state.outlineRowEditing || Boolean(document.querySelector(
        '.is-inline-editing, #contentEditorDialog[open], #contentEditorDialog.is-open'
    ));
    const read = async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || `History request failed (${response.status}).`);
        return data;
    };
    const refresh = async () => {
        const videoId = state.currentVideoId, request = ++generation;
        if (!videoId) { undo.disabled = redo.disabled = true; return; }
        try {
            const data = await read(await fetch(`/content_history/${encodeURIComponent(videoId)}`));
            if (request !== generation || videoId !== state.currentVideoId) return;
            const blocked = busy || data.busy || editing() || state.summaryGenerationInProgress;
            undo.disabled = blocked || !data.undo;
            redo.disabled = blocked || !data.redo;
            undo.title = data.undo ? `Undo: ${data.undo} (Ctrl+Z)` : 'Nothing to undo';
            redo.title = data.redo ? `Redo: ${data.redo} (Ctrl+Shift+Z)` : 'Nothing to redo';
            undo.setAttribute('aria-label', undo.title);
            redo.setAttribute('aria-label', redo.title);
        } catch (error) {
            if (request === generation) {
                undo.disabled = redo.disabled = true;
                status.textContent = error.message;
            }
        }
    };
    const apply = async direction => {
        if (busy || editing() || state.summaryGenerationInProgress || !state.currentVideoId) return;
        const videoId = state.currentVideoId;
        busy = true;
        undo.disabled = redo.disabled = true;
        status.textContent = direction === 'undo' ? 'Undoing saved change...' : 'Redoing saved change...';
        try {
            const result = await read(await fetch(`/content_history/${encodeURIComponent(videoId)}/${direction}`, {method: 'POST'}));
            if (videoId !== state.currentVideoId) return;
            const language = state.currentTranslationLanguage || '';
            const query = new URLSearchParams({
                language, chapter_language: contentLanguage(videoId, 'chapters', language),
                source: state.currentTranscriptSource === 'uploaded' ? 'uploaded'
                    : state.currentTranscriptSource === 'youtube' ? 'youtube' : 'whisper',
            });
            const content = await read(await fetch(`/content_history/${encodeURIComponent(videoId)}/content?${query}`));
            if (videoId !== state.currentVideoId) return;
            state.currentTranslationLanguage = content.transcript_language || null;
            state.currentTranscriptSource = content.transcript_language
                ? `translation:${content.transcript_language}` : content.source;
            setContentLanguage(videoId, 'chapters', content.chapter_language || null);
            state.currentTranscriptVersionId = null;
            loadTranscript(content.transcript);
            updateChapters(content.chapters);
            updateScenes(content.scenes, elements.videoPlayer);
            await refreshTranscriptVersions();
            status.textContent = `${direction === 'undo' ? 'Undone' : 'Redone'}: ${result.label}`;
        } catch (error) {
            status.textContent = error.message;
        } finally {
            busy = false;
            void refresh();
        }
    };
    undo.addEventListener('click', () => void apply('undo'));
    redo.addEventListener('click', () => void apply('redo'));
    document.addEventListener('keydown', event => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
        if (event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
        const target = event.shiftKey ? redo : undo;
        if (target.disabled) return;
        event.preventDefault();
        target.click();
    });
    for (const event of ['transcriptUpdated', 'chaptersUpdated', 'slidesUpdated', 'videoSelectionChanged',
        'summaryGenerationChanged', 'contentEditStateChanged']) document.addEventListener(event, () => void refresh());
    window.addEventListener('focus', () => void refresh());
    // Background results and edits in another tab can change availability without a local render event.
    setInterval(() => { if (!document.hidden && !busy) void refresh(); }, 5000);
    void refresh();
}
