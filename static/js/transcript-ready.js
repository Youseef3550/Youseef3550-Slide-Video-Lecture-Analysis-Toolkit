const PREFERENCE_KEY = 'lectureseek-transcript-ready-action';
const ACTIONS = ['ask', 'chapters', 'slides', 'both', 'none'];

export function initTranscriptReady({ state, chapters, slides, notify, doc = document, storage = localStorage }) {
    const prompt = doc.getElementById('transcriptReadyPrompt');
    const remember = doc.getElementById('rememberTranscriptReady');
    const preference = doc.getElementById('transcriptReadyAction');
    if (!prompt || !remember || !preference) return;
    let pending = null;
    const seen = new Map();
    const read = () => {
        try {
            const value = storage.getItem(PREFERENCE_KEY) || 'ask';
            return ACTIONS.includes(value) ? value : 'ask';
        } catch (error) {
            notify(`Could not read the transcript-ready preference: ${error.message}`, 'error');
            return 'ask';
        }
    };
    const save = value => {
        try {
            storage.setItem(PREFERENCE_KEY, value);
            preference.value = value;
        } catch (error) {
            notify(`Could not save the transcript-ready preference: ${error.message}`, 'error');
        }
    };
    const key = () => JSON.stringify([state.currentVideoId, state.currentTranscriptSource,
        state.currentTranscript.map(cue => [cue.start, cue.text])]);
    const current = item => item && item.videoId === state.currentVideoId
        && state.currentTranscript?.length && item.key === key();
    const run = async (action, item, automatic = false) => {
        if (!current(item)) return;
        const wantChapters = action === 'chapters' || action === 'both';
        const wantSlides = action === 'slides' || action === 'both';
        if ((wantChapters && (state.summaryGenerationInProgress || state.outlineRowEditing))
            || (wantSlides && doc.getElementById('detectScenesBtn')?.disabled)) {
            notify('Processing or editing is already running. Start the remaining action from its controls when ready.', 'info');
            return;
        }
        const tasks = [];
        if (wantChapters && !(automatic && state.videoChapters?.length)) tasks.push(chapters());
        if (wantSlides && !(automatic && state.videoScenes?.length)) tasks.push(slides());
        const results = await Promise.allSettled(tasks);
        for (const result of results) {
            if (result.status === 'rejected') notify(`Could not start processing: ${result.reason?.message || result.reason}`, 'error');
        }
    };
    preference.value = read();
    preference.addEventListener('change', () => save(preference.value));
    for (const button of prompt.querySelectorAll('[data-ready-action]')) {
        button.addEventListener('click', () => {
            const action = button.dataset.readyAction;
            const item = pending;
            if (!current(item)) { prompt.hidden = true; pending = null; return; }
            if (remember.checked) save(action);
            prompt.hidden = true;
            pending = null;
            void run(action, item);
        });
    }
    doc.addEventListener('newTranscriptReady', event => {
        // Let the loading flow finish installing the transcript and slide controls first.
        setTimeout(() => {
            const videoId = event.detail?.videoId;
            if (videoId !== state.currentVideoId || !state.currentTranscript?.length) return;
            const signature = key();
            if (seen.get(videoId) === signature) return;
            seen.set(videoId, signature);
            const item = { videoId, key: signature };
            const action = read();
            if (action === 'ask') {
                pending = item;
                remember.checked = false;
                prompt.hidden = false;
            } else {
                void run(action, item, true);
            }
        }, 0);
    });
    doc.addEventListener('videoSelectionChanged', () => {
        pending = null;
        prompt.hidden = true;
    });
}
