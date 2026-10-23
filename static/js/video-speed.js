import { state } from './main.js';
import { openOptionsDialog, saveBlobToUserLocation } from './utils.js';
import { showError } from './ui.js';
import { contentLanguage } from './content-languages.js';
import { selectedMediaExportId, selectedCaptionTrackIndex } from './caption-export.js';
import { clipTimestamp } from './custom-clip-range.js';
import { openDerivedProject } from './chapter-projects.js';
import { startProcessButton } from './progress-time.js';

export function initVideoSpeed() {
    const get = id => document.getElementById(id);
    const dialog = get('videoSpeedDialog');
    const storageKey = 'lectureseek-video-speed-job';
    let source = null, job = null, result = null, busy = false, watching = false, stopping = false, process = null;
    const message = (text, error = false) => {
        get('videoSpeedStatus').textContent = text;
        get('videoSpeedStatus').classList.toggle('outline-error', error);
    };
    const read = async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || `Speed export failed (${response.status}).`);
        return data;
    };
    const render = () => {
        for (const id of ['exportVideoSpeed', 'videoSpeedScope', 'videoSpeedStart', 'videoSpeedEnd',
            'videoSpeedOutput', 'videoSpeedStartHere', 'videoSpeedEndHere']) get(id).disabled = busy;
        if (busy) {
            if (!process) process = startProcessButton(get('startVideoSpeedBtn'), 'Changing video speed');
            process.update({cancellable: Boolean(job), stopping});
        } else {
            process?.();
            process = null;
        }
        get('downloadVideoSpeedBtn').hidden = result?.status !== 'complete';
        get('openSpeedProjectBtn').hidden = result?.status !== 'complete' || !result.project;
    };
    const jobUrl = () => `/${job.kind === 'project' ? 'chapter_project_jobs' : 'chapter_video_jobs'}/${encodeURIComponent(job.job_id)}`;
    async function watch() {
        if (!job || watching) return;
        watching = busy = true;
        render();
        try {
            while (true) {
                result = await read(await fetch(jobUrl()));
                if (result.status === 'error') throw new Error(result.error || 'Speed export failed.');
                if (result.status === 'cancelled') { message('Speed export cancelled.'); break; }
                if (result.status === 'complete') { message('Speed-adjusted video ready.'); break; }
                message(result.steps?.at(-1)?.message || 'Changing video speed...');
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        } catch (error) { message(error.message, true); }
        finally { watching = busy = stopping = false; render(); }
    }
    get('openVideoSpeedBtn').addEventListener('click', () => {
        if (!state.currentVideoId) { showError('Load a video before changing its speed.'); return; }
        if (!busy) {
            source = {
                videoId: state.currentVideoId,
                media_export_id: selectedMediaExportId(state.currentVideoId),
                caption_track_index: selectedCaptionTrackIndex(),
                language: state.currentTranslationLanguage || '',
                chapter_language: contentLanguage(state.currentVideoId, 'chapters', state.currentTranslationLanguage),
                source: state.currentTranscriptSource === 'uploaded' ? 'uploaded'
                    : state.currentTranscriptSource === 'youtube' ? 'youtube' : 'whisper',
                transcript_version_id: state.currentTranscriptVersionId || '',
            };
            get('exportVideoSpeed').value = String(get('videoPlayer').playbackRate);
            try { job = JSON.parse(localStorage.getItem(storageKey) || 'null'); }
            catch (error) { message(`Could not restore speed export: ${error.message}`, true); }
        }
        openOptionsDialog(dialog);
        if (job && !busy) void watch();
    });
    get('videoSpeedScope').addEventListener('change', () => {
        get('videoSpeedRange').hidden = get('videoSpeedScope').value !== 'range';
    });
    for (const [button, input] of [['videoSpeedStartHere', 'videoSpeedStart'], ['videoSpeedEndHere', 'videoSpeedEnd']]) {
        get(button).addEventListener('click', () => {
            const player = get('videoPlayer');
            if (busy) return;
            if (source?.videoId !== state.currentVideoId || selectedMediaExportId(state.currentVideoId) !== source.media_export_id
                || player.readyState < 1 || !Number.isFinite(player.currentTime)) {
                message('Reopen speed options for the currently loaded video.', true);
                return;
            }
            get(input).value = clipTimestamp(player.currentTime);
        });
    }
    get('startVideoSpeedBtn').addEventListener('click', async () => {
        if (busy) {
            if (!job || stopping) return;
            stopping = true;
            render();
            try { await read(await fetch(`${jobUrl()}/cancel`, {method: 'POST'})); message('Stopping speed export...'); }
            catch (error) { stopping = false; render(); message(error.message, true); }
            return;
        }
        if (!source || source.videoId !== state.currentVideoId
            || source.media_export_id !== selectedMediaExportId(state.currentVideoId)) {
            message('The selected video changed. Reopen speed options.', true);
            return;
        }
        busy = true;
        job = result = null;
        render();
        message('Preparing speed export...');
        try {
            const custom = get('videoSpeedScope').value === 'range';
            const payload = {...source, speed: Number(get('exportVideoSpeed').value),
                output: get('videoSpeedOutput').value,
                start: custom ? get('videoSpeedStart').value.trim() : '00:00',
                end: custom ? get('videoSpeedEnd').value.trim() : ''};
            job = await read(await fetch(`/speed_video/${encodeURIComponent(source.videoId)}`, {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
            }));
            try { localStorage.setItem(storageKey, JSON.stringify(job)); }
            catch (error) { showError(`Export started, but progress cannot be restored after reload: ${error.message}`); }
        } catch (error) { message(error.message, true); }
        finally { busy = false; render(); }
        if (job) await watch();
    });
    get('downloadVideoSpeedBtn').addEventListener('click', async event => {
        const finish = startProcessButton(event.currentTarget, 'Downloading video');
        try {
            const current = await read(await fetch(jobUrl()));
            if (current.status !== 'complete') throw new Error('The speed-adjusted video is not ready.');
            const url = job.kind === 'project' ? `/speed_project_jobs/${encodeURIComponent(job.job_id)}/download` : current.download_url;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Video download failed (${response.status}).`);
            await saveBlobToUserLocation(await response.blob(), current.project?.filename || current.filename, dialog);
            message('');
        } catch (error) { message(error.name === 'AbortError' ? 'Save cancelled.' : error.message, error.name !== 'AbortError'); }
        finally { finish(); }
    });
    get('openSpeedProjectBtn').addEventListener('click', async () => {
        if (state.outlineRowEditing || document.querySelector('.is-inline-editing')) {
            showError('Save or cancel your open edit before opening a new project.');
            return;
        }
        const finish = startProcessButton(get('openSpeedProjectBtn'), 'Opening project');
        try {
            const current = await read(await fetch(jobUrl()));
            if (current.status !== 'complete' || !current.project) throw new Error('The new project is not ready.');
            await openDerivedProject(current.project);
            dialog.close();
        } catch (error) { message(error.message, true); }
        finally { finish(); }
    });
    render();
}
