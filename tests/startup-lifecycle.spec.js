const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const repoRoot = path.resolve(__dirname, '..');
const baselineHtml = childProcess.execFileSync('git', ['show','HEAD:index.html'], {cwd:repoRoot, encoding:'utf8'});
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-startup-'));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const startupPdfUuid = '6a69ef21-c0f1-4182-a125-f34e23de8d0e';
const fixture = Array.from({length:200}, (_, index) => index === 0
    ? `fixture\t<span data-source-uuid="${startupPdfUuid}"><img src="178_${startupPdfUuid}_startup.png"> fixture question 0</span>\tfixture answer 0`
    : `fixture\tfixture question ${index}\tfixture answer ${index}`).join('\n');
const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if(pathname === '/baseline.html') return response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end(baselineHtml);
    if(pathname === '/decks-manifest.json') return response.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({schemaVersion:1, version:'startup-test', files:['fixture.txt']}));
    if(pathname === '/fixture.txt') return response.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'}).end(fixture);
    const relative = pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(repoRoot, relative);
    if(!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) return response.writeHead(404).end();
    response.writeHead(200, {'Content-Type':filePath.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8'});
    fs.createReadStream(filePath).pipe(response);
});

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const debugPort = 9500 + Math.floor(Math.random() * 300);
    const edge = childProcess.spawn(edgePath, ['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${profilePath}`,`--remote-debugging-port=${debugPort}`,'about:blank'], {stdio:'ignore', windowsHide:true});
    let socket;
    try {
        let target;
        for(let attempt=0; attempt<50 && !target; attempt++) {
            try { target=(await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.type === 'page'); } catch(error) {}
            if(!target) await delay(200);
        }
        assert(target, 'Edge debugging target unavailable');
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve,reject) => { socket.onopen=resolve; socket.onerror=reject; });
        let nextId=0;
        const pending=new Map();
        let firebaseMode='normal';
        let firebaseRequests=[];
        let firebaseWrites=0;
        let navigations=0;
        const send=(method,params={}) => new Promise((resolve,reject) => {
            const id=++nextId;
            const timer=setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
            pending.set(id,message => { clearTimeout(timer); resolve(message); });
            socket.send(JSON.stringify({id,method,params}));
        });
        const post=(method,params={}) => socket.send(JSON.stringify({id:++nextId,method,params}));
        socket.onmessage=event => {
            const message=JSON.parse(event.data);
            if(message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
            if(message.method === 'Page.frameNavigated' && message.params.frame.parentId === undefined) navigations++;
            if(message.method !== 'Fetch.requestPaused') return;
            const request=message.params.request;
            if(!/firebaseio\.com/i.test(request.url)) return post('Fetch.continueRequest',{requestId:message.params.requestId});
            firebaseRequests.push({method:request.method,url:request.url,mode:firebaseMode});
            if(request.method !== 'GET') firebaseWrites++;
            const fulfill=() => post('Fetch.fulfillRequest', {
                requestId:message.params.requestId,
                responseCode:firebaseMode === 'failure' ? 503 : 200,
                responseHeaders:[{name:'Content-Type',value:'application/json'}],
                body:Buffer.from(firebaseMode === 'failure' ? '{}' : 'null').toString('base64')
            });
            if(firebaseMode === 'delay') setTimeout(fulfill,5000); else fulfill();
        };
        await send('Runtime.enable');
        await send('Page.enable');
        await send('Fetch.enable',{patterns:[{urlPattern:'*firebaseio.com/*',requestStage:'Request'}]});
        await send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {
            if(localStorage.getItem('mk_startup_test_seeded')) return;
            const stats={};
            for(let index=0; index<10000; index++) stats['startup-' + index]={total:1,correct:1,lastDate:1,updatedAt:1,dueDate:1,fsrs:{D:5,S:1,reps:1}};
            localStorage.setItem('anki_final_stats',JSON.stringify(stats));
            localStorage.setItem('mk_local_data_updated_at','1');
            localStorage.setItem('mk_startup_test_seeded','1');
        })();`});
        const evaluate=async expression => {
            const response=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
            if(response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || 'browser evaluation failed');
            return response.result?.result?.value;
        };
        const waitForPaint=async () => {
            for(let attempt=0; attempt<750; attempt++) {
                try {
                    const state=await evaluate(`typeof getMkStartupTiming === 'function' ? getMkStartupTiming() : null`);
                    if(state && state.firstVisiblePaint !== undefined) return state;
                } catch(error) {}
                await delay(20);
            }
            throw new Error('first visible paint timed out');
        };
        const reload=async mode => {
            firebaseMode=mode;
            const requestStart=firebaseRequests.length;
            const navStart=navigations;
            const started=Date.now();
            await send('Page.reload',{ignoreCache:true});
            for(let attempt=0; attempt<200 && navigations <= navStart; attempt++) await delay(10);
            assert(navigations > navStart, 'requested reload did not navigate');
            const timing=await waitForPaint();
            const externalPaintMs=Date.now()-started;
            const state=await evaluate(`({
                timing:getMkStartupTiming(), pageInstanceId:filterResetPageInstanceId,
                filter:JSON.stringify(getFilterStateForStorage()), search:getCurrentFilterSearchQuery(),
                sort:currentSortMode, secondary:currentSecondarySortMode, card:getCurrentCardId(),
                renders:ioZoomDiagnostics.cardRenders, initCount:filterResetInitAppCount,
                traceWrites:(dumpMkFilterResetTrace() || []).length,
                pdfIcon:!!document.querySelector('#question-section .mk-pdf-annotation-icon'),
                pdfHref:document.querySelector('#question-section .mk-pdf-annotation-icon')?.getAttribute('href') || ''
            })`);
            return {mode,timing,state,externalPaintMs,requestStart,navStart};
        };

        await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`});
        await waitForPaint();
        const saved=await evaluate(`(async () => {
            const stats=getStatsStore();
            originalDeck.forEach(card => { stats[String(card.id)]={total:1,correct:1,lastDate:1,updatedAt:1,dueDate:1,mem:true,fsrs:{D:5,S:1,reps:1}}; });
            setCanonicalStatsStore(stats,'startup-lifecycle-test');
            await statsPersistenceQueue;
            currentFilterMode=['mem']; currentSortMode='original'; currentSecondarySortMode='none';
            document.getElementById('search-input').value='fixture';
            applyFilterAndSort(false); persistCurrentViewState(false);
            localStorage.removeItem(FILTER_RESET_TRACE_KEY);
            return {deck:currentDeckName,card:getCurrentCardId(),active:activeDeck.length,filter:localStorage.getItem(STORAGE_KEY_FILTER_STATE),view:localStorage.getItem(STORAGE_KEY_VIEW_STATE)};
        })()`);
        assert(saved.deck && saved.card && saved.active > 0, JSON.stringify(saved));
        assert(saved.filter.includes('mem'), JSON.stringify(saved));

        const normal=await reload('normal');
        assert.strictEqual(normal.state.initCount,1);
        assert.strictEqual(normal.timing.firstRenderCount,1);
        assert.strictEqual(normal.state.filter,'["mem"]',JSON.stringify({saved,normal}));
        assert.strictEqual(normal.state.search,'fixture');
        assert.strictEqual(normal.state.card,saved.card);
        assert.strictEqual(normal.state.pdfIcon,true);
        assert(normal.state.pdfHref.startsWith('mkpdf://open?'),JSON.stringify(normal.state));
        await delay(100);
        const pdfAt100=await evaluate(`document.querySelector('#question-section .mk-pdf-annotation-icon')?.getAttribute('href') || ''`);
        await delay(400);
        const pdfAt500=await evaluate(`document.querySelector('#question-section .mk-pdf-annotation-icon')?.getAttribute('href') || ''`);
        assert.strictEqual(pdfAt100,normal.state.pdfHref);
        assert.strictEqual(pdfAt500,normal.state.pdfHref);

        let postPaintFilter; let postPaintFilterAfter;

        const delayed=await reload('delay');
        assert(delayed.externalPaintMs < 1500, JSON.stringify(delayed));
        const beforeDelayedSync=await evaluate(`(() => { setFilterMode('due'); return {pageInstanceId:filterResetPageInstanceId,filter:JSON.stringify(getFilterStateForStorage()),search:getCurrentFilterSearchQuery(),card:getCurrentCardId(),initCount:filterResetInitAppCount,renders:ioZoomDiagnostics.cardRenders,revision:userInteractionRevision}; })()`);
        await delay(5400);
        const afterDelayedSync=await evaluate(`({timing:getMkStartupTiming(),pageInstanceId:filterResetPageInstanceId,filter:JSON.stringify(getFilterStateForStorage()),search:getCurrentFilterSearchQuery(),card:getCurrentCardId(),initCount:filterResetInitAppCount,renders:ioZoomDiagnostics.cardRenders})`);
        assert.strictEqual(afterDelayedSync.pageInstanceId,beforeDelayedSync.pageInstanceId);
        assert.strictEqual(afterDelayedSync.filter,beforeDelayedSync.filter);
        assert.strictEqual(afterDelayedSync.search,beforeDelayedSync.search);
        assert.strictEqual(afterDelayedSync.card,beforeDelayedSync.card);
        assert.strictEqual(afterDelayedSync.initCount,1);
        assert.strictEqual(afterDelayedSync.renders,beforeDelayedSync.renders);
        await evaluate(`(() => { setFilterMode('due'); return JSON.stringify(getFilterStateForStorage()); })()`);

        const failure=await reload('failure');
        await delay(300);
        const failureAfter=await evaluate(`({pageInstanceId:filterResetPageInstanceId,filter:JSON.stringify(getFilterStateForStorage()),card:getCurrentCardId(),initCount:filterResetInitAppCount,renders:ioZoomDiagnostics.cardRenders})`);
        assert.strictEqual(failureAfter.pageInstanceId,failure.state.pageInstanceId);
        assert.strictEqual(failureAfter.filter,'["mem"]');
        assert.strictEqual(failureAfter.card,saved.card);
        assert.strictEqual(failureAfter.initCount,1);

        const repeated=[];
        for(let run=0; run<5; run++) {
            const result=await reload('normal');
            assert.strictEqual(result.state.initCount,1);
            assert.strictEqual(result.timing.firstRenderCount,1);
            assert.strictEqual(result.state.filter,'["mem"]');
            repeated.push({firstVisiblePaint:result.timing.firstVisiblePaint,externalPaintMs:result.externalPaintMs,initCount:result.state.initCount,firstRenderCount:result.timing.firstRenderCount});
            for(let attempt=0; attempt<100; attempt++) {
                if(await evaluate(`getMkStartupTiming().backgroundSyncCompleted`)) break;
                await delay(20);
            }
            await delay(500);
        }
        postPaintFilter=await evaluate(`(() => {
            window.__mkDelayedFilterTest={fullDeckFallbacks:0};
            const originalSetActiveDeckWithTrace=setActiveDeckWithTrace;
            setActiveDeckWithTrace=(next,caller) => { if(next === originalDeck) window.__mkDelayedFilterTest.fullDeckFallbacks++; return originalSetActiveDeckWithTrace(next,caller); };
            setFilterMode('due');
            return {filter:JSON.stringify(getFilterStateForStorage()),card:getCurrentCardId(),revision:userInteractionRevision,renders:ioZoomDiagnostics.cardRenders,pageInstanceId:filterResetPageInstanceId};
        })()`);
        await delay(10200);
        postPaintFilterAfter=await evaluate(`({filter:JSON.stringify(getFilterStateForStorage()),card:getCurrentCardId(),revision:userInteractionRevision,renders:ioZoomDiagnostics.cardRenders,pageInstanceId:filterResetPageInstanceId,fullDeckFallbacks:window.__mkDelayedFilterTest.fullDeckFallbacks,backgroundComplete:getMkStartupTiming().backgroundSyncCompleted})`);
        assert.strictEqual(postPaintFilterAfter.filter,postPaintFilter.filter);
        assert.strictEqual(postPaintFilterAfter.card,postPaintFilter.card);
        assert.strictEqual(postPaintFilterAfter.pageInstanceId,postPaintFilter.pageInstanceId);
        assert.strictEqual(postPaintFilterAfter.renders,postPaintFilter.renders);
        assert.strictEqual(postPaintFilterAfter.fullDeckFallbacks,0);
        assert.strictEqual(postPaintFilterAfter.backgroundComplete,true);
        const duplicateGuard=await evaluate(`(() => { const before=ioZoomDiagnostics.cardRenders; const result=initApp(); return {result,initCount:filterResetInitAppCount,renderDelta:ioZoomDiagnostics.cardRenders-before}; })()`);
        assert.deepStrictEqual(duplicateGuard,{result:false,initCount:1,renderDelta:0});
        assert.strictEqual(firebaseWrites,0);
        await evaluate(`localStorage.removeItem(FILTER_RESET_TRACE_KEY)`);
        firebaseMode='normal';
        const baselineNavStart=navigations;
        const baselineStarted=Date.now();
        await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/baseline.html`});
        for(let attempt=0; attempt<200 && navigations <= baselineNavStart; attempt++) await delay(10);
        let baseline;
        for(let attempt=0; attempt<300 && !baseline; attempt++) {
            try {
                const state=await evaluate(`({loading:document.getElementById('loading')?.style.display || '',card:getCurrentCardId(),initCount:filterResetInitAppCount,renders:ioZoomDiagnostics.cardRenders,traceWrites:(dumpMkFilterResetTrace() || []).length})`);
                if(state.loading === 'none' && state.card) baseline={...state,externalPaintMs:Date.now()-baselineStarted};
            } catch(error) {}
            if(!baseline) await delay(20);
        }
        assert(baseline && baseline.card, 'baseline startup did not render');
        const delayedRequests=firebaseRequests.slice(delayed.requestStart).filter(item => item.mode === 'delay');
        process.stdout.write(JSON.stringify({baseline,normal:{timing:normal.timing,externalPaintMs:normal.externalPaintMs,traceWrites:normal.state.traceWrites,pdf:{at0:normal.state.pdfHref,at100:pdfAt100,at500:pdfAt500}},postPaintFilter:{before:postPaintFilter,after:postPaintFilterAfter},delayed:{timing:delayed.timing,externalPaintMs:delayed.externalPaintMs,requests:delayedRequests.length,before:beforeDelayedSync,after:afterDelayedSync},failure:{timing:failure.timing,after:failureAfter},repeated,duplicateGuard,navigations,firebaseWrites},null,2)+'\n');
    } finally {
        if(socket && socket.readyState === WebSocket.OPEN) socket.close();
        edge.kill(); server.close(); await delay(500);
        try { fs.rmSync(profilePath,{recursive:true,force:true}); } catch(error) {}
    }
}

main().catch(error => { console.error(error); process.exitCode=1; });
