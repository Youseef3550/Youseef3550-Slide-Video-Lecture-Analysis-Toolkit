import { openOptionsDialog, saveBlobToUserLocation } from './utils.js';
import { loadUploadedVideo } from './api-module.js';
import { startElapsedTimer, startProcessButton } from './progress-time.js';
import { clipSeconds } from './custom-clip-range.js';

export function initClipMerge() {
    const get = id => document.getElementById(id);
    const dialog = get('clipMergeDialog');
    let files = [];
    let busy = false;
    let watching = false;
    let currentJob = null;
    let processButton = null;
    let stopping = false;
    const storageKey = 'lectureseek-upload-merge';
    const status = (text, error = false) => {
        get('clipMergeStatus').textContent = text;
        get('clipMergeStatus').classList.toggle('outline-error', error);
    };
    const read = async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || `Video merge failed (${response.status}).`);
        return data;
    };
    function render() {
        const list = get('clipMergeList');
        list.replaceChildren();
        files.forEach((clip, index) => {
            const file = clip.file;
            const row = document.createElement('li');
            const label = document.createElement('span');
            label.textContent = `${index + 1}. ${file.name}`;
            row.append(label);
            for (const [name, direction] of [['Move up', -1], ['Move down', 1], ['Remove', 0]]) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn btn-secondary btn-icon';
                button.textContent = direction === -1 ? '\u2191' : direction === 1 ? '\u2193' : '\u00d7';
                button.title = name;
                button.setAttribute('aria-label', `${name}: ${file.name}`);
                button.disabled = busy || direction === -1 && index === 0 || direction === 1 && index === files.length - 1;
                button.addEventListener('click', () => {
                    if (!direction) files.splice(index, 1);
                    else [files[index], files[index + direction]] = [files[index + direction], files[index]];
                    render();
                });
                row.append(button);
            }
            const trims = document.createElement('div');
            trims.className = 'uploaded-clip-trim';
            for (const [key, caption] of [['start', 'Start'], ['end', 'End']]) {
                const label = document.createElement('label');
                label.textContent = caption;
                const input = document.createElement('input');
                input.type = 'text';
                input.value = clip[key];
                input.placeholder = key === 'end' ? 'Video end' : '00:00';
                input.maxLength = 30;
                input.disabled = busy;
                input.setAttribute('aria-label', `${caption}: ${file.name}`);
                input.addEventListener('input', () => { clip[key] = input.value; });
                label.append(input);
                trims.append(label);
            }
            row.append(trims);
            list.append(row);
        });
        if (busy) {
            if (!processButton) processButton = startProcessButton(get('startClipMergeBtn'), files.length === 1 ? 'Trimming clip' : 'Merging clips');
            processButton.update({cancellable: Boolean(currentJob), stopping});
        } else {
            processButton?.();
            processButton = null;
            get('startClipMergeBtn').disabled = !files.length;
            get('startClipMergeBtn').textContent = files.length === 1 ? 'Trim clip' : 'Merge clips';
        }
        get('clipMergeFiles').disabled = busy;
        get('clipMergeTitle').disabled = busy;
        get('clipMergeOutput').disabled = busy;
    }
    async function watch() {
        if (watching || !currentJob) return;
        watching = true;
        busy = true;
        render();
        const stop = startElapsedTimer(get('clipMergeStatus'));
        try {
            let job;
            while (true) {
                job = await read(await fetch(`/chapter_video_jobs/${encodeURIComponent(currentJob.job_id)}`));
                if (job.status === 'error') throw new Error(job.error || 'Video merge failed.');
                if (job.status === 'cancelled') {
                    status('Merge cancelled.');
                    return;
                }
                if (job.status === 'complete') break;
                // Keep the elapsed label while replacing only the status message.
                get('clipMergeStatus').firstChild.textContent = job.steps?.at(-1)?.message || 'Merging clips...';
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
            status(currentJob.project_id ? 'MP4 ready and saved as an independent project.'
                : 'MP4 ready to download. No project was created.');
            get('downloadMergedClipsBtn').hidden = false;
            get('openMergedProjectBtn').hidden = !currentJob.project_id;
        } catch (error) {
            status(`${error.message} Reopen this dialog to retry checking the saved job.`, true);
        } finally {
            stop();
            busy = false;
            stopping = false;
            watching = false;
            render();
        }
    }
    const open = () => {
        get('extraOptionsMenu').open = false;
        openOptionsDialog(dialog);
        if (!currentJob) {
            try { currentJob = JSON.parse(localStorage.getItem(storageKey) || 'null'); }
            catch (error) {
                status(`Could not restore the saved merge job: ${error.message}. Choose clips to start a new merge.`, true);
            }
        }
        if (currentJob && !watching) { status('Checking saved merge...'); void watch(); }
    };
    get('openClipMergeBtn').addEventListener('click', open);
    get('openClipTrimBtn')?.addEventListener('click', open);
    get('clipMergeFiles').addEventListener('change', event => {
        files = [...files, ...[...event.target.files].map(file => ({file, start: '00:00', end: ''}))];
        event.target.value = '';
        render();
    });
    get('startClipMergeBtn').addEventListener('click', async () => {
        if (busy) { await cancel(); return; }
        if (!files.length || files.length > 30) { status('Choose between 1 and 30 clips.', true); return; }
        if (!get('clipMergeTitle').value.trim()) { status('Enter a video title.', true); return; }
        if (files.some(clip => clip.file.size > 2 * 1024 ** 3)
            || files.reduce((sum, clip) => sum + clip.file.size, 0) > 5 * 1024 ** 3) {
            status('Clips are limited to 2 GB each and 5 GB in total.', true);
            return;
        }
        if (files.some(clip => !Number.isFinite(clipSeconds(clip.start))
            || clip.end.trim() && (!Number.isFinite(clipSeconds(clip.end)) || clipSeconds(clip.end) <= clipSeconds(clip.start)))) {
            status('Use MM:SS or HH:MM:SS (optional milliseconds), with End after Start. Leave End blank for the clip end.', true);
            return;
        }
        busy = true;
        currentJob = null;
        get('downloadMergedClipsBtn').hidden = get('openMergedProjectBtn').hidden = true;
        status('Uploading clips...');
        render();
        const stop = startElapsedTimer(get('clipMergeStatus'));
        try {
            const body = new FormData();
            files.forEach(clip => body.append('files', clip.file));
            body.append('trim_ranges', JSON.stringify(files.map(clip => ({start: clip.start.trim(), end: clip.end.trim()}))));
            body.append('title', get('clipMergeTitle').value.trim());
            body.append('save_project', String(get('clipMergeOutput').value === 'project'));
            currentJob = await read(await fetch(files.length === 1 ? '/trim_uploaded_clips' : '/merge_uploaded_clips',
                {method: 'POST', body}));
            try { localStorage.setItem(storageKey, JSON.stringify(currentJob)); }
            catch (error) { status(`Merge started but could not be remembered across reloads: ${error.message}`, true); }
        } catch (error) {
            status(error.message, true);
        } finally {
            stop();
            busy = false;
            render();
        }
        if (currentJob) await watch();
    });
    async function cancel() {
        if (!currentJob || stopping) return;
        stopping = true;
        render();
        try {
            await read(await fetch(`/chapter_video_jobs/${currentJob.job_id}/cancel`, {method: 'POST'}));
            status('Stopping merge...');
        } catch (error) { stopping = false; render(); status(error.message, true); }
    }
    get('downloadMergedClipsBtn').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        const stop = startElapsedTimer(button);
        try {
            const job = await read(await fetch(`/chapter_video_jobs/${currentJob.job_id}`));
            const response = await fetch(job.download_url);
            if (!response.ok) throw new Error(`Download failed (${response.status}).`);
            await saveBlobToUserLocation(await response.blob(), job.filename, dialog);
        } catch (error) {
            status(error.name === 'AbortError' ? 'Save cancelled.' : error.message, error.name !== 'AbortError');
        } finally { stop(); button.disabled = false; }
    });
    get('openMergedProjectBtn').addEventListener('click', async () => {
        try {
            const select = get('uploadedVideos');
            if (![...select.options].some(option => option.value === currentJob.project_id)) {
                const option = document.createElement('option');
                option.value = currentJob.project_id;
                const job = await read(await fetch(`/chapter_video_jobs/${currentJob.job_id}`));
                option.textContent = `${job.title}.mp4`;
                option.dataset.filename = option.textContent;
                select.append(option);
            }
            select.value = currentJob.project_id;
            dialog.close();
            await loadUploadedVideo(currentJob.project_id);
        } catch (error) { status(`Could not open the merged project: ${error.message}`, true); }
    });
    render();
}
