const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const externalBaseUrl = process.env.MK_TEST_BASE_URL || '';
const recoveryId = process.env.MK_RECOVERY_ID;
if(!recoveryId) throw new Error('MK_RECOVERY_ID is required for the isolated live lifecycle test');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-learning-stats-lifecycle-'));
const edgePath = process.platform === 'darwin'
    ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(fs.existsSync)
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
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
    const edge = childProcess.spawn(edgePath, [
        '--headless', '--disable-gpu', '--no-first-run', `--user-data-dir=${profilePath}`,
        '--remote-debugging-port=9336', 'about:blank'
    ], { stdio:'ignore' });
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
                const isWrite = /firebaseio\.com/i.test(request.url) && request.method !== 'GET';
                if(isWrite) {
                    blockedFirebaseWrites++;
                    send('Fetch.failRequest', {requestId:message.params.requestId, errorReason:'BlockedByClient'});
                } else send('Fetch.continueRequest', {requestId:message.params.requestId});
            }
        };
        await send('Runtime.enable');
        await send('Fetch.enable', {patterns:[{urlPattern:'*firebaseio.com/*', requestStage:'Request'}]});
        await send('Page.navigate', {url:externalBaseUrl || 'http://127.0.0.1:8879/index.html'});

        const evaluate = async expression => {
            const response = await send('Runtime.evaluate', {expression, awaitPromise:true, returnByValue:true});
            if(response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || 'browser evaluation failed');
            return response.result?.result?.value;
        };
        const snapshot = async () => evaluate(`(() => {
            if(typeof learningStatsReady === 'undefined' || !learningStatsReady) return null;
            const store = getLearningStatsStore();
            const days = store.days || {};
            return {
                total:Object.values(days).reduce((sum, day) => sum + normalizeLearningStatsDay(day).allDone.length, 0),
                dayKeys:Object.keys(days).sort(),
                testPresent:Object.values(days).some(day => normalizeLearningStatsDay(day).allDone.includes('codex-isolated-lifecycle-review'))
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
        if(initial.dayKeys.length < 7) {
            const restoreResult = await evaluate(`(async () => {
                const response = await fetch('https://mkapp-87823-default-rtdb.firebaseio.com/apps/mk/backups/${recoveryId}.json', {cache:'no-store'});
                const payload = await response.json();
                const integrity = verifyLearningStatsBackupPayloadIntegrity(payload);
                if(!integrity.ok) return {ok:false, integrity};
                return restoreLearningStatsBackupFields(payload, ['learningStats', 'favorites']);
            })()`);
            if(!restoreResult?.ok) throw new Error(`live Firebase restore failed: ${JSON.stringify(restoreResult)}`);
        }
        const restored = await waitForSnapshot(7);
        await evaluate(`recordLearningStatsReview({id:'codex-isolated-lifecycle-review', deck:'검증__격리'}, 'required')`);
        const afterReview = await snapshot();
        await send('Page.reload', {ignoreCache:true});
        const afterReload = await waitForSnapshot(7);
        await evaluate(`(async () => {
            flushBackupToFirebase = async () => ({blockedForIsolatedTest:true});
            await syncLatestFirebaseBackupOnStartup();
        })()`);
        await delay(250);
        const afterSync = await waitForSnapshot(7);
        socket.close();

        if(afterReview.total !== restored.total + 1 || !afterReview.testPresent) throw new Error(`review increment failed: ${JSON.stringify({restored, afterReview})}`);
        if(afterReload.total !== afterReview.total || !afterReload.testPresent) throw new Error(`reload persistence failed: ${JSON.stringify({afterReview, afterReload})}`);
        if(afterSync.total !== afterReload.total || !afterSync.testPresent) throw new Error(`sync persistence failed: ${JSON.stringify({afterReload, afterSync})}`);
        console.log(JSON.stringify({restored, afterReview, afterReload, afterSync, blockedFirebaseWrites}, null, 2));
    } finally {
        edge.kill();
        if(server.listening) server.close();
        await delay(300);
        fs.rmSync(profilePath, {recursive:true, force:true});
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
