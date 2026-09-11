const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const baseline = execFileSync('git', ['show', '803513dc9a09645b5d80bf1bb4820e070a928d6d:index.html'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
});
const candidate = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const inlineScripts = Array.from(candidate.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi), match => match[1]).join('\n');
new Function(inlineScripts);

function extractFunction(source, name) {
    const markers = [`function ${name}(`, `function* ${name}(`];
    const start = markers.map(marker => source.indexOf(marker)).find(index => index >= 0);
    if (start === undefined) throw new Error(`Function not found: ${name}`);
    const next = source.indexOf('\n    function', start + 1);
    return source.slice(start, next >= 0 ? next : source.length);
}

function buildParser(source, rowParserName) {
    const cyrb53 = source.match(/const cyrb53 = .*?;\r?\n/)[0];
    const names = [
        'normalizeDetectedGraphName',
        'extractLogseqGraphNameFromText',
        rowParserName,
        'isUuid',
        'resolveCardId',
        'resolveStableLogseqCardId',
        'normalizeDeckPath',
        'processAnkiText',
        'sanitizeLogseqSystemJunk'
    ];
    const context = {
        console: { log() {}, warn() {}, error() {} },
        localStorage: { setItem() {} },
        STORAGE_KEY_LOGSEQ_GRAPH_NAME: 'unused',
        rememberLogseqGraphName() {}
    };
    vm.createContext(context);
    vm.runInContext(`${cyrb53}\n${names.map(name => extractFunction(source, name)).join('\n')}\nthis.run = processAnkiText; this.rows = ${rowParserName};`, context);
    return context;
}

const legacy = buildParser(baseline, 'parseAnkiRawData');
const streaming = buildParser(candidate, 'iterateAnkiRows');
const legacyLibrary = {};
const streamingLibrary = {};
const stats = {};
const files = fs.readdirSync(repoRoot).filter(name => name.endsWith('.txt')).sort();

for (const filename of files) {
    const text = fs.readFileSync(path.join(repoRoot, filename), 'utf8');
    legacy.run(text, filename, stats, legacyLibrary);
    streaming.run(text, filename, stats, streamingLibrary);
}

const edgeCases = [
    'deck\t"quoted\nmultiline"\t"escaped ""quote"""',
    'deck\ta\tb\r\ndeck\tc\td\r\n',
    'deck\ta\tb\rdeck\tc\td',
    '#comment\r\ndeck\tlast\trow-without-newline'
].join('\n');
assert.equal(JSON.stringify(Array.from(streaming.rows(edgeCases))), JSON.stringify(legacy.rows(edgeCases)));
assert.equal(JSON.stringify(streamingLibrary), JSON.stringify(legacyLibrary));

const deckNames = Object.keys(streamingLibrary);
const cardCount = deckNames.reduce((count, deck) => count + streamingLibrary[deck].length, 0);
process.stdout.write(JSON.stringify({ files, deckCount: deckNames.length, cardCount, differences: 0 }) + '\n');
