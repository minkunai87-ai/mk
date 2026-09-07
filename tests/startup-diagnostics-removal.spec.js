const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const repoRoot = path.resolve(__dirname, '..');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-diagnostics-removal-'));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fixture = Array.from({length:20}, (_, index) => `fixture\tquestion ${index}\tanswer ${index}`).join('\n');
const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
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
    const edge = require('node:child_process').spawn(edgePath, ['--headless','--disable-gpu','--no-first-run',`--user-data-dir=${profilePath}`,`--remote-debugging-port=${debugPort}`,'about:blank'], {stdio:'ignore',windowsHide:true});
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
        const waitForStartup=async () => { for(let attempt=0;attempt<500;attempt++) {
            const ready=await evaluate(`typeof getMkStartupTiming==='function' && getMkStartupTiming().FIRST_CARD_VISIBLE!==undefined`);
            if(ready) return;
            await delay(20);
        } throw new Error('startup timeout'); };
        await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`});
        await waitForStartup();
        const protectedBefore=await evaluate(`(() => {
            localStorage.setItem('mk_last_startup_crash_incident','legacy-incident');
            localStorage.setItem('mk_startup_failure_count','7');
            localStorage.setItem('mk_navigation_counter','19');
            sessionStorage.setItem('mk_startup_recovery_bypass_once','1');
            return {stats:localStorage.getItem(STORAGE_KEY_STATS),history:localStorage.getItem(STORAGE_KEY_REVIEW_HISTORY),filter:localStorage.getItem(STORAGE_KEY_FILTER_STATE),deck:localStorage.getItem(STORAGE_KEY_LAST_DECK),card:localStorage.getItem(STORAGE_KEY_CURRENT_CARD_ID)};
        })()`);
        await send('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html?safe=1`});
        await waitForStartup();
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
        process.stdout.write(JSON.stringify({result,firebaseRequests,navigations},null,2)+'\n');
    } finally {
        if(socket && socket.readyState === WebSocket.OPEN) socket.close();
        edge.kill(); server.close(); await delay(300);
        try { fs.rmSync(profilePath,{recursive:true,force:true}); } catch(error) {}
    }
}

main().catch(error => { console.error(error); process.exitCode=1; });
