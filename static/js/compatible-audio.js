import { state } from './main.js';
import { selectedMediaExportId } from './caption-export.js';
import { startElapsedTimer } from './progress-time.js';

export function initCompatibleAudio() {
    const video = document.getElementById('videoPlayer');
    const mode = document.getElementById('compatibleAudioMode');
    const volume = document.getElementById('compatibleAudioVolume');
    const controls = document.getElementById('compatibleAudioControls');
    const status = document.getElementById('compatibleAudioStatus');
    controls.hidden = true;
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    let generation = 0;
    let enabled = false;
    let preparing = false;
    let savedMuted = false;
    let source = '';
    let starting = false;
    let buffering = false;
    let internalPause = false;
    let resumeWhenVisible = false;
    let backgroundPaused = false;
    let checkedSource = '';
    let checkGeneration = 0;
    let hasNativeAudio = false;
    let nativeStart = null;
    let preparationStarted = 0;
    let stopElapsed = () => {};
    const preferenceKey = () => `lectureseek-compatible-audio:${video.getAttribute('src') || ''}`;
    const remember = value => {
        try { localStorage.setItem(preferenceKey(), value ? 'on' : 'off'); }
        catch (error) { message(`Audio preference could not be saved: ${error.message}`, true); }
    };
    document.body.append(audio);
    const message = (text, error = false) => {
        stopElapsed();
        status.textContent = text;
        status.hidden = !text;
        status.classList.toggle('outline-error', error);
        if (preparing && text && !error) {
            const progress = document.createElement('progress');
            progress.setAttribute('aria-label', 'Preparing compatible audio');
            status.appendChild(progress);
            stopElapsed = startElapsedTimer(status, (Date.now() - preparationStarted) / 1000);
        }
    };
    function disable() {
        ++generation;
        const restore = enabled;
        enabled = preparing = buffering = false;
        internalPause = false;
        resumeWhenVisible = backgroundPaused = false;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        if (restore) video.muted = savedMuted;
        controls.hidden = true;
    }
    const sync = (force = false) => {
        if (!enabled || audio.readyState < 1) return;
        if (force || Math.abs(audio.currentTime - video.currentTime) > 0.2) {
            audio.currentTime = video.currentTime;
        }
        audio.playbackRate = video.playbackRate;
        audio.volume = video.volume;
    };
    async function play() {
        if (!enabled || video.paused || video.seeking || starting) return;
        sync();
        const request = generation;
        starting = true;
        try {
            await audio.play();
            if (request !== generation || video.paused) audio.pause();
        } catch (error) {
            if (request === generation && !video.seeking && !video.paused) {
                video.pause();
                message(`Compatible audio could not play: ${error.message}. Press Play to retry.`, true);
            }
        } finally { starting = false; }
    }
    async function resumeVideo() {
        const request = generation;
        if (document.hidden) {
            resumeWhenVisible = backgroundPaused = true;
            message('Playback paused while the video is in the background.');
            return;
        }
        resumeWhenVisible = false;
        try { await video.play(); }
        catch (error) {
            if (request !== generation) return;
            if (error.name === 'AbortError' && /background media|save power/i.test(error.message)) {
                backgroundPaused = true;
                resumeWhenVisible = document.hidden;
                message('Playback paused by the browser to save power. Press Play to continue.');
            } else {
                message(`Playback could not resume: ${error.message}. Press Play.`, true);
            }
        }
    }
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && resumeWhenVisible && enabled) void resumeVideo();
    });
    video.addEventListener('play', () => {
        if (backgroundPaused) { backgroundPaused = resumeWhenVisible = false; message(''); }
        if (!buffering) void play();
    });
    video.addEventListener('playing', () => { if (!buffering) void play(); });
    video.addEventListener('pause', () => {
        audio.pause();
        if (!internalPause) buffering = false;
        internalPause = false;
    });
    video.addEventListener('waiting', () => audio.pause());
    video.addEventListener('ended', () => { buffering = false; audio.pause(); });
    video.addEventListener('seeking', () => { audio.pause(); sync(true); });
    video.addEventListener('seeked', () => { sync(true); void play(); });
    video.addEventListener('ratechange', () => sync());
    video.addEventListener('timeupdate', () => {
        sync();
        if (mode.value !== 'auto' || enabled || preparing || !hasNativeAudio || video.paused
            || video.seeking || video.muted || video.volume === 0) { nativeStart = null; return; }
        if (typeof video.webkitAudioDecodedByteCount !== 'number' || video.webkitAudioDecodedByteCount > 0) return;
        if (nativeStart === null || video.currentTime < nativeStart) nativeStart = video.currentTime;
        if (video.currentTime - nativeStart >= 3) { nativeStart = null; void enable(); }
    });
    video.addEventListener('volumechange', () => {
        if (!enabled) return;
        audio.volume = video.volume;
        volume.value = String(video.volume);
        if (!video.muted) video.muted = true;
    });
    volume.addEventListener('input', () => {
        video.volume = Number(volume.value);
        audio.volume = video.volume;
    });
    audio.addEventListener('waiting', () => {
        if (!enabled || video.paused) return;
        buffering = true;
        internalPause = true;
        video.pause();
        message('Buffering compatible audio...');
    });
    audio.addEventListener('canplay', async () => {
        if (!enabled || !buffering) return;
        buffering = false;
        message('');
        await resumeVideo();
    });
    audio.addEventListener('error', () => {
        if (!enabled) return;
        video.pause();
        const detail = audio.error?.message || 'Unknown audio playback error';
        disable();
        message(`Compatible audio failed: ${detail}`, true);
    });
    for (const name of ['emptied', 'loadstart']) video.addEventListener(name, () => {
        checkedSource = '';
        ++checkGeneration;
        hasNativeAudio = false;
        nativeStart = null;
        if ((enabled || preparing) && video.getAttribute('src') !== source) {
            disable();
            message('');
        }
    });
    document.addEventListener('videoSelectionChanged', () => {
        checkedSource = '';
        ++checkGeneration;
        hasNativeAudio = false;
        if (enabled || preparing) { disable(); message(''); }
    });
    const restore = async () => {
        if (enabled || preparing || !state.currentVideoId || !video.currentSrc) return;
        try {
            if (mode.value === 'compatible' || mode.value === 'auto' && localStorage.getItem(preferenceKey()) === 'on') {
                await enable();
                return;
            }
            if (mode.value !== 'auto' || checkedSource === video.getAttribute('src')) return;
            const currentSource = video.getAttribute('src');
            const videoId = state.currentVideoId;
            const request = ++checkGeneration;
            const result = await read(await fetch(`/audio_info/${encodeURIComponent(videoId)}`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({media_export_id: selectedMediaExportId(videoId)}),
            }));
            if (request !== checkGeneration || mode.value !== 'auto' || currentSource !== video.getAttribute('src')) return;
            checkedSource = currentSource;
            hasNativeAudio = result.has_audio;
            const types = {aac: 'audio/mp4; codecs="mp4a.40.2"', opus: 'audio/webm; codecs="opus"',
                vorbis: 'audio/ogg; codecs="vorbis"', mp3: 'audio/mpeg', flac: 'audio/flac'};
            const type = types[result.stream?.codec_name];
            if (hasNativeAudio && type && !video.canPlayType(type)) await enable();
        } catch (error) { message(`Could not check playback audio: ${error.message}`, true); }
    };
    video.addEventListener('loadedmetadata', restore);
    document.addEventListener('transcriptUpdated', restore);
    const read = async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || `Audio preparation failed (${response.status}).`);
        return data;
    };
    async function enable() {
        if (enabled || preparing) return;
        if (!state.currentVideoId || !video.currentSrc) { message('Load a video first.', true); return; }
        source = video.getAttribute('src');
        const videoId = state.currentVideoId;
        const request = ++generation;
        preparing = true;
        preparationStarted = Date.now();
        remember(true);
        const resumePlayback = !video.paused;
        video.pause();
        message('Preparing compatible audio...');
        try {
            const job = await read(await fetch(`/compatible_audio/${encodeURIComponent(videoId)}`, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({media_export_id: selectedMediaExportId(videoId)}),
            }));
            let result;
            while (request === generation) {
                result = await read(await fetch(`/chapter_video_jobs/${encodeURIComponent(job.job_id)}`));
                if (result.status === 'error' || result.status === 'cancelled') {
                    throw new Error(result.error || 'Audio preparation cancelled.');
                }
                if (result.status === 'complete') break;
                message(result.steps?.at(-1)?.message || 'Preparing compatible audio...');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            if (request !== generation || state.currentVideoId !== videoId || video.getAttribute('src') !== source) return;
            savedMuted = video.muted;
            enabled = true;
            preparing = false;
            video.muted = true;
            controls.hidden = false;
            volume.value = String(video.volume);
            audio.volume = video.volume;
            audio.playbackRate = video.playbackRate;
            audio.src = result.download_url;
            audio.addEventListener('loadedmetadata', async () => {
                if (enabled && request === generation) {
                    sync(true);
                    if (resumePlayback) {
                        await resumeVideo();
                    } else void play();
                }
            }, {once: true});
            audio.load();
            message('');
        } catch (error) {
            if (request === generation) { disable(); message(error.message, true); }
        }
    }
    try { mode.value = localStorage.getItem('lectureseek-audio-mode') || 'auto'; }
    catch (error) { message(`Audio mode could not be read: ${error.message}`, true); }
    mode.addEventListener('change', async () => {
        ++checkGeneration;
        try { localStorage.setItem('lectureseek-audio-mode', mode.value); }
        catch (error) { message(`Audio mode could not be saved: ${error.message}`, true); }
        if (mode.value !== 'compatible') { disable(); message(''); }
        if (mode.value === 'native') remember(false);
        checkedSource = '';
        await restore();
    });
    void restore();
}
