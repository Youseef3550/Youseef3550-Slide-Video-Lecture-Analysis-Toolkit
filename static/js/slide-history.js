import { state } from './main.js';
import { elements } from './elements.js';
import { openOptionsDialog } from './utils.js';
import { createSlideVideoDownloadButton } from './chapter-projects.js';

export function initSlideHistory() {
    const dialog = document.getElementById('slideHistoryDialog');
    const select = document.getElementById('slideHistorySelect');
    const status = document.getElementById('slideHistoryStatus');
    const images = document.getElementById('slideHistoryImages');
    let sets = [], videoId = '', generation = 0;
    const render = () => {
        images.replaceChildren();
        const set = sets.find(item => item.id === select.value);
        if (!set || videoId !== state.currentVideoId) return;
        for (const [index, scene] of set.scenes.entries()) {
            const row = document.createElement('div');
            row.className = 'slide-history-row';
            const image = document.createElement('img');
            image.src = scene.thumbnail;
            image.loading = 'lazy';
            image.alt = `Slide ${index + 1} at ${scene.timestamp}`;
            const seek = document.createElement('button');
            seek.type = 'button';
            seek.className = 'btn btn-secondary';
            seek.textContent = `${index + 1}. ${scene.timestamp}`;
            seek.addEventListener('click', () => {
                if (state.currentVideoId === videoId) elements.videoPlayer.currentTime = scene.time_seconds;
            });
            const download = document.createElement('a');
            download.href = scene.fullsize;
            download.download = `Slide_${index + 1}.jpg`;
            download.textContent = 'Image';
            row.append(image, seek, download, createSlideVideoDownloadButton(scene, index, set.scenes, elements.videoPlayer));
            images.append(row);
        }
    };
    select.addEventListener('change', render);
    const open = async () => {
        videoId = state.currentVideoId;
        const requestedVideo = videoId, request = ++generation;
        sets = [];
        images.replaceChildren();
        select.replaceChildren();
        document.getElementById('sceneDetectionOptionsDialog').close();
        openOptionsDialog(dialog);
        if (!videoId) { status.textContent = 'Load a video first.'; return; }
        status.textContent = 'Loading saved slides...';
        try {
            const response = await fetch(`/scene_history/${encodeURIComponent(videoId)}`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.detail || 'Could not load slide history.');
            if (request !== generation || requestedVideo !== state.currentVideoId) return;
            sets = data.sets || [];
            for (const set of sets) {
                const option = document.createElement('option');
                option.value = set.id;
                option.textContent = `${new Date(set.created_at * 1000).toLocaleString()} - ${set.scenes.length} slides${set.id === 'current' ? ' (current)' : ''}`;
                select.append(option);
            }
            status.textContent = sets.length ? 'Viewing saved slides does not stop detection or replace its results.'
                : 'No saved slide sets are available yet.';
            render();
        } catch (error) {
            if (request === generation) status.textContent = error.message;
        }
    };
    document.getElementById('slideHistoryBtn').addEventListener('click', open);
    document.getElementById('openSlideHistoryBtn').addEventListener('click', open);
}
