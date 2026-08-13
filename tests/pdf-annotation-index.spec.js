const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const index = JSON.parse(fs.readFileSync(path.join(root, 'pdf-annotations.json'), 'utf8'));
const entries = Object.entries(index.annotations);
assert.equal(index.count, entries.length);
assert.equal(new Set(entries.map(([uuid]) => uuid)).size, entries.length, 'UUIDs must be unique');
for (const [uuid, annotation] of entries) {
    assert.match(uuid, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    assert.equal(annotation.sourceUuid, uuid);
    assert.equal(annotation.lsType, 'annotation');
    assert.ok(Number.isInteger(annotation.page) && annotation.page > 0, `${uuid}: page`);
    assert.ok(annotation.pdfFileName && annotation.pdfFileName.toLowerCase().endsWith('.pdf'), `${uuid}: PDF filename`);
}
assert.deepEqual(index.sourcePageMissingFromIndex, [], 'every hls annotation UUID must resolve');
const deckText = fs.readdirSync(root).filter(name => name.endsWith('.txt')).map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
const referenced = [...deckText.matchAll(/block-id=([0-9a-f-]{36})/gi)].map(match => match[1].toLowerCase());
const pdfReferences = referenced.filter(uuid => index.annotations[uuid]);
assert.ok(pdfReferences.length > 0, 'expected MK PDF annotation references');
console.log(JSON.stringify({ annotations: entries.length, pdfReferences: pdfReferences.length, uniquePdfReferences: new Set(pdfReferences).size }));
