export function initContextualHelp(root = document) {
    for (const summary of root.querySelectorAll('details.ui-disclosure > summary, details.contextual-help > summary')) {
        if (summary.parentElement.classList.contains('contextual-help')
            || /help|^slide limits$|detail levels/i.test(summary.textContent)) {
            const label = summary.getAttribute('aria-label')
                || summary.textContent.replace(/^\?\s*/, '').trim() || 'Help';
            summary.parentElement.classList.add('contextual-help');
            summary.setAttribute('aria-label', label);
            summary.title = label;
            summary.textContent = '?';
        }
    }
    const candidates = root.querySelectorAll(
        'small:not([role]):not([aria-live]), .speaker-timeline-help, '
        + '#libraryDialog p:not([id]), #customClipForm > p:not([id])'
    );
    for (const text of candidates) {
        if (text.closest('details.ui-disclosure, details.contextual-help, [role="status"], [role="alert"]')
            || text.matches('.progress-elapsed, #translationModelStatus, #speakerDiarizationTokenStatus')) continue;
        const disclosure = document.createElement('details');
        disclosure.className = 'contextual-help';
        const summary = document.createElement('summary');
        summary.textContent = '?';
        const label = text.closest('label')?.textContent.trim()
            || text.previousElementSibling?.labels?.[0]?.textContent.trim()
            || 'these options';
        summary.setAttribute('aria-label', `Help for ${label.slice(0, 100)}`);
        summary.title = 'Show help';
        const outerLabel = text.closest('label');
        if (outerLabel) outerLabel.after(disclosure);
        else text.before(disclosure);
        disclosure.append(summary, text);
    }
    for (const disclosure of root.querySelectorAll('details.contextual-help')) {
        if (disclosure.dataset.helpKeyboard === 'true') continue;
        disclosure.dataset.helpKeyboard = 'true';
        disclosure.addEventListener('keydown', event => {
            if (event.key === 'Escape' && disclosure.open) {
                event.stopPropagation();
                disclosure.open = false;
                disclosure.querySelector('summary').focus();
            }
        });
    }
}
