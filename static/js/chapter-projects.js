import { state } from './main.js';
import { loadUploadedVideo } from './api-module.js';
import { showError, showNotification } from './ui.js';
import { contentLanguage } from './content-languages.js';
import { saveBlobToUserLocation, openOptionsDialog } from './utils.js';
import { initCustomClipRange, clipTimestamp } from './custom-clip-range.js';
import { selectedMediaExportId, selectedCaptionTrackIndex } from './caption-export.js';
import { startProcessButton } from './progress-time.js';

const storageKey = 'lectureseek-chapter-project-job';
let pending = null;
let timer = null;
let checking = false;
let starting = false;
let projectButton = null;
let projectProgress = null;

async function cancelProject() {
    if (!pending || pending.ready) return;
    projectProgress?.update({stopping: true});
    try {
        const response = await fetch(`/chapter_project_jobs/${encodeURIComponent(pending.jobId)}/cancel`, {method: 'POST'});
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || 'Could not stop chapter project.');
        render('Stopping chapter encoding and removing incomplete output...');
    } catch (error) {
        projectProgress?.update({stopping: false});
        showError(error.message);
    }
}

function statusElements() {
    return {
        status: document.getElementById('chapterProjectStatus'),
        open: document.getElementById('openChapterProjectBtn'),
    };
}

function savePending() {
    if (pending) localStorage.setItem(storageKey, JSON.stringify(pending));
    else localStorage.removeItem(storageKey);
}

function render(message, project = null) {
    const {status, open} = statusElements();
    status.hidden = false;
    status.textContent = message;
    open.hidden = !project;
    open.onclick = project ? () => void openProject(project) : null;
    const cancel = document.getElementById('cancelChapterProjectBtn');
    if (cancel) {
        cancel.hidden = !pending || Boolean(pending.ready) || Boolean(projectButton !== cancel && projectButton?.isConnected);
        if (!cancel.hidden && projectButton !== cancel) {
            projectButton = cancel;
            projectProgress = startProcessButton(cancel, 'Creating chapter project', {cancellable: true});
        }
    }
    if ((!pending && !starting) || pending?.ready) {
        projectProgress?.();
        projectProgress = null;
        projectButton = null;
    }
}

export async function openDerivedProject(project) {
    const select = document.getElementById('uploadedVideos');
    if (select) {
        let option = Array.from(select.options).find(item => item.value === project.video_id);
        if (!option) {
            option = document.createElement('option');
            option.value = project.video_id;
            option.textContent = project.filename;
            option.dataset.filename = project.filename;
            select.appendChild(option);
        }
        select.value = project.video_id;
    }
    await loadUploadedVideo(project.video_id);
}

async function openProject(project) {
    await openDerivedProject(project);
    if (state.currentVideoId !== project.video_id) return;
    pending = null;
    savePending();
    statusElements().status.hidden = true;
    statusElements().open.hidden = true;
    showNotification('Opened chapter project.', 'success');
}

async function checkJob() {
    if (!pending || checking) return;
    checking = true;
    try {
        const response = await fetch(`/chapter_project_jobs/${encodeURIComponent(pending.jobId)}`);
        const job = await response.json();
        if (!response.ok) throw new Error(job.detail || `Could not check chapter project (${response.status})`);
        if (job.status === 'complete') {
            pending.ready = true;
            savePending();
            render(`Chapter project ready: ${job.project.filename} (${job.project.slides} slides).`, job.project);
            if (state.currentVideoId === pending.parentId) await openProject(job.project);
            return;
        }
        if (job.status === 'error') {
            pending = null;
            savePending();
            throw new Error(job.error || 'Chapter project creation failed.');
        }
        if (job.status === 'cancelled') {
            pending = null;
            savePending();
            render('Chapter project cancelled.');
            return;
        }
        const step = job.steps?.at(-1)?.message || 'Preparing chapter project';
        projectProgress?.update({cancellable: true});
        render(`${step} (${Math.floor(job.elapsed || 0)}s elapsed)`);
        timer = setTimeout(() => void checkJob(), 2000);
    } catch (error) {
        render(error.message);
        showError(error.message);
        if (pending) timer = setTimeout(() => void checkJob(), 5000);
    } finally {
        checking = false;
    }
}

