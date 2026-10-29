// video.js - Video player functionality

import { elements } from './elements.js';
import { formatTime } from './utils.js';
import { state } from './main.js';
import { updateActiveTranscript } from './transcript.js';
import { navigationParts, activePart, conciseTitle, chapterStart, sceneTopicTitle, slideTitle } from './chapter-navigation.js';
import { contentLanguage } from './content-languages.js';
import { scrollWithinContainer } from './scroll-utils.js';
import { outlineRanges, skipTarget } from './outline-ranges.js';
import { updateActiveChapter } from './chapters.js';
import { showError } from './ui.js';

export function initPlaybackSpeed(player, select) {
    const apply = () => {
        const rate = Number(select.value);
        try {
            if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) {
                throw new Error('Choose a playback speed between 0.25 and 4.');
            }
            player.defaultPlaybackRate = rate;
            if (player.playbackRate !== rate) player.playbackRate = rate;
        } catch (error) {
            select.value = String(player.playbackRate);
            showError(`Could not change playback speed: ${error.message}`);
        }
    };
    select.addEventListener('change', apply);
    for (const event of ['loadedmetadata', 'loadstart']) player.addEventListener(event, apply);
    player.addEventListener('ratechange', () => {
        if (player.readyState === 0) return;
        const rate = String(player.playbackRate);
        if ([...select.options].some(option => option.value === rate)) {
            select.value = rate;
            if (player.defaultPlaybackRate !== player.playbackRate) player.defaultPlaybackRate = player.playbackRate;
        }
    });
    apply();
}

export function initSecondJumps(player) {
    const buttons = [['jumpBackSecondBtn', -1, 'seekBackInterval'], ['jumpForwardSecondBtn', 1, 'seekForwardInterval']]
        .map(([id, delta, interval]) => [document.getElementById(id), delta, document.getElementById(interval)]);
    let delay, repeat, held = null, suppressClick = null;
    let seeking = false, painting = false, repeating = false, generation = 0;
    const pending = [];
    const step = interval => interval?.value === '60' ? 60 : 1;
    const ready = () => Number.isFinite(player.duration) && player.duration > 0 && player.readyState >= 1;
    const stop = () => {
        clearTimeout(delay);
        clearTimeout(repeat);
        repeating = false;
        held = null;
    };
    const scheduleRepeat = () => {
        if (!held || !repeating || seeking || painting) return;
        clearTimeout(repeat);
        repeat = setTimeout(() => {
            if (!held) return;
            const [, delta, interval] = buttons.find(([button]) => button === held);
            jump(delta, interval);
        }, 150);
    };
    const seekNext = () => {
        if (seeking || painting || player.seeking || !ready()) return;
        const delta = pending.shift();
        if (delta == null) { scheduleRepeat(); return; }
        const target = Math.max(0, Math.min(player.duration, player.currentTime + delta));
        if (target === player.currentTime) { pending.length = 0; stop(); return; }
        seeking = true;
        player.currentTime = target;
    };
    const jump = (delta, interval) => {
        if (!ready()) return;
        pending.push(delta * step(interval));
        seekNext();
    };
    player.addEventListener('seeked', () => {
        seeking = false;
        if (painting) return;
        painting = true;
        const request = generation;
        // Let the decoded destination frame paint before another seek replaces it.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (request !== generation) return;
            painting = false;
            seekNext();
        }));
    });
    const reset = () => {
        stop();
        ++generation;
        pending.length = 0;
        seeking = painting = false;
    };
    for (const name of ['emptied', 'loadstart', 'error']) player.addEventListener(name, reset);
    const refresh = () => {
        if (!ready()) stop();
        buttons.forEach(([button, delta, interval]) => {
            button.disabled = !ready();
            if (interval) interval.disabled = !ready();
            const label = `Jump ${delta < 0 ? 'backward' : 'forward'} ${step(interval) === 60 ? '1 minute' : '1 second'}`;
            button.title = `${label} (hold to repeat)`;
            button.setAttribute('aria-label', label);
            const number = button.querySelector('.seek-jump-number');
            if (number) number.textContent = step(interval) === 60 ? '1m' : '1s';
        });
    };
    for (const [button, delta, interval] of buttons) {
        const start = () => {
            if (held || !ready()) return;
            held = button;
            suppressClick = button;
            jump(delta, interval);
            delay = setTimeout(() => {
                repeating = true;
                scheduleRepeat();
            }, 400);
        };
        button.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            button.setPointerCapture(event.pointerId);
            start();
        });
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) {
            button.addEventListener(name, stop);
        }
        button.addEventListener('keydown', event => {
            if (![' ', 'Enter'].includes(event.key)) return;
            event.preventDefault();
            if (!event.repeat) start();
        });
        button.addEventListener('keyup', event => {
            if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); stop(); suppressClick = null; }
        });
        button.addEventListener('click', event => {
            if (suppressClick === button && event.detail !== 0) { suppressClick = null; return; }
            suppressClick = null;
            jump(delta, interval);
        });
        interval?.addEventListener('change', () => {
            stop();
            for (const [, , other] of buttons) {
                if (other) other.value = interval.value;
            }
            refresh();
        });
    }
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    for (const name of ['loadedmetadata', 'durationchange', 'emptied']) player.addEventListener(name, refresh);
    refresh();
}

