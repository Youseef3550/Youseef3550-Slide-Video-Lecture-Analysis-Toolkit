import { state } from './main.js';
import { openOptionsDialog, saveBlobToUserLocation } from './utils.js';
import { showError } from './ui.js';
import { selectedMediaExportId } from './caption-export.js';
import { splitTimestamps } from './custom-clip-range.js';
import { startElapsedTimer, startProcessButton } from './progress-time.js';

export function initVideoSplit() {
    const get = id => document.getElementById(id);
    const dialog = get('videoSplitDialog');
    const storageKey = 'lectureseek-video-split-job';
    let project = null;
    let job = null;
    let busy = false;
    let watching = false;
    let processButton = null;
    let stopping = false;
    const status = (message, error = false) => {
        get('videoSplitStatus').textContent = message;
        get('videoSplitStatus').classList.toggle('outline-error', error);
    };
    const render = () => {
        for (const id of ['splitVideoFile', 'splitVideoCuts']) get(id).disabled = busy;
        if (busy) {
            if (!processButton) processButton = startProcessButton(get('startVideoSplitBtn'), 'Splitting video');
            processButton.update({cancellable: Boolean(job), stopping});
        } else {
            processButton?.();
            processButton = null;
            get('startVideoSplitBtn').disabled = false;
        }
    };
    const read = async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || `Video split failed (${response.status}).`);
        return data;
    };
    async function watch() {
        if (watching || !job) return;
        watching = busy = true;
        render();
        status('Creating video parts...');
        const stop = startElapsedTimer(get('videoSplitStatus'));
        try {
            while (true) {
                const result = await read(await fetch(`/chapter_video_jobs/${encodeURIComponent(job.job_id)}`));
                if (result.status === 'error') throw new Error(result.error || 'Video splitting failed.');
                if (result.status === 'cancelled') {
                    status('Split cancelled.');
                    break;
                }
                if (result.status === 'complete') {
                    status('Video parts ready. Download the ZIP below.');
                    get('downloadVideoSplitBtn').hidden = false;
                    break;
                }
                get('videoSplitStatus').firstChild.textContent = result.steps?.at(-1)?.message || 'Creating video parts...';
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        } catch (error) {
            status(`${error.message} Reopen this dialog to check the saved job again.`, true);
        } finally {
            stop();
            watching = busy = false;
            stopping = false;
            render();
        }
    }
    function open(useProject) {
        if (busy) {
            openOptionsDialog(dialog);
            return;
        }
        if (useProject && !state.currentVideoId) { showError('Load a video before splitting it.'); return; }
        project = useProject ? {videoId: state.currentVideoId,
            mediaExportId: selectedMediaExportId(state.currentVideoId)} : null;
        get('extraOptionsMenu').open = false;
        get('splitVideoFileLabel').hidden = useProject;
        get('videoSplitHeading').textContent = useProject ? 'Split project video into parts' : 'Split uploaded video into parts';
        if (useProject && get('chapterCutPoints').value.trim()) get('splitVideoCuts').value = get('chapterCutPoints').value;
        openOptionsDialog(dialog);
        if (!job) {
            try { job = JSON.parse(localStorage.getItem(storageKey) || 'null'); }
            catch (error) { status(`Could not restore the saved split: ${error.message}`, true); }
        }
        if (job) void watch();
    }
    get('openUploadedSplitBtn').addEventListener('click', () => open(false));
    get('openProjectSplitBtn').addEventListener('click', () => open(true));
    const basis = get('chapterBasis');
    const syncBasis = () => { get('chapterCutPointsField').hidden = basis.value !== 'timestamps'; };
    basis.addEventListener('change', syncBasis);
    syncBasis();
    get('startVideoSplitBtn').addEventListener('click', async () => {
        if (busy) { await cancel(); return; }
        let cuts;
        try { cuts = splitTimestamps(get('splitVideoCuts').value); }
        catch (error) { status(error.message, true); return; }
        const file = get('splitVideoFile').files[0];
        if (!project && (!file || file.size > 2 * 1024 ** 3)) {
            status('Choose one video up to 2 GB.', true);
            return;
        }
        busy = true;
        job = null;
        get('downloadVideoSplitBtn').hidden = true;
        render();
        status(project ? 'Preparing video parts...' : 'Uploading video...');
        const stop = startElapsedTimer(get('videoSplitStatus'));
        try {
            let response;
            if (project) {
                response = await fetch(`/split_video/${encodeURIComponent(project.videoId)}`, {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({cut_points: cuts, media_export_id: project.mediaExportId}),
                });
            } else {
                const body = new FormData();
                body.append('file', file);
                body.append('cut_points', JSON.stringify(cuts));
                response = await fetch('/split_uploaded_video', {method: 'POST', body});
            }
            job = await read(response);
            try { localStorage.setItem(storageKey, JSON.stringify(job)); }
            catch (error) { showError(`Split started, but it cannot be restored after a reload: ${error.message}`); }
        } catch (error) {
            status(error.message, true);
        } finally {
            stop();
            busy = false;
            render();
        }
        if (job) await watch();
    });
    async function cancel() {
        if (!job || stopping) return;
        stopping = true;
        render();
        try {
            await read(await fetch(`/chapter_video_jobs/${encodeURIComponent(job.job_id)}/cancel`, {method: 'POST'}));
            status('Stopping split...');
        } catch (error) { stopping = false; render(); status(error.message, true); }
    }
    get('downloadVideoSplitBtn').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        const stop = startElapsedTimer(button);
        try {
            const result = await read(await fetch(`/chapter_video_jobs/${encodeURIComponent(job.job_id)}`));
            const response = await fetch(result.download_url);
            if (!response.ok) throw new Error(`ZIP download failed (${response.status}).`);
            await saveBlobToUserLocation(await response.blob(), result.filename, dialog);
        } catch (error) {
            status(error.name === 'AbortError' ? 'Save cancelled.' : error.message, error.name !== 'AbortError');
        } finally {
            stop();
            button.disabled = false;
        }
    });
    render();
}
