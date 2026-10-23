const timers = new WeakMap();
const processButtons = new WeakMap();

export function finishProcessButton(button) {
    if (button) processButtons.get(button)?.();
}

export function startProcessButton(button, label, {cancellable = false, elapsedSeconds = 0} = {}) {
    if (!button) {
        const finish = () => {};
        finish.update = () => {};
        return finish;
    }
    processButtons.get(button)?.();
    const original = {html: button.innerHTML, disabled: button.disabled,
        title: button.getAttribute('title'), label: button.getAttribute('aria-label')};
    button.innerHTML = '<i aria-hidden="true"></i>';
    const icon = button.querySelector('i');
    const text = document.createElement('span');
    button.appendChild(text);
    button.classList.add('process-running');
    button.setAttribute('aria-busy', 'true');
    let options = {label, cancellable, stopping: false, percent: null};
    const update = changes => {
        options = {...options, ...changes};
        icon.className = options.cancellable && !options.stopping ? 'fas fa-stop' : 'fas fa-spinner fa-spin';
        const percent = typeof options.percent === 'number' && Number.isFinite(options.percent)
            ? ` ${Math.round(Math.max(0, Math.min(100, options.percent)))}%` : '';
        text.textContent = `${options.stopping ? 'Stopping...' : options.label}${percent}`;
        const title = options.stopping ? 'Stopping...' : options.cancellable
            ? `Stop ${options.label.toLowerCase()}` : options.label;
        button.title = title;
        button.setAttribute('aria-label', title);
        button.disabled = !options.cancellable || options.stopping;
    };
    update({});
    const stopElapsed = startElapsedTimer(button, elapsedSeconds);
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        stopElapsed();
        button.innerHTML = original.html;
        button.disabled = original.disabled;
        for (const [name, value] of [['title', original.title], ['aria-label', original.label]]) {
            if (value === null) button.removeAttribute(name);
            else button.setAttribute(name, value);
        }
        button.removeAttribute('aria-busy');
        button.classList.remove('process-running');
        if (processButtons.get(button) === finish) processButtons.delete(button);
    };
    finish.update = changes => { if (!finished) update(changes); };
    processButtons.set(button, finish);
    return finish;
}

export function formatElapsedTime(seconds) {
    const total = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
}

export function startElapsedTimer(container, elapsedSeconds = 0, running = true) {
    if (!container) return () => {};
    timers.get(container)?.();
    const label = document.createElement('small');
    label.className = running ? 'progress-elapsed is-running' : 'progress-elapsed';
    container.appendChild(label);
    const elapsed = Number.isFinite(Number(elapsedSeconds)) ? Math.max(0, Number(elapsedSeconds)) : 0;
    const startedAt = Date.now() - elapsed * 1000;
    const update = () => {
        label.textContent = `${formatElapsedTime((Date.now() - startedAt) / 1000)} elapsed`;
    };
    update();
    let interval;
    const stop = () => {
        clearInterval(interval);
        label.remove();
        if (timers.get(container) === stop) timers.delete(container);
    };
    timers.set(container, stop);
    if (running) {
        interval = setInterval(() => {
            if (!container.isConnected || !container.contains(label)) {
                stop();
                return;
            }
            update();
        }, 1000);
    }
    return stop;
}
