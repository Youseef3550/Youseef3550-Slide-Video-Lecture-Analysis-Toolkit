export function placeContextualHelp(disclosure) {
    if (disclosure.parentElement?.classList.contains('help-option')) return;
    const targetId = disclosure.dataset.helpFor;
    let anchor = targetId ? document.getElementById(targetId) : disclosure.previousElementSibling;
    while (!targetId && anchor && (anchor.matches('[role="status"], [aria-live], [hidden], input[type="hidden"]')
        || (!anchor.textContent.trim() && !anchor.matches('input, select, textarea, button')))) {
        anchor = anchor.previousElementSibling;
    }
    if (!anchor || anchor.contains(disclosure)) return;
    if (anchor.matches('input, select, textarea')) anchor = anchor.labels?.[0] || anchor;
    if (anchor.matches('.help-option')) {
        anchor.append(disclosure);
        return;
    }
    if (anchor.matches('details, form, dialog')) {
        anchor = anchor.querySelector(':scope > summary, :scope > .dialog-header h2, :scope > label');
    }
    if (anchor && !anchor.matches('label, button, input, select, textarea, summary, h2, h3, p, span')) {
        const controls = anchor.querySelectorAll('input, select, textarea');
        const control = controls[controls.length - 1];
        anchor = control?.labels?.[0] || control || anchor;
    }
    if (!anchor) return;
    const row = document.createElement('div');
    row.className = 'help-option';
    anchor.before(row);
    row.append(anchor, disclosure);
}

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
        if (text.dataset.helpFor) disclosure.dataset.helpFor = text.dataset.helpFor;
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
        if (!disclosure.querySelector(':scope > .help-content')) {
            const content = document.createElement('div');
            content.className = 'help-content';
            const children = [...disclosure.children].filter(child => child.tagName !== 'SUMMARY');
            content.append(...children);
            disclosure.append(content);
        }
        placeContextualHelp(disclosure);
        const summary = disclosure.querySelector('summary');
        if (['Help', 'Help for these options'].includes(summary.getAttribute('aria-label'))) {
            const anchor = disclosure.previousElementSibling;
            const option = anchor?.getAttribute('aria-label') || anchor?.textContent.trim();
            if (option) {
                summary.setAttribute('aria-label', `Help for ${option.slice(0, 100)}`);
                summary.title = summary.getAttribute('aria-label');
            }
        }
        if (disclosure.dataset.helpKeyboard === 'true') continue;
        disclosure.dataset.helpKeyboard = 'true';
        disclosure.addEventListener('toggle', () => {
            if (!disclosure.open) return;
            const content = disclosure.querySelector(':scope > .help-content');
            const row = disclosure.parentElement.getBoundingClientRect();
            const left = Math.max(8, Math.min(row.left, document.documentElement.clientWidth - content.offsetWidth - 8));
            content.style.insetInlineStart = `${left - row.left}px`;
        });
        disclosure.addEventListener('keydown', event => {
            if (event.key === 'Escape' && disclosure.open) {
                event.stopPropagation();
                disclosure.open = false;
                disclosure.querySelector('summary').focus();
            }
        });
    }
    if (root === document && !document.contextualHelpObserver && typeof MutationObserver !== 'undefined') {
        document.contextualHelpObserver = new MutationObserver(records => {
            if (records.some(record => [...record.addedNodes].some(node =>
                node.nodeType === 1 && (node.matches('details.contextual-help, small')
                    || node.querySelector('details.contextual-help, small'))))) {
                initContextualHelp();
            }
        });
        document.contextualHelpObserver.observe(document.body, { childList: true, subtree: true });
    }
}
