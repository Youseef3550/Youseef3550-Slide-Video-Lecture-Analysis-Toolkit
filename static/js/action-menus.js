export function rowActions(row, label = 'Actions') {
    let menu = row.querySelector(':scope > .action-menu:not(.download-menu)');
    if (!menu) {
        menu = document.createElement('details');
        menu.className = 'action-menu';
        const summary = document.createElement('summary');
        summary.textContent = /^(Chapter \d+|Part) actions$/.test(label) ? 'Actions' : label;
        summary.setAttribute('aria-label', label);
        const content = document.createElement('div');
        content.className = 'row-actions-content';
        menu.append(summary, content);
        menu.addEventListener('click', event => event.stopPropagation());
        menu.addEventListener('keydown', event => {
            event.stopPropagation();
            if (event.key === 'Escape') { menu.open = false; summary.focus(); }
        });
        row.appendChild(menu);
    }
    return menu.querySelector('.row-actions-content');
}

export function initActionMenus() {
    const groups = [
        ['transcript-controls', 'Transcript actions', [
            'edit-transcript-btn', 'transcriptOptionsBtn', 'openCaptionStyleBtn',
            'downloadTranscriptBtn', 'timestampToggle', 'fuzzySearchToggle',
        ]],
        ['slide-controls', 'Slide actions', [
            'edit-slides-btn', 'refreshSlideTitlesBtn', 'slideTranslationTarget', 'translateSlideTitlesBtn',
            'downloadScreenshotsBtn', 'downloadSlidesPdfBtn', 'downloadSlideTextWordBtn',
        ]],
    ];
    for (const [className, label, ids] of groups) {
        const bar = document.querySelector(`.${className}`);
        if (!bar) continue;
        const content = rowActions(bar, label);
        for (const id of ids) {
            const element = document.getElementById(id);
            if (!element) continue;
            const outerLabel = element.closest('.toggle-container') || element.closest('label');
            const labelElement = bar.querySelector(`label[for="${id}"]`);
            if (labelElement) content.appendChild(labelElement);
            content.appendChild(outerLabel || element);
        }
    }
    initOutsideDismiss();
}

export const POPUP_MENU_SELECTOR = 'details.action-menu, details.extra-options, details.contextual-help, details#navigationGrouping';

export function initOutsideDismiss(root = document) {
    if (root.__popupDismissReady) return;
    root.__popupDismissReady = true;
    // Capture phase so menus still close when a clicked control stops propagation.
    root.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        const target = event.target;
        root.querySelectorAll(POPUP_MENU_SELECTOR).forEach(menu => {
            if (menu.open && !(target instanceof Node && menu.contains(target))) menu.open = false;
        });
    }, true);
    root.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !(event.target instanceof Element)) return;
        let menu = event.target.closest(POPUP_MENU_SELECTOR);
        while (menu && !menu.open) menu = menu.parentElement?.closest(POPUP_MENU_SELECTOR);
        if (!menu) return;
        event.preventDefault();
        event.stopPropagation();
        menu.open = false;
        menu.querySelector(':scope > summary')?.focus();
    }, true);
}
