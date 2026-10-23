const STORAGE_KEY = 'lectureseek-project-history';
const MAX_ENTRIES = 50;

export function readHistory(storage = localStorage) {
    try {
        const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
        const entries = Array.isArray(saved?.entries)
            ? saved.entries.filter(entry => entry && typeof entry.id === 'string' && entry.id) : [];
        const index = Number.isInteger(saved?.index) ? Math.min(Math.max(saved.index, -1), entries.length - 1) : entries.length - 1;
        return { entries, index };
    } catch {
        return { entries: [], index: -1 };
    }
}

// Browser-style history: opening a new project drops any "Next" entries.
export function recordVisit(history, id, label = '') {
    const current = history.entries[history.index];
    if (current?.id === id) {
        if (label) current.label = label;
        return history;
    }
    const entries = history.entries.slice(0, history.index + 1);
    entries.push({ id, label });
    const trimmed = entries.slice(-MAX_ENTRIES);
    return { entries: trimmed, index: trimmed.length - 1 };
}

export function removeEntry(history, position) {
    const entries = history.entries.filter((_, index) => index !== position);
    const index = position < history.index ? history.index - 1 : history.index;
    return { entries, index: Math.min(index, entries.length - 1) };
}

export function initProjectHistory({ open, isBusy = () => false, notify = () => {}, storage = localStorage, doc = document }) {
    const back = doc.getElementById('projectBackBtn');
    const next = doc.getElementById('projectNextBtn');
    if (!back || !next) return null;
    let history = readHistory(storage);
    let navigating = false;
    const save = () => {
        try { storage.setItem(STORAGE_KEY, JSON.stringify(history)); }
        catch (error) { notify(`Project history could not be saved: ${error.message}`, 'error'); }
    };
    const name = entry => {
        const option = Array.from(doc.getElementById('uploadedVideos')?.options || [])
            .find(item => item.value === entry.id);
        return option?.dataset.filename || entry.label || entry.id;
    };
    const render = () => {
        const previous = history.entries[history.index - 1];
        const following = history.entries[history.index + 1];
        back.disabled = navigating || !previous;
        next.disabled = navigating || !following;
        back.title = previous ? `Back to previous project: ${name(previous)}` : 'No previous project';
        next.title = following ? `Next project: ${name(following)}` : 'No next project';
        back.setAttribute('aria-label', back.title);
        next.setAttribute('aria-label', next.title);
    };
    const go = async step => {
        const target = history.index + step;
        const entry = history.entries[target];
        if (!entry || navigating) return;
        if (isBusy()) {
            notify('Save or cancel the current edits before switching projects.', 'info');
            return;
        }
        navigating = true;
        render();
        try {
            history.index = target;
            save();
            if (!await open(entry.id)) {
                // Keep the user on the project they came from.
                const origin = history.entries[target - step];
                history = removeEntry({ ...readHistory(storage), index: target - step }, target);
                save();
                notify(`"${name(entry)}" could not be opened and was removed from project history.`, 'error');
                if (origin) await open(origin.id);
            }
        } finally {
            navigating = false;
            render();
        }
    };
    back.addEventListener('click', () => void go(-1));
    next.addEventListener('click', () => void go(1));
    doc.addEventListener('projectOpened', event => {
        const { videoId, label } = event.detail || {};
        if (!videoId) return;
        history = recordVisit(readHistory(storage), videoId, label);
        save();
        render();
    });
    // Another tab may have changed the shared history.
    globalThis.addEventListener?.('storage', event => {
        if (event.key === STORAGE_KEY) { history = readHistory(storage); render(); }
    });
    render();
    return { go, render, get history() { return history; } };
}
