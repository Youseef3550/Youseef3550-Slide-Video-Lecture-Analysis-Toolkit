const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'clip-arrangement.js'), 'utf8')
    .replace(/^export /gm, ''), context);
const original = [
    {timestamp: '00:00', title: 'First', sections: [
        {timestamp: '00:00', title: 'A'}, {timestamp: '00:10', title: 'B', flagged: true}]},
    {timestamp: '00:20', title: 'Second', sections: [
        {timestamp: '00:20', title: 'C'}, {timestamp: '00:30', title: 'D', skipped: true}]},
];
const order = chapters => JSON.parse(JSON.stringify(context.sectionArrangement(chapters)));
let changed = context.reorderSection(original,
    {chapter: 1, section: 1, target_chapter: 0, target_section: 0});
assert.deepEqual(order(changed), [
    {timestamp: '00:30', chapter: '00:00'}, {timestamp: '00:00', chapter: '00:00'},
    {timestamp: '00:10', chapter: '00:00'}, {timestamp: '00:20', chapter: '00:20'},
]);
assert.equal(changed[1].sections[1].timestamp, '00:30', 'Source boundaries are never retimed');
assert(!original[0].clip_arrangement, 'Draft movement must not mutate the saved source');
changed = context.reorderSection(original,
    {chapter: 1, section: 0, target_chapter: 0, target_section: 1});
assert.equal(order(changed)[1].timestamp, '00:20', 'A Review target authorizes moving an unflagged clip');
const after = context.reorderSection(original,
    {chapter: 0, section: 0, target_chapter: 1, target_section: 1, placement: 'after'});
assert.equal(order(after).at(-1).timestamp, '00:00', 'Clips can move to the end, not just before a target');
const alternate = JSON.parse(JSON.stringify(changed));
alternate[0].sections[0].timestamp = '00:00:00';
assert.equal(order(alternate)[0].timestamp, '00:00:00', 'Equivalent clock formats do not invalidate clip order');
assert.throws(() => context.reorderSection(original,
    {chapter: 1, section: 0, target_chapter: 0, target_section: 0}), /Review or Skip/);
assert.deepEqual(order(context.reorderSection(changed, {action: 'reset_clip_order'})), order(original));
const stale = JSON.parse(JSON.stringify(changed));
stale[0].sections[0].timestamp = '00:01';
assert.throws(() => order(stale), /Reset clip order/);
console.log('PASS: Review/Skip eligibility, cross-chapter ordering, source timing, reset and stale-order protection');
