const precision = 0.001;

export function clipTimestamp(seconds) {
    const milliseconds = Math.floor(seconds * 1000 + 0.000001);
    const total = Math.floor(milliseconds / 1000);
    const stamp = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
        .map(value => String(value).padStart(2, '0')).join(':');
    return stamp + (milliseconds % 1000 ? `.${String(milliseconds % 1000).padStart(3, '0')}` : '');
}

export function clipSeconds(value) {
    if (!/^\d+:\d{2}(?::\d{2})?(?:\.\d{1,3})?$/.test(value.trim())) return NaN;
    const parts = value.trim().split(':').map(Number);
    if (parts.slice(1).some(part => part >= 60)) return NaN;
    return parts.reduce((total, part) => total * 60 + part, 0);
}

export function splitTimestamps(value) {
    const cuts = value.trim().split(/[\s,;]+/).filter(Boolean);
    const seconds = cuts.map(clipSeconds);
    if (!cuts.length || cuts.length > 99 || seconds.some((time, index) =>
        !Number.isFinite(time) || time <= (index ? seconds[index - 1] : 0))) {
        throw new Error('Enter 1-99 increasing cut timestamps in MM:SS or HH:MM:SS, optionally with milliseconds. Do not include 00:00 or video end.');
    }
    return cuts;
}

export function initCustomClipRange(player) {
    const track = document.getElementById('videoProgress');
    const range = document.getElementById('customClipRange');
    const selection = document.getElementById('customClipRangeSelection');
    const status = document.getElementById('customClipStatus');
    const startInput = document.getElementById('customClipStart');
    const endInput = document.getElementById('customClipEnd');
    const markButton = document.getElementById('customClipMarkBtn');
    const markers = {
        start: document.getElementById('customClipStartMarker'),
        end: document.getElementById('customClipEndMarker'),
    };
    let duration = 0;
    let active = false;
    let dragging = null;
    let awaitingEnd = false;
    const resetCapture = () => {
        awaitingEnd = false;
        markButton.textContent = 'Start here';
    };
    const values = () => [clipSeconds(startInput.value), clipSeconds(endInput.value)];
    const valid = (start, end) => Number.isFinite(start) && Number.isFinite(end)
        && start >= 0 && end > start && end <= duration;
    const sync = () => {
        const [start, end] = values();
        const usable = active && valid(start, end);
        range.hidden = !usable;
        if (!usable) return;
        selection.style.left = `${100 * start / duration}%`;
        selection.style.width = `${100 * (end - start) / duration}%`;
        for (const [kind, value] of [['start', start], ['end', end]]) {
            const marker = markers[kind];
            marker.style.left = `${100 * value / duration}%`;
            marker.setAttribute('aria-valuemin', String(kind === 'start' ? 0 : start + precision));
            marker.setAttribute('aria-valuemax', String(kind === 'start' ? end - precision : duration));
            marker.setAttribute('aria-valuenow', String(value));
            marker.setAttribute('aria-valuetext', clipTimestamp(value));
            marker.title = `${kind === 'start' ? 'Clip start' : 'Clip end'}: ${clipTimestamp(value)}. Drag or use arrow keys.`;
        }
    };
    const move = (kind, value) => {
        const [start, end] = values();
        if (!active || !valid(start, end) || !Number.isFinite(value)) return;
        const lower = kind === 'start' ? 0 : start + precision;
        const upper = kind === 'start' ? end - precision : duration;
        if (lower > upper) return;
        const next = Math.max(lower, Math.min(upper, Math.round(value * 1000) / 1000));
        (kind === 'start' ? startInput : endInput).value = clipTimestamp(next);
        status.textContent = '';
        sync();
        player.currentTime = next;
    };
    const stopDrag = () => {
        if (dragging && dragging.marker.hasPointerCapture(dragging.id)) {
            dragging.marker.releasePointerCapture(dragging.id);
        }
        dragging = null;
    };
    markButton.addEventListener('click', () => {
        if (!active) return;
        const time = Math.floor(player.currentTime * 1000) / 1000;
        if (!Number.isFinite(time) || time < 0 || time > duration
            || (!awaitingEnd && time >= duration)
            || (awaitingEnd && (!Number.isFinite(clipSeconds(startInput.value))
                || time <= clipSeconds(startInput.value)))) {
            status.textContent = awaitingEnd
                ? 'Choose an end after the clip start. Keep playing or seek forward, then click End here.'
                : 'Choose a start before the video ends.';
            status.classList.add('outline-error');
            return;
        }
        if (awaitingEnd) {
            endInput.value = clipTimestamp(time);
            resetCapture();
        } else {
            startInput.value = clipTimestamp(time);
            endInput.value = clipTimestamp(duration);
            awaitingEnd = true;
            markButton.textContent = 'End here';
        }
        status.textContent = '';
        status.classList.remove('outline-error');
        sync();
    });
    for (const kind of ['start', 'end']) {
        const marker = markers[kind];
        marker.addEventListener('click', event => event.stopPropagation());
        marker.addEventListener('pointerdown', event => {
            if (event.button !== 0 || !active) return;
            event.preventDefault();
            event.stopPropagation();
            marker.focus();
            marker.setPointerCapture(event.pointerId);
            dragging = {marker, id: event.pointerId};
        });
        marker.addEventListener('pointermove', event => {
            if (!dragging || dragging.marker !== marker || dragging.id !== event.pointerId) return;
            const rect = track.getBoundingClientRect();
            if (rect.width > 0) move(kind, (event.clientX - rect.left) / rect.width * duration);
        });
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            marker.addEventListener(name, stopDrag);
        }
        marker.addEventListener('keydown', event => {
            const delta = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
            const current = clipSeconds((kind === 'start' ? startInput : endInput).value);
            const target = {
                ArrowLeft: current - delta, ArrowDown: current - delta,
                ArrowRight: current + delta, ArrowUp: current + delta,
                Home: 0, End: duration,
            }[event.key];
            if (target === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            move(kind, target);
        });
        (kind === 'start' ? startInput : endInput).addEventListener('input', () => {
            status.textContent = valid(...values()) ? '' : 'Enter a valid start before the end, within the video duration.';
            sync();
        });
        document.getElementById(kind === 'start' ? 'customClipSetStartBtn' : 'customClipSetEndBtn')
            .addEventListener('click', () => move(kind, player.currentTime));
    }
    return {
        open() {
            stopDrag();
            duration = Math.floor(player.duration * 1000) / 1000;
            active = Number.isFinite(duration) && duration >= precision;
            resetCapture();
            markButton.hidden = !active;
            startInput.value = clipTimestamp(Math.min(Math.max(0, player.currentTime), duration - precision));
            endInput.value = clipTimestamp(duration);
            sync();
        },
        close() {
            active = false;
            resetCapture();
            markButton.hidden = true;
            stopDrag();
            sync();
        },
        validate() {
            if (active && valid(...values())) return true;
            status.textContent = 'Enter a valid start before the end, within the video duration.';
            return false;
        },
    };
}
