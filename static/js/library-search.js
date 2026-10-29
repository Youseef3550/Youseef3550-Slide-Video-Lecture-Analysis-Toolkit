import { state } from './main.js';
import { loadUploadedVideo } from './api-module.js';
import { openOptionsDialog } from './utils.js';
import { clipTimestamp } from './custom-clip-range.js';
import { revealOutlineSearchResult } from './chapters.js';
import { showNotification } from './ui.js';

export function initLibrarySearch() {
    const get = id => document.getElementById(id);
    const dialog = get('librarySearchDialog');
    const list = get('librarySearchResults');
    const status = get('librarySearchStatus');
    const more = get('librarySearchMoreBtn');
    let generation = 0;
    let controller = null;
    let snapshot = null;
    let offset = 0;
    let opening = false;
    const message = (text, error = false) => {
        status.textContent = text;
        status.classList.toggle('outline-error', error);
    };
    function highlight(target, text, query) {
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        let position = 0;
        for (const match of text.matchAll(pattern)) {
            target.append(document.createTextNode(text.slice(position, match.index)));
            const mark = document.createElement('mark');
            mark.textContent = match[0];
            target.append(mark);
            position = match.index + match[0].length;
        }
        target.append(document.createTextNode(text.slice(position)));
    }
    function render(result, query) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary btn-action library-search-open';
        const time = Number.isFinite(result.timestamp) ? clipTimestamp(result.timestamp) : null;
        button.textContent = `${result.filename} ${time ? `— ${time}` : '— Open video'}`;
        const label = document.createElement('small');
        label.textContent = `${result.kind} · ${result.title} · ${result.source}`;
        const snippet = document.createElement('p');
        highlight(snippet, result.snippet, query);
        button.addEventListener('click', async () => {
            if (opening) return;
            if (state.outlineRowEditing || document.querySelector('.is-inline-editing')) {
                message('Save or cancel your open edits before opening a search result.', true);
                return;
            }
            opening = true;
            button.disabled = true;
            const request = generation;
            message('Opening saved video...');
            try {
                if (state.currentVideoId !== result.video_id && !await loadUploadedVideo(result.video_id)) {
                    throw new Error('Could not load this saved video. See the app error for details.');
                }
                if (request !== generation || !dialog.open) return;
                if (state.currentVideoId !== result.video_id) throw new Error('The video selection changed. Open the result again.');
                const player = document.getElementById('videoPlayer');
                if (time !== null) {
                    if (!Number.isFinite(player.duration) || result.timestamp > player.duration) {
                        throw new Error('This saved timestamp is outside the loaded video. The saved content may belong to an older copy.');
                    }
                    player.currentTime = result.timestamp;
                }
                const select = get('uploadedVideos');
                if (select) select.value = result.video_id;
                dialog.close();
                const row = revealOutlineSearchResult(result);
                if (!row) {
                    player.focus();
                    if (result.kind === 'section' || result.kind === 'chapter') {
                        showNotification('Jumped to the saved timestamp. The matching outline row is not in the open version.', 'info');
                    }
                }
            } catch (error) {
                if (request === generation) message(error.message, true);
            } finally {
                opening = false;
                button.disabled = false;
            }
        });
        item.append(button, label, snippet);
        list.append(item);
    }
    async function search(append = false) {
        if (opening) { message('Wait for the selected video to finish loading.', true); return; }
        controller?.abort();
        const request = ++generation;
        if (!append) {
            snapshot = {q: get('librarySearchQuery').value.trim(), kind: get('librarySearchKind').value};
            if (get('projectSearchScope').value === 'current') {
                if (!state.currentVideoId) {
                    list.replaceChildren();
                    more.hidden = true;
                    message('Open a project first, or choose All projects.', true);
                    return;
                }
                snapshot.project_id = state.currentVideoId;
            }
            offset = 0;
            list.replaceChildren();
        }
        more.hidden = true;
        if (!snapshot?.q) { message(''); return; }
        controller = new AbortController();
        message(snapshot.project_id ? 'Searching the open project...' : 'Searching all projects...');
        try {
            const response = await fetch('/library/search?' + new URLSearchParams({...snapshot, offset, limit: 30}),
                {signal: controller.signal});
            const data = await response.json();
            if (!response.ok) throw new Error(data.detail || `Search failed (${response.status}).`);
            if (request !== generation) return;
            for (const result of data.results) render(result, snapshot.q);
            offset += data.results.length;
            more.hidden = offset >= data.total;
            message(`${data.total} match${data.total === 1 ? '' : 'es'}${data.total ? ` · showing ${offset}` : ''}.`
                + (data.warnings.length ? ` Some saved files could not be searched: ${data.warnings.join(' ')}` : ''),
            data.warnings.length > 0);
        } catch (error) {
            if (request === generation && error.name !== 'AbortError') message(error.message, true);
        }
    }
    get('projectSearchForm').addEventListener('submit', event => {
        event.preventDefault();
        openOptionsDialog(dialog);
        void search();
    });
    get('librarySearchForm').addEventListener('submit', event => { event.preventDefault(); void search(); });
    more.addEventListener('click', () => void search(true));
    get('librarySearchKind').addEventListener('change', () => void search());
    get('projectSearchScope').addEventListener('change', () => {
        if (dialog.open) void search();
        else {
            controller?.abort();
            ++generation;
            more.hidden = true;
            list.replaceChildren();
        }
    });
    get('librarySearchQuery').addEventListener('input', () => {
        controller?.abort();
        ++generation;
        more.hidden = true;
        list.replaceChildren();
        message('');
    });
    dialog.addEventListener('close', () => {
        controller?.abort();
        ++generation;
        more.hidden = true;
    });
    document.addEventListener('videoSelectionChanged', () => {
        if (get('projectSearchScope').value !== 'current') return;
        controller?.abort();
        ++generation;
        more.hidden = true;
        list.replaceChildren();
        message('');
    });
}
