const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-edge-manifest-'));
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const responses = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const server = http.createServer((request, response) => {
    const relativePath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.resolve(repoRoot, relativePath);
    if (!filePath.startsWith(repoRoot) || !fs.existsSync(filePath)) {
        response.writeHead(404).end();
        return;
    }
    const type = filePath.endsWith('.json') ? 'application/json; charset=utf-8' : filePath.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
    response.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(filePath).pipe(response);
});

async function main() {
    await new Promise(resolve => server.listen(8877, '127.0.0.1', resolve));
    const edge = childProcess.spawn(edgePath, [
        '--headless', '--disable-gpu', '--no-first-run',
        `--user-data-dir=${profilePath}`, '--remote-debugging-port=9333',
        'about:blank'
    ], { stdio: 'ignore' });

    try {
        let target;
        for (let attempt = 0; attempt < 30 && !target; attempt++) {
            try {
                const targets = await (await fetch('http://127.0.0.1:9333/json/list')).json();
                target = targets.find(item => item.type === 'page');
            } catch (error) {}
            if (!target) await delay(200);
        }
        if (!target) throw new Error('Edge debugging target unavailable');

        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        let nextId = 0;
        const pending = new Map();
        socket.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.id && pending.has(message.id)) {
                pending.get(message.id)(message);
                pending.delete(message.id);
            }
            if (message.method === 'Network.responseReceived') {
                const response = message.params.response;
                if (/decks-manifest|\.txt(?:\?|$)|api\.github\.com/.test(response.url)) responses.push({ url: response.url, status: response.status });
            }
        };
        const send = (method, params = {}) => new Promise(resolve => {
            const id = ++nextId;
            pending.set(id, resolve);
            socket.send(JSON.stringify({ id, method, params }));
        });
        await send('Network.enable');
        await send('Runtime.enable');
        await send('Page.navigate', { url: 'http://127.0.0.1:8877/index.html' });

        let state;
        for (let attempt = 0; attempt < 60; attempt++) {
            await delay(500);
            const result = await send('Runtime.evaluate', {
                expression: `JSON.stringify({counter:document.getElementById('card-counter')?.innerText,question:document.getElementById('question-section')?.innerText,loading:document.getElementById('loading')?.style.display,toast:document.getElementById('toast')?.innerText,deckCount:Object.keys(library||{}).length,cardCount:Object.values(library||{}).reduce((n,c)=>n+c.length,0)})`,
                returnByValue: true
            });
            if (result.result && result.result.result && result.result.result.value) {
                state = JSON.parse(result.result.result.value);
                if (state.cardCount > 0 && state.question) break;
            }
        }
        socket.close();
        if (!state || state.deckCount !== 45 || state.cardCount !== 4485 || !state.question || state.loading !== 'none') {
            throw new Error(`Windows startup verification failed: ${JSON.stringify({ state, responses })}`);
        }
        if (responses.some(response => response.url.includes('api.github.com'))) throw new Error('GitHub list API was called despite a valid manifest');
        process.stdout.write(JSON.stringify({ state, responses }) + '\n');
    } finally {
        edge.kill();
        server.close();
        await delay(500);
        try { fs.rmSync(profilePath, { recursive: true, force: true }); } catch (error) {}
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
