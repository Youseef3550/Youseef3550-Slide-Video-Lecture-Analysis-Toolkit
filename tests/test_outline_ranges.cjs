const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'outline-ranges.js'), 'utf8')
    .replace(/^export /gm, ''), context);
const chapters = [
    {timestamp: '00:00', title: 'First', sections: [
        {timestamp: '00:00', flagged: true, flag_reason: 'Suggestion'},
        {timestamp: '00:05.125', skipped: true},
        {timestamp: '00:10', skipped: true},
        {timestamp: '00:15'},
    ]},
    {timestamp: '00:20', skipped: true, sections: [{timestamp: '00:25'}]},
];
const ranges = context.outlineRanges(chapters, 30);
assert.equal(context.skipTarget(ranges, 3, 30), null, 'Flagging alone never skips');
assert.equal(context.skipTarget(ranges, 5.125, 30), 15, 'Adjacent skipped intervals form one jump');
assert.equal(context.skipTarget(ranges, 15, 30), null, 'Resume exactly on retained boundary');
assert.equal(context.skipTarget(ranges, 21, 30), 30, 'Chapter skip covers time before its first section');
assert.equal(context.skipTarget(ranges, 29, 30), 30, 'Final skip stops at duration');
assert.equal(ranges[0].reason, 'Suggestion');
console.log('PASS: review flags, inherited coverage, precise boundaries and explicit chained skips');
