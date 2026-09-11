const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'decks-manifest.json'), 'utf8'));

function extractFunction(name) {
    const markers = [`function ${name}(`, `function* ${name}(`];
    const start = markers.map(marker => source.indexOf(marker)).find(index => index >= 0);
    if (start === undefined) throw new Error(`Function not found: ${name}`);
    const next = source.indexOf('\n    function', start + 1);
    return source.slice(start, next >= 0 ? next : source.length);
}

const cyrb53 = source.match(/const cyrb53 = .*?;\r?\n/)[0];
const functionNames = [
    'normalizeDetectedGraphName',
    'extractLogseqGraphNameFromText',
    'iterateAnkiRows',
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
vm.runInContext(
    `${cyrb53}\n${functionNames.map(extractFunction).join('\n')}\nthis.processDeck = processAnkiText;`,
    context
);

const library = {};
for (const filename of manifest.files) {
    const text = fs.readFileSync(path.join(repoRoot, filename), 'utf8');
    context.processDeck(text, filename, {}, library);
}

const ids = [...new Set(
    Object.values(library)
        .flat()
        .map(card => String(card && card.id || ''))
        .filter(Boolean)
)].sort();
const output = {
    version: 1,
    baselineCommit: '1289503f8123269be6f73abda16277bcb9bbd001',
    capturedAt: '2026-07-29T06:42:15.000Z',
    cardCount: ids.length,
    ids
};
fs.writeFileSync(
    path.join(repoRoot, 'today-new-baseline-v1.json'),
    `${JSON.stringify(output)}\n`
);
process.stdout.write(`${JSON.stringify({ cardCount: ids.length, files: manifest.files })}\n`);