function clipSelection(chapter, index, chapters, sectionIndex) {
    return {
        chapter_index: index,
        ...(sectionIndex == null ? {} : {section_index: sectionIndex}),
        timestamp: chapter.timestamp, title: chapter.title,
        next_timestamp: (sectionIndex == null ? null : chapters[index].sections[sectionIndex + 1]?.timestamp)
            || chapters[index + 1]?.timestamp || null,
        ...(chapters[0]?.clip_arrangement ? {arrangement: chapters[0].clip_arrangement} : {}),
    };
}

export function createChapterProjectButton(chapter, index, chapters, sectionIndex = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary btn-action btn-icon chapter-project-button';
    button.innerHTML = '<i class="fas fa-external-link-alt" aria-hidden="true"></i>';
    button.title = 'Open as a project';
    button.setAttribute('aria-label', 'Open as a project');
    button.addEventListener('click', async event => {
        event.stopPropagation();
        if (projectButton === button && pending && !pending.ready) { await cancelProject(); return; }
        if (state.outlineRowEditing || document.querySelector('.is-inline-editing')) {
            showError('Save or cancel your edits before opening a chapter project.');
            return;
        }
        if ((pending && !pending.ready) || starting) {
            showNotification('A chapter project is already being created. Its progress is shown above.', 'info');
            return;
        }
        const parentId = state.currentVideoId;
        const snapshot = {
            ...clipSelection(chapter, index, chapters, sectionIndex),
            language: state.currentTranslationLanguage || '',
            chapter_language: contentLanguage(parentId, 'chapters', state.currentTranslationLanguage),
            source: state.currentTranscriptSource === 'uploaded' ? 'uploaded'
                : state.currentTranscriptSource === 'youtube' ? 'youtube' : 'whisper',
            transcript_version_id: state.currentTranscriptVersionId || '',
            media_export_id: selectedMediaExportId(parentId),
            caption_track_index: selectedCaptionTrackIndex(),
        };
        projectButton = button;
        projectProgress = startProcessButton(button, 'Creating chapter project');
        starting = true;
        pending = null;
        try {
            if (!parentId) throw new Error('Load a video before opening a chapter project.');
            render('Creating chapter project...');
            const response = await fetch(`/chapter_projects/${encodeURIComponent(parentId)}`, {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(snapshot),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.detail || `Could not create chapter project (${response.status})`);
            pending = {jobId: data.job_id, parentId};
            projectProgress.update({cancellable: true});
            savePending();
            void checkJob();
        } catch (error) {
            render(error.message);
            showError(error.message);
        } finally {
            starting = false;
            if (!pending || pending.ready) {
                projectProgress?.();
                projectProgress = null;
                projectButton = null;
                button.disabled = false;
            }
        }
    });
    return button;
}

export function initChapterProjects() {
    const selectedButton = document.getElementById('downloadSelectedClipsBtn');
    const selectedStatus = document.getElementById('selectedClipsStatus');
    const updateSelectionActions = () => {
        const selected = Array.from(document.querySelectorAll('.clip-selection:checked'));
        const count = selected.length;
        const all = Array.from(document.querySelectorAll('.clip-selection'));
        const selectAll = document.getElementById('selectAllClipsBtn');
        const unselectAll = document.getElementById('unselectAllClipsBtn');
        if (selectAll) selectAll.disabled = !all.length || count === all.length;
        if (unselectAll) unselectAll.disabled = count === 0;
        const bar = document.getElementById('clipSelectionActions');
        if (bar) bar.hidden = count === 0;
        const label = document.getElementById('clipSelectionCount');
        if (label) label.textContent = `${count} selected`;
        const parts = selected.map(input => JSON.parse(input.dataset.clipSelection));
        const sectionsOnly = count > 0 && parts.every(part => Number.isInteger(part.section_index));
        const chaptersOnly = count > 1 && parts.every(part => !Number.isInteger(part.section_index));
        const chapterIndexes = parts.map(part => part.chapter_index).sort((a, b) => a - b);
        const adjacentChapters = chaptersOnly && chapterIndexes.some((index, at) => at > 0 && index === chapterIndexes[at - 1] + 1);
        const ordered = parts.slice().sort((a, b) =>
            a.chapter_index - b.chapter_index || a.section_index - b.section_index);
        const adjacent = sectionsOnly && ordered.some((part, index) => {
            const previous = ordered[index - 1];
            return previous && (
                (part.chapter_index === previous.chapter_index &&
                    part.section_index === previous.section_index + 1) ||
                (part.chapter_index === previous.chapter_index + 1 && part.section_index === 0 &&
                    previous.section_index === state.videoChapters?.[previous.chapter_index]?.sections?.length - 1));
        });
        const remove = document.getElementById('deleteSelectedSectionsBtn');
        const merge = document.getElementById('mergeSelectedSectionsBtn');
        if (remove) remove.disabled = !sectionsOnly;
        if (merge) {
            merge.disabled = !adjacent && !adjacentChapters;
            merge.title = merge.disabled
                ? 'Select two or more adjacent sections, or two or more adjacent chapters, to merge'
                : adjacentChapters ? 'Merge selected adjacent chapters' : 'Merge selected adjacent sections';
        }
    };
    document.addEventListener('change', event => {
        if (event.target.matches('.clip-selection')) updateSelectionActions();
    });
    document.addEventListener('sectionSelectionChanged', updateSelectionActions);
    document.addEventListener('chaptersUpdated', () => {
        if (selectedStatus) selectedStatus.textContent = '';
        updateSelectionActions();
    });
    document.getElementById('clearClipSelectionBtn')?.addEventListener('click', () => {
        document.querySelectorAll('.clip-selection:checked').forEach(input => { input.checked = false; });
        updateSelectionActions();
    });
    for (const [id, checked] of [['selectAllClipsBtn', true], ['unselectAllClipsBtn', false]]) {
        document.getElementById(id)?.addEventListener('click', () => {
            document.querySelectorAll('.clip-selection').forEach(input => { input.checked = checked; });
            updateSelectionActions();
        });
    }
    updateSelectionActions();
    const selectedProjectButton = document.getElementById('projectSelectedClipsBtn');
    async function exportSelected(asProject = false) {
        const button = asProject ? selectedProjectButton : selectedButton;
        if (asProject && projectButton === button && pending && !pending.ready) {
            await cancelProject();
            return;
        }
        if (button.disabled) return;
        if (asProject && (starting || (pending && !pending.ready))) {
            showError('Wait for the current project to finish or stop it first.');
            return;
        }
        if (state.outlineRowEditing || document.querySelector('.is-inline-editing')) {
            showError('Save or cancel your edits before downloading selected parts.');
            return;
        }
        const selected = Array.from(document.querySelectorAll('.clip-selection:checked'));
        if (!selected.length) {
            selectedStatus.textContent = 'Select chapters or sections using their checkboxes first.';
            return;
        }
        const videoId = state.currentVideoId;
        const language = contentLanguage(videoId, 'chapters', state.currentTranslationLanguage);
        const selections = selected.map(input => ({
            ...JSON.parse(input.dataset.clipSelection),
            chapter_language: language, language: state.currentTranslationLanguage || '',
            source: state.currentTranscriptSource === 'uploaded' ? 'uploaded'
                : state.currentTranscriptSource === 'youtube' ? 'youtube' : 'whisper',
            transcript_version_id: state.currentTranscriptVersionId || '',
        }));
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        selectedStatus.setAttribute('aria-busy', 'true');
        selectedStatus.textContent = 'Preparing selected clips...';
        selectedStatus.classList.remove('outline-error');
        try {
            const settings = {
                selections, merge_consecutive: document.getElementById('mergeSelectedClips').checked,
                combine: document.getElementById('mergeSelectedClips').checked,
                media_export_id: selectedMediaExportId(videoId), caption_track_index: selectedCaptionTrackIndex(),
                arrangement: state.videoChapters?.[0]?.clip_arrangement,
            };
            if (asProject) {
                starting = true;
                projectButton = button;
                projectProgress = startProcessButton(button, 'Creating selected clip project');
                render('Creating selected clip project...');
                const response = await fetch(`/selected_clip_projects/${encodeURIComponent(videoId)}`, {
                    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(settings),
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.detail || 'Could not create selected clip project.');
                pending = {jobId: data.job_id, parentId: videoId};
                projectProgress.update({cancellable: true});
                savePending();
                void checkJob();
                selectedStatus.textContent = '';
            } else {
                await downloadVideoClip(`/selected_videos/${encodeURIComponent(videoId)}`, settings,
                    message => { if (state.currentVideoId === videoId) selectedStatus.textContent = message; }, button);
            }
        } catch (error) {
            if (state.currentVideoId === videoId) {
                selectedStatus.textContent = error.name === 'AbortError' ? 'Download cancelled.' : error.message;
                selectedStatus.classList.toggle('outline-error', error.name !== 'AbortError');
            }
        } finally {
            if (asProject) {
                starting = false;
                if (!pending || pending.ready) {
                    projectProgress?.();
                    projectProgress = projectButton = null;
                }
            }
            button.disabled = false;
            button.setAttribute('aria-busy', 'false');
            selectedStatus.setAttribute('aria-busy', 'false');
        }
    }
    selectedButton?.addEventListener('click', () => exportSelected());
    selectedProjectButton?.addEventListener('click', () => exportSelected(true));
    const clipDialog = document.getElementById('customClipDialog');
    const clipStart = document.getElementById('customClipStart');
    const clipEnd = document.getElementById('customClipEnd');
    const clipStatus = document.getElementById('customClipStatus');
    const player = document.querySelector('video');
    let clipRange = null;
    clipDialog?.addEventListener('close', () => clipRange?.close());
    clipDialog?.addEventListener('keydown', event => {
        if (event.key === 'Escape') clipDialog.close();
    });
    document.addEventListener('videoSelectionChanged', () => {
        clipRange?.close();
        clipDialog?.close();
    });
    player?.addEventListener('emptied', () => {
        clipRange?.close();
        clipDialog?.close();
    });
    player?.addEventListener('durationchange', () => {
        if (!clipDialog?.open) return;
        clipRange?.close();
        clipDialog.close();
    });
    document.getElementById('closeCustomClipBtn')?.addEventListener('click', () => clipDialog.close());
    let clipVideoId = null;
    document.getElementById('customClipBtn')?.addEventListener('click', () => {
        if (!state.currentVideoId || !Number.isFinite(player?.duration) || player.duration < 0.001) {
            showError('Load a video before downloading a custom clip.');
            return;
        }
        clipVideoId = state.currentVideoId;
        if (!clipRange) clipRange = initCustomClipRange(player);
        clipRange.open();
        clipStatus.textContent = '';
        openOptionsDialog(clipDialog);
    });
    document.getElementById('customClipForm')?.addEventListener('submit', async event => {
        event.preventDefault();
        const button = document.getElementById('downloadCustomClipBtn');
        if (button.disabled) return;
        if (clipVideoId !== state.currentVideoId) {
            clipStatus.textContent = 'The video changed. Close and reopen the custom clip dialog.';
            return;
        }
        if (!clipRange.validate()) return;
        button.disabled = true;
        document.getElementById('customClipBtn').disabled = true;
        button.setAttribute('aria-busy', 'true');
        clipStatus.setAttribute('aria-busy', 'true');
        clipStatus.textContent = 'Preparing custom clip...';
        try {
            await downloadVideoClip(`/custom_video/${encodeURIComponent(clipVideoId)}`, {
                start: clipStart.value.trim(), end: clipEnd.value.trim(),
                media_export_id: selectedMediaExportId(clipVideoId),
                caption_track_index: selectedCaptionTrackIndex(),
            }, message => { clipStatus.textContent = message; }, button);
        } catch (error) {
            clipStatus.textContent = error.name === 'AbortError' ? 'Download cancelled.' : error.message;
        } finally {
            button.disabled = false;
            document.getElementById('customClipBtn').disabled = false;
            button.setAttribute('aria-busy', 'false');
            clipStatus.setAttribute('aria-busy', 'false');
        }
    });
    document.getElementById('cancelChapterProjectBtn')?.addEventListener('click', () => void cancelProject());
    const saved = localStorage.getItem(storageKey);
    if (!saved) return;
    try {
        const value = JSON.parse(saved);
        if (typeof value.jobId !== 'string' || typeof value.parentId !== 'string') {
            throw new Error('Saved chapter project progress is invalid.');
        }
        pending = value;
        if (timer) clearTimeout(timer);
        void checkJob();
    } catch (error) {
        localStorage.removeItem(storageKey);
        showError(`Could not restore chapter project progress: ${error.message}`);
    }
}

export function createClipSelection(chapter, index, chapters, sectionIndex = null) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'clip-selection';
    input.dataset.clipSelection = JSON.stringify(clipSelection(chapter, index, chapters, sectionIndex));
    input.setAttribute('aria-label', `Select ${sectionIndex == null ? 'chapter' : 'section'}: ${chapter.title}`);
    input.title = 'Select for download or section actions';
    for (const name of ['click', 'keydown']) input.addEventListener(name, event => event.stopPropagation());
    return input;
}

export function createChapterDownloadButton(chapter, index, chapters, sectionIndex = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary btn-action btn-icon chapter-video-download';
    button.innerHTML = '<i class="fas fa-download" aria-hidden="true"></i>';
    button.title = `Download ${sectionIndex == null ? 'chapter' : 'section'} video`;
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', async event => {
        event.stopPropagation();
        if (button.closest('.is-inline-editing')) {
            showError('Save or cancel your edits before downloading a chapter.');
            return;
        }
        button.disabled = true;
        const videoId = state.currentVideoId;
        const status = document.getElementById('chapterProjectStatus');
        button.setAttribute('aria-busy', 'true');
        status.setAttribute('aria-busy', 'true');
        try {
            await downloadVideoClip(`/chapter_video/${encodeURIComponent(videoId)}`, {
                    ...clipSelection(chapter, index, chapters, sectionIndex),
                    chapter_language: contentLanguage(videoId, 'chapters', state.currentTranslationLanguage),
                    language: state.currentTranslationLanguage || '',
                    source: state.currentTranscriptSource === 'uploaded' ? 'uploaded'
                        : state.currentTranscriptSource === 'youtube' ? 'youtube' : 'whisper',
                    transcript_version_id: state.currentTranscriptVersionId || '',
                    media_export_id: selectedMediaExportId(videoId),
                    caption_track_index: selectedCaptionTrackIndex(),
            }, message => {
                if (state.currentVideoId === videoId) {
                    status.hidden = false;
                    status.textContent = message;
                }
            }, button);
        } catch (error) {
            if (error.name !== 'AbortError') showError(error.message);
        } finally {
            button.disabled = false;
            button.setAttribute('aria-busy', 'false');
            status.setAttribute('aria-busy', 'false');
        }
    });
    return button;
}

