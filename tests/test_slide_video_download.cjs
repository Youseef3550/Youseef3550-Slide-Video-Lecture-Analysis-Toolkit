const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'chapter-projects.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const calls = [], errors = [];
const context = vm.createContext({
    state:{currentVideoId:'video'}, clipTimestamp: value => String(value),
    selectedMediaExportId:()=> 'caption-copy', selectedCaptionTrackIndex:()=>2,
    showError: message=>errors.push(message),
    document:{createElement:()=>({
        listeners:{},setAttribute(){},addEventListener(name,fn){this.listeners[name]=fn;},
        parentElement:{appendChild(){}},
    })},
    capture:(url,payload)=>calls.push({url,payload}),
});
vm.runInContext(source + '\ndownloadVideoClip = async (url,payload) => capture(url,payload);', context);
(async()=>{
    const slides=[{time_seconds:10.125},{time_seconds:65.875}];
    const player={duration:100.5};
    const first=context.createSlideVideoDownloadButton(slides[0],0,slides,player);
    await first.listeners.click({stopPropagation(){}});
    assert.equal(calls[0].url,'/custom_video/video');
    assert.equal(calls[0].payload.start,'10.125');
    assert.equal(calls[0].payload.end,'65.875');
    assert.equal(calls[0].payload.media_export_id,'caption-copy');
    assert.equal(calls[0].payload.caption_track_index,2);
    const last=context.createSlideVideoDownloadButton(slides[1],1,slides,player);
    await last.listeners.click({stopPropagation(){}});
    assert.equal(calls[1].payload.end,'100.5');
    player.duration=NaN;
    await last.listeners.click({stopPropagation(){}});
    assert.equal(calls.length,2);
    assert(errors.length);
    context.state.currentVideoId='other';
    await first.listeners.click({stopPropagation(){}});
    assert.equal(calls.length,2);
    assert.match(errors.at(-1),/Video changed/);
    console.log('PASS: exact slide video range, fractional boundaries, final tail, selected source/captions and stale-video guard');
})().catch(error=>{console.error(error);process.exitCode=1;});