export function updateChapterCaptions() {
    const language = contentLanguage(state.currentVideoId, 'slides', state.currentTranslationLanguage);
    const parts = navigationParts(state.videoChapters || [], state.videoScenes || [], state.navigationKinds ?? state.chapterGrouping, language);
    const caption = document.getElementById('currentChapterTitle');
    if (caption) {
        const text = activePart(parts, elements.videoPlayer.currentTime)?.title
            || 'No chapter or slide title available at this time.';
        caption.title = text;
        if (caption.textContent !== conciseTitle(text)) caption.textContent = conciseTitle(text);
    }
    syncTimelineGrouping();
    document.querySelectorAll('.timeline-item:not(.chapter-card)').forEach((item) => {
        const image = item.querySelector('.timeline-thumbnail');
        if (!image) return;
        let title = item.querySelector('.chapter-caption');
        if (!title) {
            title = document.createElement('div');
            title.className = 'chapter-caption';
            item.appendChild(title);
        }
        const customTitle = slideTitle((state.videoScenes || []).find(scene =>
            Number(scene.time_seconds) === Number(image.dataset.time)) || {}, language);
        const text = customTitle || sceneTopicTitle(state.videoChapters || [], Number(image.dataset.time))
            || activePart(parts, Number(image.dataset.time))?.title || 'No chapter title available.';
        // The numbered badge already identifies the slide, so show only the topic beneath it.
        const shown = conciseTitle(text.replace(/^\d+:\s*/, '').replace(/^\d+$/, ''));
        title.title = text;
        if (title.textContent !== shown) title.textContent = shown;
    });
    document.querySelectorAll('.scene-item .scene-label').forEach((label) => {
        const time = Number(label.closest('.scene-item').dataset.time);
        const customTitle = slideTitle((state.videoScenes || []).find(scene => Number(scene.time_seconds) === time) || {}, language);
        const title = customTitle || sceneTopicTitle(state.videoChapters || [], time) || activePart(parts, time)?.title || '';
        const name = title.replace(/^\d+:\s*/, '').replace(/^\d+$/, '');
        const text = `${label.dataset.number}` + (name ? ` - ${name}` : '');
        label.title = name;
        if (label.textContent !== text) label.textContent = text;
    });
}

/**
 * Shows the thumbnails that match the navigation grouping: slides, content chapters, or both.
 * Content chapters reuse the screenshot of the slide visible when the chapter starts.
 */
