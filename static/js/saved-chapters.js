import { state } from './main.js';
import { chooseTranscriptVersion } from './transcript-versions.js';
import { setContentLanguage } from './content-languages.js';
import { openOptionsDialog } from './utils.js';

export function initSavedChapters() {
    const dialog = document.getElementById('savedChaptersDialog');
    const status = document.getElementById('savedChaptersStatus');
    const list = document.getElementById('savedChaptersList');
    let generation = 0;
    document.getElementById('loadSavedChaptersBtn').addEventListener('click', async () => {
        if (state.outlineRowEditing || state.summaryGenerationInProgress) {
            status.textContent = 'Save or cancel the open edit and finish or stop generation before switching.';
            openOptionsDialog(dialog);
            return;
        }
        const videoId = state.currentVideoId;
        const request = ++generation;
        list.replaceChildren();
        openOptionsDialog(dialog);
        if (!videoId) { status.textContent = 'Load a video first.'; return; }
        status.textContent = 'Loading saved chapter outlines...';
        try {
            const response = await fetch(`/transcript_versions/${encodeURIComponent(videoId)}`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.detail || 'Could not load saved chapters.');
            if (request !== generation || videoId !== state.currentVideoId) return;
            const versions = (data.versions || []).filter(version => version.chapter_count > 0);
            status.textContent = versions.length ? 'Choose chapters and their matching transcript.'
                : 'No saved chapter outlines were found for this video.';
            for (const version of versions) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-secondary';
                button.textContent = `${version.label} - ${version.chapter_count} chapters (${version.created_at || 'saved'})`;
                button.addEventListener('click', async () => {
                    if (state.currentVideoId !== videoId) {
                        status.textContent = 'Video changed. Reopen Saved chapters.';
                        return;
                    }
                    if (state.summaryGenerationInProgress || state.outlineRowEditing) {
                        status.textContent = 'Finish or stop the current operation before switching chapters.';
                        return;
                    }
                    button.disabled = true;
                    setContentLanguage(videoId, 'chapters', null);
                    await chooseTranscriptVersion(version.id);
                    dialog.close();
                });
                list.append(button);
            }
        } catch (error) {
            if (request === generation) status.textContent = error.message;
        }
    });
}
