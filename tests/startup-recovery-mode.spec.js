const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const repoRoot = path.resolve(__dirname, '..');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-recovery-'));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if(pathname === '/decks-manifest.json') return response.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({schemaVersion:1,version:'recovery-test',files:['fixture.txt']}));
    if(pathname === '/fixture.txt') return response.writeHead(200, {'Content-Type':'text/plain; charset=utf-8'}).end('fixture\tquestion\tanswer');
    const relative = pathname.replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(repoRoot, relative);
    if(!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) return response.writeHead(404).end();
    response.writeHead(200, {'Content-Type':filePath.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8'});
    fs.createReadStream(filePath).pipe(response);
});

async function main() {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = 9800 + Math.floor(Math.random() * 200);
    const edge = childProcess.spawn(edgePath, ['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${profilePath}`,`--remote-debugging-port=${port}`,'about:blank'], {stdio:'ignore',windowsHide:true});
    let socket;
    try {
        let target;
        for(let attempt=0; attempt<50 && !target; attempt++) {
            try { target=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch(error) {}
            if(!target) await delay(100);
        }
        assert(target);
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve,reject) => { socket.onopen=resolve; socket.onerror=reject; });
        let nextId=0; const pending=new Map(); let firebaseRequests=0; let navigations=0;
        const send=(method,params={}) => new Promise((resolve,reject) => {
            const id=++nextId; const timer=setTimeout(() => reject(new Error(`${method} timeout`)),15000);
            pending.set(id,message => { clearTimeout(timer); resolve(message); }); socket.send(JSON.stringify({id,method,params}));
        });
        const post=(method,params={}) => socket.send(JSON.stringify({id:++nextId,method,params}));
        socket.onmessage=event => {
            const message=JSON.parse(event.data);
            if(message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
            if(message.method === 'Page.frameNavigated' && !message.params.frame.parentId) navigations++;
            if(message.method !== 'Fetch.requestPaused') return;
            if(/firebaseio\.com/i.test(message.params.request.url)) firebaseRequests++;
            post('Fetch.fulfillRequest',{requestId:message.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from('null').toString('base64')});
        };
        await send('Runtime.enable'); await send('Page.enable');
        await send('Fetch.enable',{patterns:[{urlPattern:'*firebaseio.com/*',requestStage:'Request'}]});
        await send('Page.addScriptToEvaluateOnNewDocument',{source:`(() => {
            const kind=new URLSearchParams(location.search).get('mock');
            if(!kind || sessionStorage.getItem('mk_recovery_test_seeded') === kind) return;
            sessionStorage.setItem('mk_recovery_test_seeded',kind);
            const phase=kind === 'boot' ? 'BOOT_START' : 'FIRST_CARD_RENDER_START';
            localStorage.setItem('mk_startup_boot_marker',JSON.stringify({pageInstanceId:'mock-'+kind,phase,startupStable:false,updatedAt:Date.now(),navigation:{type:'reload'}}));
            localStorage.removeItem('mk_last_startup_crash_incident');
        })();`});
        const evaluate=async expression => {
            const response=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
            if(response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || 'evaluate failed');
            return response.result.result.value;
        };
        const navigate=async suffix => {
            const before=navigations; await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html${suffix}`});
            for(let attempt=0; attempt<150 && navigations<=before; attempt++) await delay(20);
            await send('Page.bringToFront'); await send('Page.captureScreenshot',{format:'png'});
        };
        const waitRecovery=async () => {
            for(let attempt=0; attempt<150; attempt++) {
                const state=await evaluate(`({mode:!!window.__mkStartupRecoveryMode,visible:getComputedStyle(document.getElementById('mk-startup-recovery')).display,paint:window.__mkStartupRecoveryFirstPaintMs||0,init:typeof filterResetInitAppCount==='undefined'?0:filterResetInitAppCount,renders:typeof ioZoomDiagnostics==='undefined'?0:ioZoomDiagnostics.cardRenders,pdf:typeof pdfAnnotationIndexLoadPromise==='undefined'?null:pdfAnnotationIndexLoadPromise})`);
                if(state.mode && state.visible === 'flex' && state.paint) return state;
                await delay(20);
            }
            throw new Error('recovery UI timeout');
        };

        await navigate('?mock=render');
        const renderRecovery=await waitRecovery();
        const promotedRender=await evaluate(`JSON.parse(localStorage.getItem('mk_last_startup_crash_incident'))`);
        assert.strictEqual(promotedRender.phase,'FIRST_CARD_RENDER_START');
        assert.deepStrictEqual({init:renderRecovery.init,renders:renderRecovery.renders,pdf:renderRecovery.pdf},{init:0,renders:0,pdf:null});

        await navigate('?mock=boot');
        const bootRecovery=await waitRecovery();
        const promotedBoot=await evaluate(`JSON.parse(localStorage.getItem('mk_last_startup_crash_incident'))`);
        assert.strictEqual(promotedBoot.phase,'BOOT_START');
        assert.strictEqual(bootRecovery.init,0);

        await navigate('?safe=1');
        const forcedRecovery=await waitRecovery();
        assert.strictEqual(forcedRecovery.init,0);

        await evaluate(`retryMkNormalStartup()`);
        for(let attempt=0; attempt<300; attempt++) {
            const stable=await evaluate(`typeof getMkStartupTiming==='function' && getMkStartupTiming().FIRST_CARD_VISIBLE!==undefined`);
            if(stable) break;
            await delay(20);
        }
        const retry=await evaluate(`({mode:!!window.__mkStartupRecoveryMode,init:filterResetInitAppCount,stable:JSON.parse(localStorage.getItem('mk_startup_boot_marker')).startupStable,failures:localStorage.getItem('mk_startup_failure_count')})`);
        assert.deepStrictEqual(retry,{mode:false,init:1,stable:true,failures:'0'});

        await evaluate(`localStorage.setItem('mk_startup_boot_marker',JSON.stringify({pageInstanceId:'retry-failed',phase:'BOOT_START',startupStable:false,updatedAt:Date.now()}))`);
        await send('Page.reload',{ignoreCache:true});
        const retryFailure=await waitRecovery();
        assert.strictEqual(retryFailure.init,0);
        assert.strictEqual(firebaseRequests,0);
        process.stdout.write(JSON.stringify({renderRecovery,promotedRender,bootRecovery,promotedBoot,forcedRecovery,retry,retryFailure,firebaseRequests,navigations},null,2)+'\n');
    } finally {
        if(socket && socket.readyState === WebSocket.OPEN) socket.close();
        edge.kill(); server.close(); await delay(300);
        try { fs.rmSync(profilePath,{recursive:true,force:true}); } catch(error) {}
    }
}

main().catch(error => { console.error(error); process.exitCode=1; });
