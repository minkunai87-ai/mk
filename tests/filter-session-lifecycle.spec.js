const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const repoRoot = path.resolve(__dirname, '..');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-filter-session-'));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if(pathname === '/decks-manifest.json') {
        response.writeHead(200, {'Content-Type':'application/json'});
        return response.end(JSON.stringify({schemaVersion:1, version:'filter-test', files:['fixture.txt']}));
    }
    if(pathname === '/fixture.txt') {
        response.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'});
        return response.end('fixture\tfixture question\tfixture answer\n');
    }
    const relative = pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(repoRoot, relative);
    if(!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) return response.writeHead(404).end();
    response.writeHead(200, {'Content-Type':filePath.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8'});
    fs.createReadStream(filePath).pipe(response);
});

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const serverPort = server.address().port;
    const debugPort = 9400 + Math.floor(Math.random() * 400);
    const edge = childProcess.spawn(edgePath, [
        '--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profilePath}`,
        `--remote-debugging-port=${debugPort}`, 'about:blank'
    ], {stdio:'ignore', windowsHide:true});
    let socket;
    try {
        let target;
        for(let attempt = 0; attempt < 50 && !target; attempt++) {
            try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(item => item.type === 'page'); } catch(error) {}
            if(!target) await delay(200);
        }
        if(!target) throw new Error('Edge debugging target unavailable');
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let nextId = 0;
        const pending = new Map();
        let firebaseWritesIntercepted = 0;
        let pageNavigations = 0;
        const consoleMessages = [];
        const send = (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++nextId;
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
            pending.set(id, message => { clearTimeout(timer); resolve(message); });
            socket.send(JSON.stringify({id, method, params}));
        });
        const post = (method, params = {}) => socket.send(JSON.stringify({id:++nextId, method, params}));
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if(message.id && pending.has(message.id)) {
                pending.get(message.id)(message);
                pending.delete(message.id);
                return;
            }
            if(message.method === 'Page.frameNavigated' && message.params.frame.parentId === undefined) pageNavigations++;
            if(message.method === 'Runtime.consoleAPICalled') {
                consoleMessages.push((message.params.args || []).map(arg => arg.value ?? arg.description ?? '').join(' '));
            }
            if(message.method !== 'Fetch.requestPaused') return;
            const request = message.params.request;
            if(!/firebaseio\.com/i.test(request.url)) return post('Fetch.continueRequest', {requestId:message.params.requestId});
            if(request.method !== 'GET') firebaseWritesIntercepted++;
            const body = request.method === 'GET'
                ? (/learningStatsEventsMeta/.test(request.url) ? JSON.stringify({latestReviewEventId:'', updatedAt:0}) : 'null')
                : '{}';
            post('Fetch.fulfillRequest', {
                requestId:message.params.requestId,
                responseCode:200,
                responseHeaders:[{name:'Content-Type', value:'application/json'}],
                body:Buffer.from(body).toString('base64')
            });
        };
        await send('Runtime.enable');
        await send('Page.enable');
        await send('Fetch.enable', {patterns:[{urlPattern:'*firebaseio.com/*', requestStage:'Request'}]});
        await send('Page.addScriptToEvaluateOnNewDocument', {source:`(() => {
            const stats = {};
            for(let index = 0; index < 10000; index++) stats['startup-healthy-' + index] = {total:1,correct:1,lastDate:1,updatedAt:1,dueDate:1,fsrs:{D:5,S:1,reps:1}};
            localStorage.setItem('anki_final_stats', JSON.stringify(stats));
            localStorage.setItem('mk_local_data_updated_at', '1');
        })();`});
        await send('Page.navigate', {url:`http://127.0.0.1:${serverPort}/index.html`});

        const evaluate = async expression => {
            const response = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
            if(response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || 'browser evaluation failed');
            return response.result?.result?.value;
        };
        let ready = false;
        let readiness = null;
        for(let attempt = 0; attempt < 100 && !ready; attempt++) {
            try {
                readiness = await evaluate(`({grade:typeof grade, readyState:document.readyState, loading:document.getElementById('loading')?.style.display || '', learningStatsReady:typeof learningStatsReady === 'undefined' ? null : learningStatsReady, restoreState:typeof learningStatsRestoreState === 'undefined' ? null : learningStatsRestoreState, statsCount:typeof getCanonicalStatsStore === 'function' ? Object.keys(getCanonicalStatsStore()).length : -1, libraryCount:typeof library === 'object' ? Object.keys(library).length : -1})`);
                ready = readiness.grade === 'function' && readiness.readyState === 'complete' && readiness.loading === 'none';
            } catch(error) {}
            if(!ready) await delay(200);
        }
        assert(ready, `app did not become ready: ${JSON.stringify(readiness)}`);

        const setupState = await evaluate(`(async () => {
            learningStatsRestoreState = 'success';
            learningStatsReady = true;
            learningStatsEventLedgerActive = true;
            const nativeFetch = window.fetch.bind(window);
            window.fetch = (input, options = {}) => {
                const url = String(input && input.href || input || '');
                if(/firebaseio\\.com/i.test(url)) {
                    const method = String(options.method || 'GET').toUpperCase();
                    return Promise.resolve(new Response(method === 'GET' ? 'null' : '{}', {status:200, headers:{'Content-Type':'application/json'}}));
                }
                return nativeFetch(input, options);
            };
            const cards = Array.from({length:100}, (_, index) => ({id:'filter-card-' + index, q:'Question ' + index, a:'Answer ' + index, deck:'filter__deck', sourceOrder:index}));
            library = {'filter__deck':cards};
            currentDeckName = 'filter__deck';
            originalDeck = cards;
            const stats = {};
            for(let index = 0; index < 10000; index++) stats['healthy-' + index] = {total:1, correct:1, lastDate:1, updatedAt:1, dueDate:1, fsrs:{D:5,S:1,reps:1}};
            cards.forEach(card => { stats[card.id] = {total:1, correct:1, lastDate:Date.now() - 172800000, updatedAt:Date.now() - 172800000, dueDate:Date.now() - 86400000, interval:1, fsrs:{D:5,S:1,reps:1}}; });
            setCanonicalStatsStore(stats, 'filter-lifecycle-test');
            await statsPersistenceQueue;
            currentFilterMode = ['due'];
            currentSortMode = 'original';
            currentSecondarySortMode = 'none';
            document.getElementById('search-input').value = '';
            saveFilterState();
            applyFilterAndSort(false);
            window.__mkFilterTest = {resetCalls:0, initialFilter:JSON.stringify(getFilterStateForStorage()), initialRenders:ioZoomDiagnostics.cardRenders};
            const originalResetFilters = resetFilters;
            resetFilters = (...args) => { window.__mkFilterTest.resetCalls++; return originalResetFilters(...args); };
            window.__mkFilterTest.originalScheduleBackup = scheduleBackup;
            scheduleBackup = () => {};
            return {activeCount:activeDeck.length, filter:JSON.stringify(getFilterStateForStorage())};
        })()`);
        assert.deepStrictEqual(setupState, {activeCount:100, filter:'["due"]'});

        const runReviews = count => evaluate(`(async () => {
            for(let index = 0; index < ${count}; index++) await grade(2);
            await learningStatsPersistenceQueue;
            return {
                filter:JSON.stringify(getFilterStateForStorage()),
                activeCount:activeDeck.length,
                currentCard:getCurrentCardId(),
                resetCalls:window.__mkFilterTest.resetCalls,
                renders:ioZoomDiagnostics.cardRenders - window.__mkFilterTest.initialRenders,
                recorded:Object.keys(getReviewHistory()).filter(id => id.startsWith('filter-card-')).length
            };
        })()`);
        const after30 = await runReviews(30);
        assert.strictEqual(after30.filter, '["due"]');
        assert.strictEqual(after30.activeCount, 70);
        assert.strictEqual(after30.resetCalls, 0);
        assert.strictEqual(after30.recorded, 30);

        const beforeLast = await runReviews(69);
        assert.strictEqual(beforeLast.activeCount, 1, JSON.stringify(beforeLast));
        assert.strictEqual(beforeLast.filter, '["due"]');
        const afterLast = await runReviews(1);
        assert.strictEqual(afterLast.activeCount, 0);
        assert.strictEqual(afterLast.filter, '["due"]');
        assert.strictEqual(afterLast.resetCalls, 0);
        assert.strictEqual(afterLast.recorded, 100);

        const eventResult = await evaluate(`(async () => {
            const filterBefore = JSON.stringify(getFilterStateForStorage());
            const result = await applyRemoteLearningStatsEvents([{eventId:'review_999_remote_filter', source:'review', uuid:'filter-card-0', studyDate:getLearningStatsDateKey(), category:'other', deckPath:'filter__deck', timestamp:Date.now() + 1000, stat:{total:2,correct:2,lastDate:Date.now() + 1000,updatedAt:Date.now() + 1000,dueDate:Date.now() + 86400000}, historyItem:{id:'remote-filter-history',time:Date.now() + 1000,score:2}}]);
            return {filterBefore, filterAfter:JSON.stringify(getFilterStateForStorage()), activeCount:activeDeck.length, result};
        })()`);
        assert.strictEqual(eventResult.filterAfter, eventResult.filterBefore);
        assert.strictEqual(eventResult.activeCount, 0);

        const backupResult = await evaluate(`(async () => {
            const before = {inFlight:isBackupInFlight, ready:learningStatsReady, restoreState:learningStatsRestoreState, startupSync:learningStatsStartupSyncInProgress};
            scheduleBackup = window.__mkFilterTest.originalScheduleBackup;
            setLocalDataDirty(true);
            const filterBefore = JSON.stringify(getFilterStateForStorage());
            const ok = await flushBackupToFirebase(true);
            return {ok, before, after:{inFlight:isBackupInFlight, ready:learningStatsReady, restoreState:learningStatsRestoreState, startupSync:learningStatsStartupSyncInProgress}, filterBefore, filterAfter:JSON.stringify(getFilterStateForStorage()), activeCount:activeDeck.length};
        })()`);
        assert.strictEqual(backupResult.ok, true, JSON.stringify({backupResult, logs:consoleMessages.slice(-30)}));
        assert.strictEqual(backupResult.filterAfter, backupResult.filterBefore);
        assert.strictEqual(backupResult.activeCount, 0);

        await delay(3500);
        for(let attempt = 0; attempt < 100; attempt++) {
            const backupSettled = await evaluate(`backupTimer === null && !isBackupInFlight`);
            if(backupSettled) break;
            await delay(100);
        }
        const finalState = await evaluate(`({filter:JSON.stringify(getFilterStateForStorage()), activeCount:activeDeck.length, resetCalls:window.__mkFilterTest.resetCalls, recorded:Object.keys(getReviewHistory()).filter(id => id.startsWith('filter-card-')).length, backupPending:backupTimer !== null, backupInFlight:isBackupInFlight})`);
        assert.strictEqual(finalState.filter, '["due"]');
        assert.strictEqual(finalState.activeCount, 0);
        assert.strictEqual(finalState.resetCalls, 0);
        assert.strictEqual(finalState.recorded, 100);
        assert.strictEqual(finalState.backupPending, false);
        assert.strictEqual(finalState.backupInFlight, false);
        assert.strictEqual(pageNavigations, 1);
        process.stdout.write(JSON.stringify({after30, beforeLast, afterLast, eventResult, backupResult, finalState, pageNavigations, firebaseWritesIntercepted}, null, 2) + '\n');
    } finally {
        if(socket && socket.readyState === WebSocket.OPEN) socket.close();
        edge.kill();
        server.close();
        await delay(500);
        try { fs.rmSync(profilePath, {recursive:true, force:true}); } catch(error) {}
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
