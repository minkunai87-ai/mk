const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-manual-import-'));
const fixture = Array.from({length:200}, (_, i) => `fixture\tfixture question ${i}\tanswer ${i}`).join('\n');
const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if(name === '/decks-manifest.json') return res.end(JSON.stringify({schemaVersion:1,version:'test',files:['fixture.txt']}));
    if(name === '/fixture.txt') return res.end(fixture);
    const file = path.join(root, name === '/' ? 'index.html' : decodeURIComponent(name).slice(1));
    if(!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8');
    fs.createReadStream(file).pipe(res);
});

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = 9700 + Math.floor(Math.random()*200);
    const launch = () => spawn(process.env.MK_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'about:blank'], {stdio:'ignore',windowsHide:true});
    let edge = launch();
    let socket;
    try {
        let target;
        for(let i=0;i<100&&!target;i++) {
            try { target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x=>x.type==='page'); } catch {}
            if(!target) await pause(100);
        }
        assert(target);
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
        let sequence=0, accept=false, fail=false, payload=null, index={}, navigations=0;
        const requests=[], pending=new Map();
        const send=(method,params={})=>new Promise((resolve,reject)=>{
            const id=++sequence;
            const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timeout'));},60000);
            pending.set(id,message=>{clearTimeout(timer);resolve(message);});
            socket.send(JSON.stringify({id,method,params}));
        });
        const post=(method,params)=>socket.send(JSON.stringify({id:++sequence,method,params}));
        const handleMessage=event=>{
            const m=JSON.parse(event.data);
            if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
            if(m.method==='Page.frameNavigated'&&!m.params.frame.parentId)navigations++;
            if(m.method==='Page.javascriptDialogOpening')post('Page.handleJavaScriptDialog',{accept});
            if(m.method!=='Fetch.requestPaused')return;
            const r=m.params.request;
            requests.push({method:r.method,url:r.url});
            const data=r.url.includes('/backupIndex.json')?index:payload;
            post('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:fail?503:200,
                responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'*'},
                    {name:'Access-Control-Allow-Methods',value:'GET,PUT,PATCH,OPTIONS'}, {name:'Access-Control-Allow-Headers',value:'content-type'}],
                body:Buffer.from(JSON.stringify(r.method==='GET'?data:{})).toString('base64')});
        };
        socket.onmessage=handleMessage;
        const evaluate=async expression=>{
            const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
            if(r.result?.exceptionDetails)throw new Error(r.result.exceptionDetails.exception?.description||JSON.stringify(r.result.exceptionDetails));
            return r.result.result.value;
        };
        await send('Page.enable');await send('Runtime.enable');
        await send('Fetch.enable',{patterns:[{urlPattern:'*firebaseio.com/*'}]});
        const origin=process.env.MK_LIVE_URL || `http://127.0.0.1:${server.address().port}`;
        await send('Page.navigate',{url:origin+'/index.html'});
        const ready=async()=>{
            for(let i=0;i<2400;i++){
                try{if(await evaluate(`typeof startupRestoreCompleted !== 'undefined' && startupRestoreCompleted && learningStatsReady`))return;}catch{}
                await pause(50);
            }throw new Error('startup not ready');
        };
        await ready();await pause(200);
        assert.equal(requests.length,0,'empty startup must be cloud-free');
        assert.equal(await evaluate(`document.getElementById('empty-local-study-notice').hidden`),false);
        if(process.env.MK_LIVE_URL) {
            const live=await evaluate(`({version:APP_VERSION,firstCard:!!getCurrentCardId(),decks:Object.keys(library).length,manualButton:!!document.getElementById('firebase-latest-import-btn'),initCount:filterResetInitAppCount})`);
            assert.equal(live.version,'v18.5.202 - Firebase 수동 가져오기');assert(live.firstCard && live.manualButton);assert.equal(live.initCount,1);
            console.log(JSON.stringify({live,startupFirebaseRequests:requests.length,actualFirebaseWrites:0},null,2));return;
        }
        await evaluate(`(async()=>{
            const stats={};for(let i=0;i<10000;i++)stats['seed-'+i]={total:1,correct:1,lastDate:1,dueDate:1,updatedAt:1};
            originalDeck.forEach(c=>stats[c.id]={total:1,correct:1,lastDate:1,dueDate:1,updatedAt:1,mem:true});
            setCanonicalStatsStore(stats,'test-seed');await statsPersistenceQueue;
            localStorage.setItem(STORAGE_KEY_LAST_GOOD_STATS_COUNT,String(Object.keys(stats).length));
            setFilterMode('mem');document.getElementById('search-input').value='fixture';applyFilterAndSort(false);persistCurrentViewState(false);
        })()`);
        const state=()=>evaluate(`({card:getCurrentCardId(),filter:JSON.stringify(getFilterStateForStorage()),search:getCurrentFilterSearchQuery(),deck:currentDeckName,sort:currentSortMode,init:filterResetInitAppCount})`);
        const saved=await state();
        const closed = new Promise(resolve => edge.once('exit',resolve));
        await send('Browser.close');await closed;await pause(300);
        edge=launch();target=null;
        for(let i=0;i<100&&!target;i++){
            try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x=>x.type==='page');}catch{}
            if(!target)await pause(100);
        }
        assert(target,'browser restart target');
        socket=new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});socket.onmessage=handleMessage;
        await send('Page.enable');await send('Runtime.enable');await send('Fetch.enable',{patterns:[{urlPattern:'*firebaseio.com/*'}]});
        await send('Page.navigate',{url:origin+'/index.html'});await ready();await pause(300);
        const after=await state();assert.deepEqual(after,saved);assert.equal(requests.length,0);
        const navBefore=navigations;
        const reviews=await evaluate(`(async()=>{
            const total=()=>Object.values(getStatsStore()).reduce((s,x)=>s+(Number(x.total)||0),0);
            const before=total();for(let i=0;i<100;i++){revealAnswer();await grade(2);}
            await statsPersistenceQueue;await learningStatsPersistenceQueue;
            return {delta:total()-before,filter:JSON.stringify(getFilterStateForStorage()),init:filterResetInitAppCount};
        })()`);
        assert.equal(reviews.delta,100);assert.equal(reviews.filter,saved.filter);assert.equal(reviews.init,1);assert.equal(navigations,navBefore);
        assert.equal(requests.filter(r=>r.method==='GET').length,0);
        const uploadResult=await evaluate(`(async()=>{isDataChanged=true;const before={inFlight:isBackupInFlight,manual:firebaseManualImportInProgress,count:getLocalStatsKeyCount(),good:localStorage.getItem(STORAGE_KEY_LAST_GOOD_STATS_COUNT),state:learningStatsRestoreState};const result=await flushBackupToFirebase(true);return {before,result};})()`);
        if(!requests.some(r=>r.method==='PUT'))console.log('UPLOAD_RESULT',uploadResult);
        assert(requests.some(r=>r.method==='PUT'&&r.url.includes('/backups/')),'automatic snapshot upload retained');
        assert.equal(requests.filter(r=>r.method==='GET').length,0);
        fail=true;requests.length=0;
        await send('Page.reload',{ignoreCache:true});await pause(150);await ready();await pause(300);
        assert.equal(requests.length,0);assert.equal((await state()).filter,saved.filter);
        const persisted=await evaluate(`Object.values(getStatsStore()).reduce((s,x)=>s+(Number(x.total)||0),0)`);
        assert.equal(persisted,10300);
        fail=false;
        payload=await evaluate(`(()=>{
            const stats=JSON.parse(JSON.stringify(getStatsStore()));stats['seed-0'].total=55;
            const learning=getLearningStatsBackupPayload();
            const p={appId:'mk',timestamp:Date.now(),stats:JSON.stringify(stats),reviewHistory:localStorage.getItem(STORAGE_KEY_REVIEW_HISTORY),
                [LEARNING_STATS_STORAGE_KEY]:learning,[LEARNING_STATS_FAVORITE_DECKS_STORAGE_KEY]:[],learningStatsPresent:true,favoritesPresent:true,
                viewState:getCurrentViewState(true),filter:localStorage.getItem(STORAGE_KEY_FILTER_STATE)};
            return {payload:p,count:Object.keys(stats).length,entries:getLearningStatsEntryCount(learning),days:Object.keys(learning.days).length};
        })()`);
        index={[payload.payload.timestamp]:{appId:'mk',statsKeyCount:payload.count,learningStatsEntryCount:payload.entries,learningStatsDayCount:payload.days}};
        payload=payload.payload;
        const beforeCancel=await evaluate(`JSON.stringify(getStatsStore())`);
        requests.length=0;accept=false;
        assert.equal(await evaluate(`requestLatestFirebaseImport()`),false);
        assert.equal(await evaluate(`JSON.stringify(getStatsStore())`),beforeCancel);
        assert.equal(requests.filter(r=>r.method==='GET').length,2);
        requests.length=0;accept=true;
        assert.equal(await evaluate(`requestLatestFirebaseImport()`),true);
        assert.equal(requests.filter(r=>r.method==='GET').length,2);
        assert.equal(requests.filter(r=>r.url.includes('/backups/')).length,1);
        assert.equal(await evaluate(`getStatsStore()['seed-0'].total`),55);
        assert.equal(await evaluate(`learningStatsReady`),true);
        assert.equal(await evaluate(`document.getElementById('toast').textContent.includes('Firebase 최신 백업을 불러왔습니다')`),true);
        const validStats=payload.stats;payload.stats='{}';requests.length=0;
        assert.equal(await evaluate(`requestLatestFirebaseImport()`),false);
        assert.equal(await evaluate(`getStatsStore()['seed-0'].total`),55);
        payload.stats=validStats;
        console.log(JSON.stringify({normalRestart:'passed',startupFirebaseRequests:0,emptyLocal:'manual restore shown; automatic GET 0',reviews:100,filterReset:0,reloadDuringReview:0,offlineStartup:'passed',automaticUpload:'PUT only',manualImport:'index GET 1 + payload GET 1; confirmed apply',cancel:'unchanged',invalidPayload:'blocked',actualFirebaseWrites:0},null,2));
    } finally {
        if(socket)socket.close();edge.kill();server.close();await pause(500);
        try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
    }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
