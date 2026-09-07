const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const childProcess = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const recoveryOnHtml = childProcess.execFileSync('git', ['show','f47044aa:index.html'], {cwd:repoRoot,encoding:'utf8'});
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-diagnostics-removal-'));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fixture = Array.from({length:20}, (_, index) => `fixture\tquestion ${index}\tanswer ${index}`).join('\n');
const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if(pathname === '/recovery-on.html') return response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end(recoveryOnHtml);
    if(pathname === '/decks-manifest.json') return response.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({schemaVersion:1,version:'diagnostics-removal',files:['fixture.txt']}));
    if(pathname === '/fixture.txt') return response.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'}).end(fixture);
    const filePath = path.resolve(repoRoot, pathname.replace(/^\/+/, '') || 'index.html');
    if(!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) return response.writeHead(404).end();
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    fs.createReadStream(filePath).pipe(response);
});

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const debugPort = 9800 + Math.floor(Math.random() * 100);
    const edge = childProcess.spawn(edgePath, ['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${profilePath}`,`--remote-debugging-port=${debugPort}`,'about:blank'], {stdio:'ignore',windowsHide:true});
    let socket;
    try {
        let target;
        for(let attempt=0;attempt<50 && !target;attempt++) {
            try { target=(await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.type === 'page'); } catch(error) {}
            if(!target) await delay(200);
        }
        assert(target);
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve,reject) => { socket.onopen=resolve; socket.onerror=reject; });
        let nextId=0; const pending=new Map(); let firebaseRequests=0; let navigations=0;
        const send=(method,params={}) => new Promise((resolve,reject) => {
            const id=++nextId; const timer=setTimeout(() => reject(new Error(`${method} timed out`)),15000);
            pending.set(id,message => { clearTimeout(timer); resolve(message); }); socket.send(JSON.stringify({id,method,params}));
        });
        const post=(method,params={}) => socket.send(JSON.stringify({id:++nextId,method,params}));
        socket.onmessage=event => {
            const message=JSON.parse(event.data);
            if(message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
            if(message.method === 'Page.frameNavigated' && !message.params.frame.parentId) navigations++;
            if(message.method === 'Fetch.requestPaused') {
                if(/firebaseio\.com/i.test(message.params.request.url)) firebaseRequests++;
                post('Fetch.continueRequest',{requestId:message.params.requestId});
            }
        };
        await send('Runtime.enable'); await send('Page.enable');
        await send('Fetch.enable',{patterns:[{urlPattern:'*firebaseio.com/*',requestStage:'Request'}]});
        const evaluate=async expression => {
            const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
            if(result.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description || 'evaluation failed');
            return result.result?.result?.value;
        };
        const waitForStartup=async previousPageInstanceId => { for(let attempt=0;attempt<750;attempt++) {
            const ready=await evaluate(`typeof getMkStartupTiming==='function' && getMkStartupTiming().FIRST_CARD_VISIBLE!==undefined ? mkPageInstanceId : ''`);
            if(ready && ready !== previousPageInstanceId) return ready;
            await delay(20);
        } throw new Error('startup timeout'); };
        await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`});
        await waitForStartup('');
        const protectedBefore=await evaluate(`(() => {
            if(localStorage.getItem(STORAGE_KEY_REVIEW_HISTORY) === null) localStorage.setItem(STORAGE_KEY_REVIEW_HISTORY,'{}');
            localStorage.setItem('mk_last_startup_crash_incident','legacy-incident');
            localStorage.setItem('mk_startup_failure_count','7');
            localStorage.setItem('mk_navigation_counter','19');
            sessionStorage.setItem('mk_startup_recovery_bypass_once','1');
            return {stats:localStorage.getItem(STORAGE_KEY_STATS),history:localStorage.getItem(STORAGE_KEY_REVIEW_HISTORY),filter:localStorage.getItem(STORAGE_KEY_FILTER_STATE),deck:localStorage.getItem(STORAGE_KEY_LAST_DECK),card:localStorage.getItem(STORAGE_KEY_CURRENT_CARD_ID)};
        })()`);
        const firstPageInstanceId=await evaluate(`mkPageInstanceId`);
        await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html?safe=1`});
        await waitForStartup(firstPageInstanceId);
        const result=await evaluate(`(() => {
            const beforeInit=filterResetInitAppCount;
            const markerBefore=JSON.parse(localStorage.getItem('mk_startup_boot_marker'));
            let normalCount=0;
            for(let run=0;run<10;run++) {
                window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
                if(window.__mkLastPageshowWasNormalLifecycle) normalCount++;
            }
            const marker=JSON.parse(localStorage.getItem('mk_startup_boot_marker'));
            const duplicateResult=initApp();
            return {
                legacy:{incident:localStorage.getItem('mk_last_startup_crash_incident'),failure:localStorage.getItem('mk_startup_failure_count'),navigation:localStorage.getItem('mk_navigation_counter'),bypass:sessionStorage.getItem('mk_startup_recovery_bypass_once')},
                protected:{stats:localStorage.getItem(STORAGE_KEY_STATS),history:localStorage.getItem(STORAGE_KEY_REVIEW_HISTORY),filter:localStorage.getItem(STORAGE_KEY_FILTER_STATE),deck:localStorage.getItem(STORAGE_KEY_LAST_DECK),card:localStorage.getItem(STORAGE_KEY_CURRENT_CARD_ID)},
                ui:{menu:!!document.querySelector('[onclick="openStartupCrashIncidentModal()"]'),modal:!!document.getElementById('startup-crash-incident-modal'),recovery:!!document.getElementById('mk-startup-recovery')},
                lifecycle:{normalCount,pageInstanceSame:marker.pageInstanceId===markerBefore.pageInstanceId,persisted:marker.pageshowPersisted,lastLifecycle:marker.lastLifecycle},
                init:{before:beforeInit,after:filterResetInitAppCount,duplicateResult},
                startup:getMkStartupTiming()
            };
        })()`);
        assert.deepStrictEqual(result.legacy,{incident:null,failure:null,navigation:null,bypass:null});
        assert.deepStrictEqual(result.protected,protectedBefore);
        assert.deepStrictEqual(result.ui,{menu:false,modal:false,recovery:false});
        assert.deepStrictEqual(result.lifecycle,{normalCount:10,pageInstanceSame:true,persisted:true,lastLifecycle:'pageshow'});
        assert.deepStrictEqual(result.init,{before:1,after:1,duplicateResult:false});
        assert.strictEqual(firebaseRequests,0);

        const idleStart={navigations,pageInstanceId:await evaluate(`mkPageInstanceId`)};
        await delay(60000);
        const idle60={navigations:navigations-idleStart.navigations,pageInstanceChanges:Number((await evaluate(`mkPageInstanceId`)) !== idleStart.pageInstanceId),init:await evaluate(`filterResetInitAppCount`),renders:await evaluate(`getMkStartupTiming().firstRenderCount`)};
        assert.deepStrictEqual(idle60,{navigations:0,pageInstanceChanges:0,init:1,renders:1});

        const coldStarts=[];
        for(let run=0;run<20;run++) {
            const previousId=await evaluate(`mkPageInstanceId`); const navStart=navigations;
            await send('Page.reload',{ignoreCache:true});
            for(let attempt=0;attempt<200 && navigations<=navStart;attempt++) await delay(10);
            assert(navigations>navStart,'requested cold start did not navigate');
            await send('Page.bringToFront');
            await send('Page.captureScreenshot',{format:'png'});
            const nextId=await waitForStartup(previousId);
            await delay(100);
            coldStarts.push({navigationDelta:navigations-navStart,newDocument:nextId!==previousId,init:await evaluate(`filterResetInitAppCount`),renders:await evaluate(`getMkStartupTiming().firstRenderCount`)});
        }
        coldStarts.forEach(item => assert.deepStrictEqual(item,{navigationDelta:1,newDocument:true,init:1,renders:1}));

        const filterStart=await evaluate(`(async () => {
            const stats=getStatsStore();
            originalDeck.forEach(card => { stats[String(card.id)]={total:1,correct:1,lastDate:1,updatedAt:1,dueDate:1,mem:true,fsrs:{D:5,S:1,reps:1}}; });
            setCanonicalStatsStore(stats,'startup-reset-loop-test'); await statsPersistenceQueue;
            document.getElementById('search-input').value=''; setFilterMode('mem'); persistCurrentViewState(false);
            return {pageInstanceId:mkPageInstanceId,filter:JSON.stringify(getFilterStateForStorage()),search:getCurrentFilterSearchQuery(),card:getCurrentCardId(),init:filterResetInitAppCount};
        })()`);
        const filterNavStart=navigations;
        await delay(60000);
        const filterIdle=await evaluate(`({pageInstanceId:mkPageInstanceId,filter:JSON.stringify(getFilterStateForStorage()),search:getCurrentFilterSearchQuery(),card:getCurrentCardId(),init:filterResetInitAppCount})`);
        assert.strictEqual(navigations-filterNavStart,0);
        assert.deepStrictEqual(filterIdle,{pageInstanceId:filterStart.pageInstanceId,filter:filterStart.filter,search:filterStart.search,card:filterStart.card,init:1});

        const gradeStart={navigations,pageInstanceId:await evaluate(`mkPageInstanceId`)};
        const graded=await evaluate(`(async () => { for(let run=0;run<50;run++) await grade(2); return {pageInstanceId:mkPageInstanceId,init:filterResetInitAppCount,filter:JSON.stringify(getFilterStateForStorage()),search:getCurrentFilterSearchQuery()}; })()`);
        assert.strictEqual(navigations-gradeStart.navigations,0);
        assert.strictEqual(graded.pageInstanceId,gradeStart.pageInstanceId);
        assert.strictEqual(graded.init,1);
        assert(graded.filter.includes('mem'));

        const recoveryOnNavStart=navigations;
        const recoveryOnPreviousId=await evaluate(`mkPageInstanceId`);
        await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/recovery-on.html`});
        const recoveryOnPageInstanceId=await waitForStartup(recoveryOnPreviousId);
        const recoveryOnSteadyNavStart=navigations;
        await delay(30000);
        const recoveryOn={navigations:navigations-recoveryOnSteadyNavStart,pageInstanceChanges:Number((await evaluate(`mkPageInstanceId`))!==recoveryOnPageInstanceId),init:await evaluate(`filterResetInitAppCount`),renders:await evaluate(`getMkStartupTiming().firstRenderCount`),entryNavigationDelta:recoveryOnSteadyNavStart-recoveryOnNavStart};
        assert.deepStrictEqual(recoveryOn,{navigations:0,pageInstanceChanges:0,init:1,renders:1,entryNavigationDelta:1});
        const recoveryComparison={on:recoveryOn,off:idle60};
        process.stdout.write(JSON.stringify({result,idle60,coldStarts,filterIdle,graded,recoveryComparison,firebaseRequests,navigations},null,2)+'\n');
    } finally {
        if(socket && socket.readyState === WebSocket.OPEN) socket.close();
        edge.kill(); server.close(); await delay(300);
        try { fs.rmSync(profilePath,{recursive:true,force:true}); } catch(error) {}
    }
}

main().catch(error => { console.error(error); process.exitCode=1; });