export function createSlideVideoDownloadButton(scene, index, scenes, player) {
    const owningVideoId = state.currentVideoId;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-secondary btn-action btn-icon slide-video-download';
    button.innerHTML = '<i class="fas fa-film" aria-hidden="true"></i>';
    button.title = `Download slide ${index + 1} video (until next slide or video end)`;
    button.setAttribute('aria-label', button.title);
    button.addEventListener('click', async event => {
        event.stopPropagation();
        if (button.disabled) return;
        const videoId = state.currentVideoId;
        if (videoId !== owningVideoId) {
            showError('Video changed. Reopen the slide set before downloading its video.');
            return;
        }
        const start = Number(scene.time_seconds);
        const end = index + 1 < scenes.length ? Number(scenes[index + 1].time_seconds) : player.duration;
        if (!videoId || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
            showError('Load the video duration and valid detected slides before downloading a slide video.');
            return;
        }
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        const status = document.createElement('p');
        status.className = 'slide-video-status';
        status.setAttribute('role', 'status');
        button.parentElement.appendChild(status);
        try {
            await downloadVideoClip(`/custom_video/${encodeURIComponent(videoId)}`, {
                start: clipTimestamp(start), end: clipTimestamp(end),
                media_export_id: selectedMediaExportId(videoId),
                caption_track_index: selectedCaptionTrackIndex(),
            }, message => { status.textContent = message; }, button);
        } catch (error) {
            status.textContent = error.name === 'AbortError' ? 'Download cancelled.' : error.message;
            if (error.name !== 'AbortError') showError(error.message);
        } finally {
            button.disabled = false;
            button.setAttribute('aria-busy', 'false');
        }
    });
    return button;
}

