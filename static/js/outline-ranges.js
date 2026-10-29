const seconds = stamp => String(stamp).split(':').reduce((sum, part) => sum * 60 + Number(part), 0);

export function outlineRanges(chapters, duration = Infinity) {
    return (chapters || []).flatMap((chapter, index) => {
        const end = index + 1 < chapters.length ? seconds(chapters[index + 1].timestamp) : duration;
        const saved = chapter.sections?.length ? chapter.sections : [chapter];
        const sections = seconds(saved[0].timestamp) > seconds(chapter.timestamp) ? [chapter, ...saved] : saved;
        return sections.map((section, part) => ({
            start: seconds(section.timestamp),
            end: part + 1 < sections.length ? seconds(sections[part + 1].timestamp) : end,
            flagged: Boolean(chapter.flagged || section.flagged),
            skipped: Boolean(chapter.skipped || section.skipped),
            reason: section.flag_reason || chapter.flag_reason || '',
        }));
    });
}

export function skipTarget(ranges, time, duration) {
    let target = time;
    for (const range of ranges) {
        if (range.skipped && target >= range.start && target < range.end) target = range.end;
    }
    return target > time ? Math.min(target, duration) : null;
}
