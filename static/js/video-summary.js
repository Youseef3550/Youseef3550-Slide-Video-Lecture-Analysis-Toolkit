import { state } from './main.js';
import { elements } from './elements.js';
import { startElapsedTimer, startProcessButton } from './progress-time.js';

export function initVideoSummary() {
    const button = document.getElementById('generateVideoSummaryBtn');
    const paragraph = document.getElementById('videoSummaryText');
    const status = document.getElementById('videoSummaryStatus');
    const panel = document.getElementById('videoSummaryPanel');
    const setStatus = message => {
        status.textContent = message;
        status.hidden = !message;
    };
    let selection = 0;
    let currentKey = '';
    let busyKey = '';
    const snapshot = () => ({
        videoId: state.currentVideoId, transcript: state.currentTranscript || [],
        transcript_language: state.currentTranslationLanguage || '',
    });
    const key = value => JSON.stringify([value.videoId, value.transcript_language,
        value.transcript.map(item => item.text)]);
    const refresh = async () => {
        const current = snapshot();
        const nextKey = key(current);
        button.disabled = !current.videoId || !current.transcript.length || Boolean(busyKey);
        if (nextKey === currentKey) return;
        currentKey = nextKey;
        const generation = ++selection;
        paragraph.textContent = '';
        panel.hidden = true;
        panel.open = false;
        setStatus('');
        if (!current.videoId || !current.transcript.length) {
            return;
        }
        try {
            const response = await fetch(`/video_summary/${encodeURIComponent(current.videoId)}/load`, {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(current),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.detail || `Could not load summary (${response.status})`);
            if (generation !== selection || nextKey !== key(snapshot())) return;
            paragraph.textContent = data.summary || '';
            panel.hidden = !paragraph.textContent;
        } catch (error) {
            if (generation === selection) setStatus(error.message);
        }
    };
    button.addEventListener('click', async () => {
        const current = snapshot();
        const requestKey = key(current);
        if (!current.videoId || !current.transcript.length || busyKey) return;
        busyKey = requestKey;
        ++selection;
        button.disabled = true;
        button.textContent = 'Generating summary...';
        setStatus('Reading the whole transcript and writing one short paragraph...');
        const stopElapsed = startElapsedTimer(status);
        const stopButtonElapsed = startProcessButton(button, 'Generating summary');
        try {
            const response = await fetch(`/video_summary/${encodeURIComponent(current.videoId)}/generate`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({...current, model: elements.summaryModel?.value || null}),
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.detail || data.error || 'Summary generation failed.');
            if (requestKey !== key(snapshot())) return;
            ++selection;
            paragraph.textContent = data.summary;
            panel.hidden = false;
            panel.open = true;
            setStatus('');
        } catch (error) {
            if (requestKey === key(snapshot())) setStatus(`${error.message} Any previously saved summary was kept.`);
        } finally {
            stopElapsed();
            stopButtonElapsed();
            busyKey = '';
            button.textContent = 'Generate summary';
            button.disabled = !state.currentVideoId || !state.currentTranscript?.length;
        }
    });
    for (const event of ['transcriptUpdated', 'videoSelectionChanged']) {
        document.addEventListener(event, () => void refresh());
    }
    void refresh();
}
