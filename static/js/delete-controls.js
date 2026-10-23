export function initDeleteControls() {
    const normalize = button => {
        const label = button.getAttribute('aria-label') || button.title || button.textContent.trim();
        if (!/^(delete|remove|clear all)\b/i.test(label) && !button.querySelector('.fa-trash, .fa-trash-alt')) return;
        if (button.dataset.deleteControl === 'true') return;
        button.dataset.deleteControl = 'true';
        button.classList.add('delete-action', 'btn-icon');
        button.title = label;
        button.setAttribute('aria-label', label);
        const icon = document.createElement('i');
        icon.className = 'fas fa-trash';
        icon.setAttribute('aria-hidden', 'true');
        button.replaceChildren(icon);
    };
    const scan = node => {
        if (node.nodeType !== 1) return;
        if (node.matches('button')) normalize(node);
        node.querySelectorAll('button').forEach(normalize);
    };
    scan(document.body);
    new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') scan(record.target);
            else {
                if (record.target.matches?.('button')) normalize(record.target);
                record.addedNodes.forEach(scan);
            }
        }
    }).observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'title']});
}
