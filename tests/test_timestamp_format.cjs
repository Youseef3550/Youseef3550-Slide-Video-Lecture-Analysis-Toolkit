const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'utils.js'), 'utf8')
    .replace(/^export /gm, ''), context);
for (const [seconds, expected] of [[0, '00:00'], [59, '00:59'], [3599, '59:59'],
    [3600, '1:00:00'], [3723, '1:02:03'], [7200, '2:00:00'], [36000, '10:00:00']]) {
    assert.equal(context.formatTime(seconds), expected);
}
for (const [stamp, expected] of [['62:03', '1:02:03'], ['01:02:03', '1:02:03'],
    ['120:00.125', '2:00:00.125'], ['59:59.999', '59:59.999'],
    ['60:00.000', '1:00:00.000'], ['00:00:05.050', '00:05.050']]) {
    assert.equal(context.formatTimestamp(stamp), expected);
    const seconds = value => value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
    assert.equal(seconds(stamp), seconds(expected), 'Formatting cannot change a cut boundary');
}
console.log('PASS: player-style hour display, minute overflow normalization and exact fractional boundaries');
