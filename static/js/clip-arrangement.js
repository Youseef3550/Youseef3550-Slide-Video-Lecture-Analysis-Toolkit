export function sectionArrangement(chapters) {
    const key = value => String(value).split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
    const natural = chapters.flatMap(chapter => (chapter.sections || [])
        .map(part => ({timestamp: part.timestamp, chapter: chapter.timestamp})));
    const saved = chapters[0]?.clip_arrangement;
    if (saved == null) return natural;
    const starts = new Map(chapters.map(chapter => [key(chapter.timestamp), chapter.timestamp]));
    const stamps = new Map(natural.map(item => [key(item.timestamp), item.timestamp]));
    if (!Array.isArray(saved) || saved.length !== natural.length ||
            saved.some(item => !item || !starts.has(key(item.chapter)) || typeof item.timestamp !== 'string') ||
            JSON.stringify(saved.map(item => key(item.timestamp)).sort((a, b) => a - b)) !==
                JSON.stringify([...stamps.keys()].sort((a, b) => a - b))) {
        throw new Error('Clip arrangement no longer matches the outline. Reset clip order in Reorganize chapters before continuing.');
    }
    const normalized = saved.map(item => ({timestamp: stamps.get(key(item.timestamp)), chapter: starts.get(key(item.chapter))}));
    return chapters.flatMap(chapter => normalized.filter(item => item.chapter === chapter.timestamp));
}

export function reorderSection(chapters, op) {
    const result = JSON.parse(JSON.stringify(chapters));
    if (op.action === 'reset_clip_order') {
        result.forEach(chapter => { delete chapter.clip_arrangement; });
        return result;
    }
    const sourceChapter = result[op.chapter], targetChapter = result[op.target_chapter];
    const source = sourceChapter?.sections?.[op.section], target = targetChapter?.sections?.[op.target_section];
    if (!source || !target || source === target) throw new Error('Choose different source and target sections.');
    const placement = op.placement || 'before';
    if (!['before', 'after'].includes(placement)) throw new Error('Place the clip before or after its target.');
    if (![source, target, sourceChapter, targetChapter].some(item => item.flagged || item.skipped)) {
        throw new Error('Reordering requires Review or Skip on the moved section or its target.');
    }
    const order = sectionArrangement(result);
    const moving = order.find(item => item.timestamp === source.timestamp);
    const destination = order.find(item => item.timestamp === target.timestamp);
    order.splice(order.indexOf(moving), 1);
    moving.chapter = destination.chapter;
    order.splice(order.indexOf(destination) + Number(placement === 'after'), 0, moving);
    result[0].clip_arrangement = order;
    return result;
}

export function arrangeSectionRows(container, chapters) {
    if (!chapters[0]?.clip_arrangement) return;
    const order = sectionArrangement(chapters);
    const lists = [...container.querySelectorAll(':scope > .chapter-sections')];
    const rows = new Map();
    lists.forEach(list => list.querySelectorAll(':scope > .chapter-section').forEach(row => {
        rows.set(row.dataset.sourceTimestamp, row);
    }));
    for (const [index, chapter] of chapters.entries()) {
        const list = lists.find(item => item.dataset.chapterIndex === String(index));
        if (!list) continue;
        list.querySelectorAll(':scope > .outline-insert').forEach(item => item.remove());
        for (const item of order.filter(item => item.chapter === chapter.timestamp)) {
            const row = rows.get(item.timestamp);
            if (row) list.appendChild(row);
        }
    }
}
