const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

function extractFunction(name) {
    const markers = [`async function ${name}(`, `function ${name}(`];
    const start = markers.map(marker => source.indexOf(marker)).find(index => index >= 0);
    if (start === undefined) throw new Error(`Function not found: ${name}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`Function not closed: ${name}`);
}

const context = {
    URL,
    document: { baseURI: 'https://example.test/mk/' },
    repoOwner: 'minkunai87-ai',
    repoName: 'mk'
};
vm.createContext(context);
vm.runInContext(`${extractFunction('getManifestDeckFile')}\n${extractFunction('loadDeckFileList')}\nthis.loadDeckFileList = loadDeckFileList;`, context);

(async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'decks-manifest.json'), 'utf8'));
    const manifestCalls = [];
    const manifestResult = await context.loadDeckFileList({}, async (url) => {
        manifestCalls.push(url);
        if (url.includes('api.github.com')) throw new Error('GitHub list API must not be called');
        return { ok: true, status: 200, json: async () => manifest };
    });
    assert.equal(manifestResult.source, 'manifest');
    assert.equal(manifestCalls.length, 1);
    assert.deepEqual(Array.from(manifestResult.files, file => file.name), manifest.files);

    const fallbackCalls = [];
    const fallbackResult = await context.loadDeckFileList({}, async (url) => {
        fallbackCalls.push(url);
        if (url.includes('decks-manifest.json')) return { ok: false, status: 404 };
        return {
            ok: true,
            status: 200,
            json: async () => manifest.files.map(name => ({ name, download_url: `https://raw.example/${name}`, url: `https://api.example/${name}` }))
        };
    });
    assert.equal(fallbackResult.source, 'github-api');
    assert.equal(fallbackCalls.length, 2);
    assert.equal(fallbackResult.files.length, 2);

    process.stdout.write(JSON.stringify({
        manifestWithBlockedApi: 'passed',
        apiCallsWhenManifestSucceeds: 0,
        fallbackWhenManifestMissing: 'passed',
        files: manifest.files
    }) + '\n');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