export function syncTimelineGrouping() {
    const timeline = elements.thumbnailTimeline;
    if (!timeline) return;
    const scenes = state.videoScenes || [];
    const mode = state.chapterGrouping || 'topic';
    const chapters = (state.videoChapters || [])
        .map((chapter) => ({
            start: chapterStart(chapter),
            title: chapter.title || '',
            sections: (Array.isArray(chapter.sections) && chapter.sections.length > 1 ? chapter.sections : [])
                .map((section) => ({ start: chapterStart(section), title: section.title || '' }))
                .filter((section) => Number.isFinite(section.start)),
        }))
        .filter((chapter) => Number.isFinite(chapter.start))
        .sort((a, b) => a.start - b.start);
    const hasSections = chapters.some((chapter) => chapter.sections.length > 0);
    const sectionsToggle = document.getElementById('timelineSectionsToggle');
    const sectionsControl = document.getElementById('timelineSectionsControl');
    if (sectionsControl) sectionsControl.hidden = !hasSections || mode === 'slides';
    const showSections = hasSections && Boolean(sectionsToggle?.checked);
    const slidesControl = document.getElementById('timelineSlidesControl');
    if (slidesControl) slidesControl.hidden = mode !== 'topic' || !chapters.length || !scenes.length;
    const nestSlides = mode === 'topic' && Boolean(document.getElementById('timelineSlidesToggle')?.checked);
    const signature = JSON.stringify([
        mode, scenes.map(scene => [scene.time_seconds,
            slideTitle(scene, contentLanguage(state.currentVideoId, 'slides', state.currentTranslationLanguage))]), showSections, nestSlides,
        chapters.map((c) => [c.start, c.title, c.sections.map((s) => [s.start, s.title])]),
    ]);
    if (timeline.dataset.groupingSignature === signature) return;
    timeline.dataset.groupingSignature = signature;
    timeline.querySelectorAll('.chapter-card').forEach((card) => card.remove());
    const sceneItems = [...timeline.querySelectorAll('.timeline-item:not(.chapter-card)')];
    const showChapters = mode !== 'slides' && chapters.length > 0 && sceneItems.length > 0;
    const hideSlides = mode === 'topic' && showChapters && !nestSlides;
    sceneItems.forEach((item) => {
        item.classList.toggle('grouping-hidden', hideSlides);
        // Slide changes listed beneath their chapter (and section) cards.
        const time = Number(item.querySelector('.timeline-thumbnail')?.dataset.time);
        const chapter = chapters.filter((candidate) => candidate.start <= time + 0.01).at(-1);
        item.classList.toggle('nested-slide', showChapters && nestSlides);
        item.classList.toggle('under-section', showChapters && nestSlides && showSections
            && Boolean(chapter?.sections.some((section) => section.start <= time + 0.01)));
    });
    if (!showChapters) return;
    const sceneTimes = sceneItems.map((item) => Number(item.querySelector('.timeline-thumbnail')?.dataset.time));
    const screenshotAt = (start) => {
        let sourceIndex = 0;
        sceneTimes.forEach((time, i) => { if (time <= start + 0.01) sourceIndex = i; });
        return sceneItems[sourceIndex].querySelector('.timeline-thumbnail')?.src || '';
    };
    const insertByTime = (card, start) => {
        const next = [...timeline.querySelectorAll('.timeline-item')]
            .find((item) => item !== card && Number(item.querySelector('.timeline-thumbnail')?.dataset.time) > start);
        timeline.insertBefore(card, next || null);
    };
    chapters.forEach((chapter, index) => {
        const number = `${index + 1}`;
        if (!(mode === 'combined' && sceneTimes.some((time) => Math.abs(time - chapter.start) < 1))) {
            insertByTime(timelineCard('chapter-card', number, `Chapter ${number}`, chapter, screenshotAt(chapter.start)), chapter.start);
        }
        if (!showSections) return;
        chapter.sections.forEach((section, sectionIndex) => {
            // The chapter card already marks a section that starts with the chapter.
            if (Math.abs(section.start - chapter.start) < 1) return;
            const label = `${number}.${sectionIndex + 1}`;
            insertByTime(timelineCard('chapter-card section-card', label, `Section ${label}`, section, screenshotAt(section.start)), section.start);
        });
    });
}

function timelineCard(className, number, label, part, src) {
    const card = document.createElement('div');
    card.className = `timeline-item ${className}`;
    card.title = part.title;
    const badge = document.createElement('div');
    badge.className = 'detection-badge chapter-badge';
    badge.textContent = number;
    badge.setAttribute('aria-label', label);
    const img = document.createElement('img');
    img.className = 'timeline-thumbnail';
    img.src = src;
    img.alt = `${label}: ${part.title}`;
    img.dataset.time = part.start;
    const timestamp = document.createElement('div');
    timestamp.className = 'timeline-timestamp';
    timestamp.textContent = formatTime(part.start);
    const caption = document.createElement('div');
    caption.className = 'chapter-caption';
    caption.textContent = conciseTitle(part.title);
    card.append(badge, img, timestamp, caption);
    card.onclick = () => { elements.videoPlayer.currentTime = part.start; };
    return card;
}

/**
 * Sets up the video progress bar
 * @param {HTMLVideoElement} videoPlayer - The video player element
 */
