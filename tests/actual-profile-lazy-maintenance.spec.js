const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const assert = require('node:assert');

const repoRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'));
const profilePath = process.env.MK_ACTUAL_PROFILE_COPY;
const lazyTask = process.env.MK_LAZY_TASK || '';
const sampleCount = Number(process.env.MK_SAMPLE_COUNT) || 240;
const skipStudy = process.env.MK_SKIP_STUDY === '1';
const lazyTaskExpression = lazyTask === 'ledger'
    ? 'initializeReviewHistoryLedger()'
    : lazyTask === 'learning'
        ? 'startLearningStatsInitialization()'
        : `(async()=>{const pdf=originalDeck.findIndex(card=>cardMayContainPdfAnnotation(card,true));const io=originalDeck.findIndex(card=>isMkImageOcclusionCardFast(card));const shown={pdf,io};if(pdf>=0){activeDeck=originalDeck;currentIndex=pdf;showCard();await new Promise(r=>setTimeout(r,800));shown.pdfIcon=!!document.querySelector('.mk-pdf-annotation-icon');}if(io>=0){activeDeck=originalDeck;currentIndex=io;showCard();await new Promise(r=>setTimeout(r,1500));shown.ioImage=!!document.querySelector('.mk-io-image');}return shown;})()`;
assert(profilePath && fs.existsSync(profilePath), 'MK_ACTUAL_PROFILE_COPY must point to an independent copy of the real Chrome profile');
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9700 + Math.floor(Math.random() * 200);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function main() {
    const chrome = childProcess.spawn(chromePath, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        `--user-data-dir=${profilePath}`, '--profile-directory=Default', `--remote-debugging-port=${port}`, 'about:blank'
    ], {stdio:'ignore', windowsHide:true});
    let socket;
    try {
        let target;
        for(let attempt=0; attempt<100 && !target; attempt++) {
            try { target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch(error) {}
            if(!target) await delay(100);
        }
        assert(target, 'Chrome debugging target unavailable');
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve,reject) => { socket.onopen=resolve; socket.onerror=reject; });
        let id=0; const pending=new Map(); let navigations=0; const firebase=[];
        const send=(method,params={}) => new Promise((resolve,reject) => {
            const callId=++id; const timer=setTimeout(() => {pending.delete(callId); reject(new Error(`${method} timeout`));},30000);
            pending.set(callId,message => {clearTimeout(timer); resolve(message);}); socket.send(JSON.stringify({id:callId,method,params}));
        });
        const post=(method,params={}) => socket.send(JSON.stringify({id:++id,method,params}));
        socket.onmessage=event => {
            const message=JSON.parse(event.data);
            if(message.id && pending.has(message.id)) {pending.get(message.id)(message); pending.delete(message.id); return;}
            if(message.method === 'Page.frameNavigated' && !message.params.frame.parentId) navigations++;
            if(message.method !== 'Fetch.requestPaused') return;
            const request=message.params.request;
            if(/firebaseio\.com/i.test(request.url)) {
                firebase.push({method:request.method,url:request.url});
                return post('Fetch.fulfillRequest',{requestId:message.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(request.method === 'GET' ? 'null' : '{}').toString('base64')});
            }
            if(/^https:\/\/minkunai87-ai\.github\.io\/mk\/(?:index\.html)?(?:[?#].*)?$/.test(request.url)) {
                return post('Fetch.fulfillRequest',{requestId:message.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'},{name:'Cache-Control',value:'no-store'}],body:html.toString('base64')});
            }
            post('Fetch.continueRequest',{requestId:message.params.requestId});
        };
        await send('Runtime.enable'); await send('Page.enable'); await send('Performance.enable');
        await send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
        await send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {
            window.__mkActual={calls:{},longTasks:[],startedAt:performance.now()};
            new PerformanceObserver(list => list.getEntries().forEach(e => window.__mkActual.longTasks.push({start:e.startTime,duration:e.duration}))).observe({entryTypes:['longtask']});
            const targets=['startLearningStatsInitialization','initializeReviewHistoryLedger','loadPdfAnnotationSourceIndex','refreshCachedLibraryIfNeeded','cleanupOversizedViewState','cleanupLegacyRecoverySnapshotsAndRestoreCache','loadTodayNewBaselineSnapshot','registerTodayNewCards','scheduleAdjacentIOImageWarmup','warmIOImage','performFirebaseBackup'];
            const timer=setInterval(() => targets.forEach(name => {
                const fn=window[name]; if(typeof fn !== 'function' || fn.__mkWrapped) return;
                const wrapped=function(...args){window.__mkActual.calls[name]=(window.__mkActual.calls[name]||0)+1; return fn.apply(this,args)};
                wrapped.__mkWrapped=true; window[name]=wrapped;
            }),0);
            addEventListener('load',()=>setTimeout(()=>clearInterval(timer),5000));
        })();`});
        const evaluate=async expression => {
            const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
            if(result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || 'evaluation failed');
            return result.result?.result?.value;
        };
        await send('Page.navigate',{url:'https://minkunai87-ai.github.io/mk/index.html'});
        for(let attempt=0; attempt<600; attempt++) {
            try { if(await evaluate(`startupRestoreCompleted && getMkStartupTiming().firstVisiblePaint !== undefined`)) break; } catch(error) {}
            await delay(100);
        }
        const start=await evaluate(`({version:APP_VERSION,pageInstanceId:mkPageInstanceId,init:getMkStartupTiming().initAppCalls,renders:getMkStartupTiming().firstRenderCount,stats:Object.keys(getStatsStore()).length,history:Object.values(JSON.parse(localStorage.getItem(STORAGE_KEY_REVIEW_HISTORY)||'{}')).reduce((s,a)=>s+(Array.isArray(a)?a.length:0),0),original:originalDeck.length,active:activeDeck.length,localBytes:Object.keys(localStorage).reduce((s,k)=>s+2*(k.length+(localStorage.getItem(k)||'').length),0),calls:window.__mkActual.calls})`);
        const taskResult=lazyTask ? await evaluate(`(async()=>{const before=performance.memory?.usedJSHeapSize||null;const started=performance.now();const result=await ${lazyTaskExpression};return {task:${JSON.stringify(lazyTask)},duration:performance.now()-started,before,after:performance.memory?.usedJSHeapSize||null,result};})()`) : null;
        let peak=0;
        for(let sample=0; sample<sampleCount; sample++) {
            const metrics=await send('Performance.getMetrics');
            const heap=metrics.result.metrics.find(item => item.name === 'JSHeapUsedSize')?.value || 0;
            peak=Math.max(peak,heap); await delay(500);
        }
        const idle=await evaluate(`({pageInstanceId:mkPageInstanceId,init:getMkStartupTiming().initAppCalls,renders:getMkStartupTiming().firstRenderCount,calls:window.__mkActual.calls,longest:Math.max(0,...window.__mkActual.longTasks.map(x=>x.duration)),longTasks:window.__mkActual.longTasks.length,filter:JSON.stringify(getFilterStateForStorage()),card:getCurrentCardId()})`);
        const navBefore=navigations;
        const study=skipStudy ? null : await evaluate(`(async()=>{let completed=0;for(let i=0;i<50&&activeDeck.length;i++){revealAnswer();await grade(2);completed++;}await statsPersistenceQueue;return {completed,pageInstanceId:mkPageInstanceId,init:getMkStartupTiming().initAppCalls,filter:JSON.stringify(getFilterStateForStorage()),calls:window.__mkActual.calls};})()`);
        if(!skipStudy) await delay(5000);
        const after=await evaluate(`({pageInstanceId:mkPageInstanceId,init:getMkStartupTiming().initAppCalls,calls:window.__mkActual.calls})`);
        const result={start,taskResult,idle,study,after,peakHeapBytes:peak,navigationDeltaDuringStudy:navigations-navBefore,firebase};
        assert.strictEqual(start.version,'v18.5.209 - lazy maintenance startup');
        assert.strictEqual(idle.pageInstanceId,start.pageInstanceId); assert.strictEqual(idle.init,1);
        if(!lazyTask) for(const name of ['startLearningStatsInitialization','initializeReviewHistoryLedger','loadPdfAnnotationSourceIndex','refreshCachedLibraryIfNeeded','cleanupOversizedViewState','cleanupLegacyRecoverySnapshotsAndRestoreCache','loadTodayNewBaselineSnapshot','registerTodayNewCards','scheduleAdjacentIOImageWarmup','warmIOImage','performFirebaseBackup']) assert.strictEqual(idle.calls[name] || 0,0,`${name} ran while idle`);
        assert.strictEqual(after.pageInstanceId,start.pageInstanceId); assert.strictEqual(after.init,1); assert.strictEqual(navigations-navBefore,0);
        process.stdout.write(JSON.stringify(result,null,2)+'\n');
    } finally {
        if(socket && socket.readyState === WebSocket.OPEN) socket.close(); chrome.kill(); await delay(500);
    }
}
main().catch(error => {console.error(error);process.exitCode=1;});
