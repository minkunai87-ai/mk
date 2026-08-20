const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const externalBaseUrl = process.env.MK_TEST_BASE_URL || '';
const suppliedProfilePath = process.env.MK_TEST_PROFILE_PATH || '';
const localIndexOverride = process.env.MK_TEST_INDEX_OVERRIDE || '';
const recoveryId = process.env.MK_RECOVERY_ID;
const reviewPrefix = process.env.MK_TEST_REVIEW_PREFIX || 'codex-isolated-lifecycle-review';
if(!recoveryId) throw new Error('MK_RECOVERY_ID is required for the isolated live lifecycle test');
const profilePath = suppliedProfilePath || fs.mkdtempSync(path.join(os.tmpdir(), 'mk-learning-stats-lifecycle-'));
const edgePath = process.env.MK_TEST_BROWSER_PATH || (process.platform === 'darwin'
    ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(fs.existsSync)
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(repoRoot, relative);
    if(!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) return response.writeHead(404).end();
    const type = filePath.endsWith('.json') ? 'application/json; charset=utf-8' : filePath.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
    response.writeHead(200, {'Content-Type':type});
    fs.createReadStream(filePath).pipe(response);
});

async function main() {
    if(!edgePath || !fs.existsSync(edgePath)) throw new Error('Chromium browser unavailable');
    if(!externalBaseUrl) await new Promise(resolve => server.listen(8879, '127.0.0.1', resolve));
    const appUrl = externalBaseUrl || 'http://127.0.0.1:8879/index.html';
    const startTarget = process.env.MK_TEST_STANDALONE === '1' ? `--app=${appUrl}` : 'about:blank';
    const browserArgs = ['--disable-gpu', '--no-first-run', `--user-data-dir=${profilePath}`, '--remote-debugging-port=9336', startTarget];
    if(process.env.MK_TEST_HEADFUL !== '1') browserArgs.unshift('--headless');
    else browserArgs.unshift('--window-position=-32000,-32000');
    const edge = childProcess.spawn(edgePath, browserArgs, { stdio:'ignore', windowsHide:true });
    try {
        let target;
        for(let attempt = 0; attempt < 40 && !target; attempt++) {
            try { target = (await (await fetch('http://127.0.0.1:9336/json/list')).json()).find(item => item.type === 'page'); } catch(error) {}
            if(!target) await delay(200);
        }
        if(!target) throw new Error('Edge debugging target unavailable');
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let nextId = 0;
        const pending = new Map();
        const send = (method, params = {}) => new Promise(resolve => {
            const id = ++nextId;
            pending.set(id, resolve);
            socket.send(JSON.stringify({id, method, params}));
        });
        let blockedFirebaseWrites = 0;
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if(message.id && pending.has(message.id)) {
                pending.get(message.id)(message);
                pending.delete(message.id);
                return;
            }
            if(message.method === 'Fetch.requestPaused') {
                const request = message.params.request;
                const isIndexOverride = localIndexOverride && request.method === 'GET' && /^https:\/\/minkunai87-ai\.github\.io\/mk\/?(?:index\.html)?(?:[?#].*)?$/.test(request.url);
                if(isIndexOverride) {
                    send('Fetch.fulfillRequest', {
                        requestId:message.params.requestId,
                        responseCode:200,
                        responseHeaders:[{name:'Content-Type', value:'text/html; charset=utf-8'}, {name:'Cache-Control', value:'no-store'}],
                        body:fs.readFileSync(localIndexOverride).toString('base64')
                    });
                    return;
                }
                const isWrite = /firebaseio\.com/i.test(request.url) && request.method !== 'GET';
                if(isWrite) {
                    blockedFirebaseWrites++;
                    send('Fetch.failRequest', {requestId:message.params.requestId, errorReason:'BlockedByClient'});
                } else send('Fetch.continueRequest', {requestId:message.params.requestId});
            }
        };
        await send('Runtime.enable');
        const fetchPatterns = [{urlPattern:'*firebaseio.com/*', requestStage:'Request'}];
        if(localIndexOverride) fetchPatterns.push({urlPattern:'*minkunai87-ai.github.io/mk*', requestStage:'Request'});
        await send('Fetch.enable', {patterns:fetchPatterns});
        await send('Page.navigate', {url:appUrl});

        const evaluate = async expression => {
            const response = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
            if(response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || 'browser evaluation failed');
            return response.result?.result?.value;
        };
        const snapshot = async () => evaluate(`(() => {
            if(typeof learningStatsReady === 'undefined' || !learningStatsReady || (typeof learningStatsStartupSyncInProgress !== 'undefined' && learningStatsStartupSyncInProgress) || !Object.keys(typeof library === 'object' && library || {}).length) return null;
            const store = getLearningStatsStore();
            const days = store.days || {};
            return {
                appVersion:typeof APP_VERSION === 'undefined' ? null : APP_VERSION,
                standalone:window.matchMedia('(display-mode: standalone)').matches,
                restoreState:typeof learningStatsRestoreState === 'undefined' ? null : learningStatsRestoreState,
                learningStatsUpdatedAt:typeof learningStatsMemoryUpdatedAt === 'undefined' ? null : learningStatsMemoryUpdatedAt,
                favoriteCount:typeof getLearningStatsFavoriteDecks === 'function' ? getLearningStatsFavoriteDecks().length : null,
                total:Object.values(days).reduce((sum, day) => sum + normalizeLearningStatsDay(day).allDone.length, 0),
                dayKeys:Object.keys(days).sort(),
                testCount:Object.values(days).reduce((sum, day) => sum + normalizeLearningStatsDay(day).allDone.filter(id => String(id).startsWith(${JSON.stringify(reviewPrefix)} + '-')).length, 0),
                revision:typeof learningStatsMemoryRevision === 'undefined' ? null : learningStatsMemoryRevision,
                peerCount:typeof learningStatsPeerSessions === 'undefined' ? null : learningStatsPeerSessions.size
            };
        })()`);
        const waitForSnapshot = async (minimumDayKeys = 0) => {
            let value = null;
            for(let attempt = 0; attempt < 360; attempt++) {
                value = await snapshot();
                if(value && value.dayKeys.length >= minimumDayKeys) return value;
                await delay(500);
            }
            throw new Error(`learning stats cloud hydration timed out: ${JSON.stringify(value)}`);
        };

        const initial = await waitForSnapshot();
        // Defer the independently scheduled startup sync so it cannot close the write barrier
        // halfway through the intentionally uninterrupted ten-review sequence. The real sync
        // function is restored immediately after that sequence and exercised below.
        await evaluate(`(() => {
            window.__mkLifecycleOriginalStartupSync = syncLatestFirebaseBackupOnStartup;
            syncLatestFirebaseBackupOnStartup = async () => ({deferredForLifecycleReview:true});
            return true;
        })()`);
        const readSafetyCounts = async () => evaluate(`(async () => {
            await statsPersistenceQueue.catch(() => null);
            await learningStatsPersistenceQueue.catch(() => null);
            const history = parseJSONSafe(localStorage.getItem(STORAGE_KEY_REVIEW_HISTORY), {});
            const ledger = await readAllLearningStatsEvents();
            return {
                stats:getStatsKeyCount(JSON.stringify(getCanonicalStatsStore())),
                reviewHistory:Object.keys(history || {}).length,
                reviewHistoryEvents:Object.values(history || {}).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0),
                learningStats:getLearningStatsEntryCount(getLearningStatsStore()),
                favorites:getLearningStatsFavoriteDecks().length,
                ledgerEvents:ledger.length,
                conflictCorrections:ledger.filter(isLearningStatsConflictCorrectionEvent).length,
                restoreState:learningStatsRestoreState,
                ready:learningStatsReady,
                restoreMessage:document.getElementById('fb-list-ui')?.innerText || ''
            };
        })()`);
        let fullRestoreVerification = null;
        if(initial.dayKeys.length < 7 || process.env.MK_FORCE_RESTORE === '1') {
            if(process.env.MK_FORCE_FULL_RESTORE === '1') {
                const before = await readSafetyCounts();
                await evaluate(`restoreFromFirebase(${JSON.stringify(recoveryId)})`);
                const afterFirst = await readSafetyCounts();
                await evaluate(`restoreFromFirebase(${JSON.stringify(recoveryId)})`);
                const afterSecond = await readSafetyCounts();
                fullRestoreVerification = {before, afterFirst, afterSecond};
                if(afterFirst.restoreState !== 'success' || !afterFirst.ready || /Restore failed|오류가 발생|context is not defined/i.test(afterFirst.restoreMessage)) throw new Error(`full Firebase restore failed: ${JSON.stringify(fullRestoreVerification)}`);
                if(afterSecond.ledgerEvents !== afterFirst.ledgerEvents || afterSecond.conflictCorrections !== afterFirst.conflictCorrections) throw new Error(`full Firebase restore is not idempotent: ${JSON.stringify(fullRestoreVerification)}`);
                for(const key of ['stats','reviewHistory','reviewHistoryEvents','learningStats','favorites']) {
                    if(afterSecond[key] < afterFirst[key]) throw new Error(`full Firebase restore decreased ${key}: ${JSON.stringify(fullRestoreVerification)}`);
                }
                if(process.env.MK_EXPECT_COLLISION === '1' && afterFirst.conflictCorrections <= before.conflictCorrections) throw new Error(`expected live collision correction was not appended: ${JSON.stringify(fullRestoreVerification)}`);
            } else {
                const restoreResult = await evaluate(`(async () => {
                    const response = await fetch('https://mkapp-87823-default-rtdb.firebaseio.com/apps/mk/backups/${recoveryId}.json', {cache:'no-store'});
                    const payload = await response.json();
                    const integrity = verifyLearningStatsBackupPayloadIntegrity(payload);
                    if(!integrity.ok) return {ok:false, integrity};
                    return restoreLearningStatsBackupFields(payload, ['learningStats', 'favorites']);
                })()`);
                if(!restoreResult?.ok) throw new Error(`live Firebase restore failed: ${JSON.stringify(restoreResult)}`);
            }
        }
        const restored = await waitForSnapshot(7);
        const staleState = await evaluate(`({store:getLearningStatsStore(), revision:learningStatsMemoryRevision})`);
        const filterCaseResults = await evaluate(`(async () => {
            const filterCases = [
                {name:'no-filter', source:'other', required:false, fresh:false, search:'', visible:20},
                {name:'today-required', source:'required', required:true, fresh:false, search:'', visible:2},
                {name:'today-new', source:'new', required:false, fresh:true, search:'', visible:2},
                {name:'deck-filter', source:'other', required:false, fresh:false, search:'', visible:3},
                {name:'search-filter', source:'other', required:false, fresh:false, search:'codex-filter', visible:1},
                {name:'ordinary-5', source:'other', required:false, fresh:false, search:'', visible:20},
                {name:'ordinary-6', source:'other', required:false, fresh:false, search:'', visible:20},
                {name:'ordinary-7', source:'other', required:false, fresh:false, search:'', visible:20},
                {name:'ordinary-8', source:'other', required:false, fresh:false, search:'', visible:20},
                {name:'ordinary-9', source:'other', required:false, fresh:false, search:'', visible:20}
            ];
            const results = [];
            const savedActiveDeck = activeDeck.slice();
            const searchInput = document.getElementById('search-input');
            const savedSearch = searchInput ? searchInput.value : '';
            for(let index = 0; index < 10; index++) {
                const testCase = filterCases[index];
                todayEssentialState.active = testCase.required;
                todayNewState.active = testCase.fresh;
                if(searchInput) searchInput.value = testCase.search;
                const reviewedCard = {id:${JSON.stringify(reviewPrefix)} + '-' + index, deck:'filter-regression__deck'};
                activeDeck = Array.from({length:testCase.visible}, (_, visibleIndex) => visibleIndex === 0 ? reviewedCard : ({id:'visible-' + testCase.name + '-' + visibleIndex, deck:'filter-regression__deck'}));
                const before = getLearningStatsEntryCount(getLearningStatsStore());
                const dayKeysBefore = Object.keys(getLearningStatsStore().days).sort().join('|');
                recordLearningStatsReview(reviewedCard, testCase.source);
                const writeResult = await learningStatsPersistenceQueue;
                const revisionBeforeModel = learningStatsMemoryRevision;
                buildLearningStatsModel({requiredCards:testCase.required ? activeDeck : [], newCards:testCase.fresh ? activeDeck : []});
                await learningStatsPersistenceQueue;
                const after = getLearningStatsEntryCount(getLearningStatsStore());
                const ledgerCommitted = !!(writeResult && writeResult.ledgerCommitted);
                const telemetry = writeResult && writeResult.telemetry || {};
                results.push({name:testCase.name, before, after, source:ledgerCommitted ? 'append-only-event-ledger' : telemetry.WRITE_SOURCE, action:ledgerCommitted ? 'EVENT_APPENDED' : telemetry.action, currentEntryCount:ledgerCommitted ? before : telemetry.currentEntryCount, newEntryCount:ledgerCommitted ? after : telemetry.newEntryCount, removedUuidCount:ledgerCommitted ? 0 : telemetry.removedUuidCount, revision:learningStatsMemoryRevision, ledgerCommitted, cacheOk:ledgerCommitted ? writeResult.cacheOk : null, ready:learningStatsReady, restoreState:learningStatsRestoreState, startupSync:learningStatsStartupSyncInProgress, ledgerActive:learningStatsEventLedgerActive, modelRevisionChanged:learningStatsMemoryRevision !== revisionBeforeModel, dayKeysPreserved:Object.keys(getLearningStatsStore().days).sort().join('|') === dayKeysBefore});
            }
            todayEssentialState.active = false;
            todayNewState.active = false;
            activeDeck = savedActiveDeck;
            if(searchInput) searchInput.value = savedSearch;
            const deckNames = Object.keys(library || {});
            if(deckNames.length > 1) {
                const originalName = currentDeckName;
                selectDeck(deckNames[1], true);
                if(originalName && library[originalName]) selectDeck(originalName, true);
            }
            document.dispatchEvent(new Event('visibilitychange'));
            await learningStatsPersistenceQueue;
            return results;
        })()`);
        const afterReview = await waitForSnapshot(7);
        await evaluate(`(() => {
            if(window.__mkLifecycleOriginalStartupSync) syncLatestFirebaseBackupOnStartup = window.__mkLifecycleOriginalStartupSync;
            delete window.__mkLifecycleOriginalStartupSync;
            return true;
        })()`);
        const cacheFailureDurability = await evaluate(`(async () => {
            const originalCommit = commitLearningStatsCacheFromLedger;
            const before = getLearningStatsEntryCount(getLearningStatsStore());
            const card = {id:${JSON.stringify(reviewPrefix)} + '-cache-failure', deck:'failure__deck'};
            commitLearningStatsCacheFromLedger = async source => ({ok:false, ledgerKept:true, events:await readAllLearningStatsEvents(), store:buildLearningStatsStoreFromEvents(await readAllLearningStatsEvents()), reason:'injected-cache-failure'});
            recordLearningStatsReview(card, 'other');
            const writeResult = await learningStatsPersistenceQueue;
            const eventsAfterFailure = await readAllLearningStatsEvents();
            const durable = eventsAfterFailure.some(event => event.uuid === card.id);
            const cacheCountWhileFailed = getLearningStatsEntryCount(await readStatsDatabaseValue(LEARNING_STATS_DB_PRIMARY_KEY));
            commitLearningStatsCacheFromLedger = originalCommit;
            const heal = await commitLearningStatsCacheFromLedger('lifecycle-cache-failure-heal');
            return {before, ledgerCommitted:!!writeResult.ledgerCommitted, cacheOk:writeResult.cacheOk, durable, cacheCountWhileFailed, healed:heal.ok, after:getLearningStatsEntryCount(getLearningStatsStore())};
        })()`);
        const afterFailureRecovery = await waitForSnapshot(7);
        const staleWrite = await evaluate(`(async () => {
            const result = await persistLearningStatsToIndexedDBVerified(${JSON.stringify(staleState.store)}, Date.now(), 'lifecycle-stale-instance-write', {expectedRevision:${Number(staleState.revision)}});
            learningStatsMemoryStore = result.store;
            learningStatsMemoryRevision = result.revision;
            return {blockedRawWrite:result.blockedRawWrite, action:result.telemetry.action, total:getLearningStatsEntryCount(result.store), revision:result.revision};
        })()`);
        const peerTarget = await send('Target.createTarget', {url:appUrl});
        let withPeer = null;
        for(let attempt = 0; attempt < 60; attempt++) {
            withPeer = await snapshot();
            if(withPeer && withPeer.peerCount >= 1) break;
            await delay(500);
        }
        if(peerTarget.result?.targetId) await send('Target.closeTarget', {targetId:peerTarget.result.targetId});
        const reloadMarker = `mk-lifecycle-reload-${Date.now()}`;
        await evaluate(`window.__mkLifecycleReloadMarker = ${JSON.stringify(reloadMarker)}`);
        await send('Page.reload', {ignoreCache:true});
        let reloadCommitted = false;
        for(let attempt = 0; attempt < 120 && !reloadCommitted; attempt++) {
            try {
                reloadCommitted = await evaluate(`window.__mkLifecycleReloadMarker !== ${JSON.stringify(reloadMarker)} && document.readyState === 'complete'`);
            } catch(error) {}
            if(!reloadCommitted) await delay(100);
        }
        if(!reloadCommitted) throw new Error('page reload did not commit a new document');
        await evaluate(`(() => {
            window.__mkLifecycleOriginalStartupSyncAfterReload = syncLatestFirebaseBackupOnStartup;
            syncLatestFirebaseBackupOnStartup = async () => ({deferredForLifecycleManualSync:true});
            return true;
        })()`);
        const afterReload = await waitForSnapshot(7);
        if(process.env.MK_FORCE_STUDY_CLOUD === '1') {
            await evaluate(`(() => {
                const originalLoadLocalStudyState = loadLocalStudyState;
                loadLocalStudyState = () => ({...originalLoadLocalStudyState(), updatedAt:0});
            })()`);
        }
        const syncInputs = await evaluate(`(async () => {
            if(typeof getStartupCloudCandidateWithTimeout !== 'function') return null;
            const candidate = await getStartupCloudCandidateWithTimeout();
            if(!candidate) return {candidate:false};
            const localTimes = {study:Number(loadLocalStudyState().updatedAt)||0, learningStats:getLearningStatsUpdatedAt(), favorites:getLearningStatsFavoritesUpdatedAt()};
            const cloudTimes = {study:getBackupGroupUpdatedAt(candidate.payload, 'study', candidate.record.ts), learningStats:getBackupGroupUpdatedAt(candidate.payload, 'learningStats', candidate.record.ts), favorites:getBackupGroupUpdatedAt(candidate.payload, 'favorites', candidate.record.ts)};
            return {localTimes, cloudTimes, decision:getStartupSyncDecision(localTimes, cloudTimes), backupTimestamp:candidate.record.ts};
        })()`);
        const manualSync = await evaluate(`(async () => {
            if(typeof syncLatestFirebaseBackupOnStartup !== 'function') return {skipped:'startup sync already completed after reload'};
            flushBackupToFirebase = async () => ({blockedForIsolatedTest:true});
            if(window.__mkLifecycleOriginalStartupSyncAfterReload) syncLatestFirebaseBackupOnStartup = window.__mkLifecycleOriginalStartupSyncAfterReload;
            delete window.__mkLifecycleOriginalStartupSyncAfterReload;
            const beforeFavorites = getLearningStatsFavoriteDecks();
            const beforeDurableFavorites = normalizeLearningStatsFavoriteDecksBackupPayload(await readStatsDatabaseValue(LEARNING_STATS_DB_FAVORITES_KEY));
            await syncLatestFirebaseBackupOnStartup();
            const afterFavorites = getLearningStatsFavoriteDecks();
            const afterDurableFavorites = normalizeLearningStatsFavoriteDecksBackupPayload(await readStatsDatabaseValue(LEARNING_STATS_DB_FAVORITES_KEY));
            return {ok:true, beforeFavorites, beforeDurableFavorites, afterFavorites, afterDurableFavorites};
        })()`);
        await delay(250);
        const afterSync = await waitForSnapshot(7);
        socket.close();

        if(afterReview.total !== restored.total + 10 || afterReview.testCount !== 10) throw new Error(`ten-review increment failed: ${JSON.stringify({restored, filterCaseResults, afterReview})}`);
        if(filterCaseResults.some(result => result.after !== result.before + 1 || result.currentEntryCount !== result.before || result.newEntryCount !== result.after || result.removedUuidCount !== 0 || result.action === 'BLOCK_WRITE_REBASED' || (result.ledgerCommitted && !result.cacheOk) || result.modelRevisionChanged || !result.dayKeysPreserved)) throw new Error(`filter-independent delta regression failed: ${JSON.stringify(filterCaseResults)}`);
        if(!cacheFailureDurability.ledgerCommitted || cacheFailureDurability.cacheOk || !cacheFailureDurability.durable || cacheFailureDurability.cacheCountWhileFailed !== cacheFailureDurability.before || !cacheFailureDurability.healed || cacheFailureDurability.after !== cacheFailureDurability.before + 1) throw new Error(`cache failure durability failed: ${JSON.stringify(cacheFailureDurability)}`);
        if(!staleWrite.blockedRawWrite || staleWrite.total !== afterFailureRecovery.total) throw new Error(`stale overwrite protection failed: ${JSON.stringify({afterFailureRecovery, staleWrite})}`);
        if(withPeer.peerCount < 1) throw new Error(`second instance was not detected: ${JSON.stringify(withPeer)}`);
        if(afterReload.total !== afterFailureRecovery.total || afterReload.testCount !== 11) throw new Error(`reload persistence failed: ${JSON.stringify({afterFailureRecovery, afterReload})}`);
        if(afterSync.total !== afterReload.total || afterSync.testCount !== 11) throw new Error(`sync persistence failed: ${JSON.stringify({afterReload, afterSync, syncInputs, manualSync})}`);
        if(afterSync.favoriteCount !== afterReload.favoriteCount) throw new Error(`sync changed favorites: ${JSON.stringify({afterReload, afterSync, syncInputs, manualSync})}`);
        console.log(JSON.stringify({fullRestoreVerification, restored, filterCaseResults, afterReview, cacheFailureDurability, afterFailureRecovery, staleWrite, withPeer, afterReload, afterSync, syncInputs, manualSync, blockedFirebaseWrites}, null, 2));
    } finally {
        edge.kill();
        if(server.listening) server.close();
        await delay(300);
        if(!suppliedProfilePath) fs.rmSync(profilePath, {recursive:true, force:true});
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