export function setupVideoPlayer(videoPlayer) {
    const progressBar = elements.videoProgress;
    const hoverTime = elements.progressHoverTime;

    if (videoPlayer._navigationHandlers) {
        videoPlayer.removeEventListener('timeupdate', videoPlayer._navigationHandlers.timeupdate);
        videoPlayer.removeEventListener('timeupdate', videoPlayer._navigationHandlers.timeline);
        videoPlayer.removeEventListener('timeupdate', videoPlayer._navigationHandlers.transcript);
    }
    if (progressBar._navigationHandlers) {
        progressBar.removeEventListener('mousemove', progressBar._navigationHandlers.mousemove);
        progressBar.removeEventListener('mouseleave', progressBar._navigationHandlers.mouseleave);
        progressBar.removeEventListener('click', progressBar._navigationHandlers.click);
    }

    const navigationHandlers = {
        timeupdate: () => {
            if (!videoPlayer.paused && !videoPlayer.seeking && Number.isFinite(videoPlayer.duration)) {
                const target = skipTarget(outlineRanges(state.videoChapters, videoPlayer.duration),
                    videoPlayer.currentTime, videoPlayer.duration);
                if (target !== null) {
                    if (target >= videoPlayer.duration) videoPlayer.pause();
                    videoPlayer.currentTime = target;
                }
            }
            updateTimeMarker(videoPlayer);
            updateChapterCaptions();
            updateActiveChapter();
        },
        timeline: updateTimelineHighlight,
        transcript: updateActiveTranscript
    };
    videoPlayer._navigationHandlers = navigationHandlers;

    const progressHandlers = {
        mousemove: (e) => {
        const rect = progressBar.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        const time = pos * videoPlayer.duration;
        hoverTime.textContent = formatTime(time);
        hoverTime.style.left = `${pos * 100}%`;
        hoverTime.style.display = 'block';
        },

        mouseleave: () => {
            hoverTime.style.display = 'none';
        },

        click: (e) => {
            const rect = progressBar.getBoundingClientRect();
            const pos = (e.clientX - rect.left) / rect.width;
            videoPlayer.currentTime = pos * videoPlayer.duration;
        }
    };
    progressBar._navigationHandlers = progressHandlers;
    progressBar.addEventListener('mousemove', progressHandlers.mousemove);
    progressBar.addEventListener('mouseleave', progressHandlers.mouseleave);
    progressBar.addEventListener('click', progressHandlers.click);

    // Update time marker on timeupdate
    videoPlayer.addEventListener('timeupdate', navigationHandlers.timeupdate);
    
    // Add timeupdate listener to highlight current thumbnail
    videoPlayer.addEventListener('timeupdate', navigationHandlers.timeline);
    
    // Add listener for transcript updates
    videoPlayer.addEventListener('timeupdate', navigationHandlers.transcript);
    updateChapterCaptions();
}

/**
 * Updates the time marker position
 * @param {HTMLVideoElement} videoPlayer - The video player element
 */
export function updateTimeMarker(videoPlayer) {
    const timeMarker = elements.timeMarker;
    const progress = (videoPlayer.currentTime / videoPlayer.duration) * 100;
    timeMarker.style.left = `${progress}%`;
}

/**
 * Updates the highlighted thumbnail in the timeline
 */
export function updateTimelineHighlight() {
    const videoPlayer = elements.videoPlayer;
    const currentTime = videoPlayer.currentTime;
    // Highlight by time among visible cards, since chapter cards can replace or join slide cards.
    const thumbnails = [...document.querySelectorAll('.timeline-item:not(.grouping-hidden) .timeline-thumbnail')];
    let currentThumbnailIndex = -1;
    thumbnails.forEach((thumbnail, index) => {
        if (currentTime + 0.01 >= Number(thumbnail.dataset.time)) currentThumbnailIndex = index;
    });
    document.querySelectorAll('.timeline-item.grouping-hidden .timeline-thumbnail.active')
        .forEach((thumbnail) => thumbnail.classList.remove('active'));
    
    // Update thumbnail highlighting
    thumbnails.forEach((thumbnail, index) => {
        if (index === currentThumbnailIndex) {
            thumbnail.classList.add('active');
            
            // Scroll the active thumbnail into view if it's not visible
            const timelineContainer = elements.thumbnailTimeline;
            const thumbnailItem = thumbnail.parentElement;
            scrollWithinContainer(timelineContainer, thumbnailItem, 'both');
        } else {
            thumbnail.classList.remove('active');
        }
    });
} 