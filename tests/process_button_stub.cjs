const active = new WeakMap();
function start(button, label, options = {}) {
    if (!button) {
        const finish = () => {};
        finish.update = () => {};
        return finish;
    }
    active.get(button)?.();
    const disabled = button.disabled;
    let settings = {cancellable: false, stopping: false, ...options};
    let finished = false;
    const update = changes => {
        settings = {...settings, ...changes};
        button.disabled = !settings.cancellable || settings.stopping;
    };
    const finish = () => {
        if (finished) return;
        finished = true;
        button.disabled = disabled;
        if (active.get(button) === finish) active.delete(button);
    };
    finish.update = changes => { if (!finished) update(changes); };
    active.set(button, finish);
    update({});
    return finish;
}
start.finish = button => { if (button) active.get(button)?.(); };
module.exports = start;