const clipStatusTimers = new WeakMap();

async function downloadVideoClip(url, payload, progress, button = null) {
    const statusOwner = button || progress;
    clearTimeout(clipStatusTimers.get(statusOwner));
    clipStatusTimers.delete(statusOwner);
    const process = startProcessButton(button, 'Creating video clip');
    let jobId = null, stopping = false;
    const cancel = async event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!jobId || stopping) return;
        stopping = true;
        process.update({stopping: true});
        try {
            const response = await fetch(`/chapter_video_jobs/${encodeURIComponent(jobId)}/cancel`, {method: 'POST'});
            const data = await response.json();
            if (!response.ok) throw new Error(data.detail || 'Could not stop video clip creation.');
            progress('Stopping video clip creation...');
        } catch (error) {
            stopping = false;
            process.update({stopping: false});
            showError(error.message);
        }
    };
    button?.addEventListener('click', cancel, true);
    try {
        const response = await fetch(url, {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || 'Could not prepare video clip.');
        jobId = data.job_id;
        process.update({cancellable: true});
        while (true) {
            const response = await fetch(`/chapter_video_jobs/${encodeURIComponent(data.job_id)}`);
            const job = await response.json();
            if (job.status === 'cancelled') throw new DOMException('Video clip creation stopped.', 'AbortError');
            if (!response.ok || job.status === 'error') throw new Error(job.detail || job.error || 'Video clip encoding failed.');
            progress(job.steps?.at(-1)?.message || 'Preparing video clip...');
            if (job.status === 'complete') {
                process.update({label: 'Downloading video clip', cancellable: false});
                const download = await fetch(job.download_url);
                if (!download.ok) throw new Error('Could not download the video clip.');
                await saveBlobToUserLocation(await download.blob(), job.filename);
                progress('Video clip downloaded.');
                const timer = setTimeout(() => {
                    if (clipStatusTimers.get(statusOwner) !== timer) return;
                    clipStatusTimers.delete(statusOwner);
                    progress('');
                }, 4000);
                clipStatusTimers.set(statusOwner, timer);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    } finally {
        button?.removeEventListener('click', cancel, true);
        process();
    }
}
