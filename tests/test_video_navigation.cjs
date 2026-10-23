const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'main.js'), 'utf8');
const start = source.indexOf('function navigateChapter(direction)');
const end = source.indexOf('/**', start);
assert(start >= 0 && end > start);
assert(start < source.indexOf('function setupKeyboardControls()'));
const elements = {videoPlayer: {currentTime: 0}};
const contentLanguage = (_, __, language) => language || '';
const state = {videoChapters: [
    {timestamp: '00:00'}, {timestamp: '02:00'}, {timestamp: '01:02:03'},
], videoScenes: []};
eval(fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'chapter-navigation.js'), 'utf8')
    .replace(/^export /gm, ''));
let slideDirection;
let notification;
const navigateToNextSlide = () => {slideDirection = 1;};
const navigateToPreviousSlide = () => {slideDirection = -1;};
const showNotification = (message) => {notification = message;};
eval(source.slice(start, end));
navigateChapter(1);
assert.equal(elements.videoPlayer.currentTime, 120);
navigateChapter(1);
assert.equal(elements.videoPlayer.currentTime, 3723);
navigateChapter(-1);
assert.equal(elements.videoPlayer.currentTime, 120);
navigateChapter(-1);
assert.equal(elements.videoPlayer.currentTime, 0);
navigateChapter(-1);
assert.equal(elements.videoPlayer.currentTime, 0);
state.videoChapters = [];
state.videoScenes = [{time_seconds: 0}, {time_seconds: 20}];
navigateChapter(1);
assert.equal(elements.videoPlayer.currentTime, 20);
navigateChapter(-1);
assert.equal(elements.videoPlayer.currentTime, 0);
state.videoChapters = [{timestamp: '00:10', title: 'Topic'}];
state.chapterGrouping = 'topic';
navigateChapter(1);
assert.equal(elements.videoPlayer.currentTime, 10);
state.chapterGrouping = 'slides';
state.videoScenes[1].title = 'My corrected slide';
assert.equal(navigationParts(state.videoChapters, state.videoScenes, 'slides')[1].title, 'My corrected slide');
navigateChapter(1);
assert.equal(elements.videoPlayer.currentTime, 20);
state.chapterGrouping = 'combined';
navigateChapter(-1);
assert.equal(elements.videoPlayer.currentTime, 10);
state.videoChapters = [];
state.videoScenes = [];
navigateChapter(1);
assert(notification.includes('Generate chapters'));
state.videoChapters = [
    {timestamp: '00:00', title: 'Chapter A', sections: [
        {timestamp: '00:00', title: 'Section A'}, {timestamp: '00:10', title: 'Section B'}]},
    {timestamp: '00:30', title: 'Chapter B', sections: [{timestamp: '00:30', title: 'Section C'}]},
];
state.videoScenes = [{time_seconds: 0}, {time_seconds: 15}, {time_seconds: 30}];
for (let mask = 0; mask < 8; mask++) {
    const kinds = ['chapters', 'sections', 'slides'].filter((_, index) => mask & (1 << index));
    const expected = [...new Set([
        ...(mask & 1 ? [0, 30] : []), ...(mask & 2 ? [0, 10, 30] : []), ...(mask & 4 ? [0, 15, 30] : []),
    ])].sort((a, b) => a - b);
    assert.deepEqual(navigationParts(state.videoChapters, state.videoScenes, kinds).map(part => part.start), expected);
}
state.navigationKinds = ['sections'];
state.chapterGrouping = 'slides';
elements.videoPlayer.currentTime = 0;
navigateChapter(1);
assert.equal(elements.videoPlayer.currentTime, 10, 'Section navigation is independent from export/timeline grouping');
state.navigationKinds = ['chapters', 'sections', 'slides'];
navigateChapter(1);
assert.equal(elements.videoPlayer.currentTime, 15);
navigateChapter(-1);
assert.equal(elements.videoPlayer.currentTime, 10);
state.navigationKinds = [];
navigateChapter(1);
assert.equal(elements.videoPlayer.currentTime, 10, 'No checked types does not seek');
assert(notification.includes('Navigate by'));
console.log('PASS: navigation scope, chapter timestamps, slide fallback and empty-state feedback');
