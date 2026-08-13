const fs = require('node:fs');
const path = require('node:path');

const [, , sourceFile, deckFile] = process.argv;
if(!sourceFile || !deckFile) throw new Error('Usage: node scripts/backfill-pdf-source-uuid.js <logseq-page.md> <deck.txt>');

const source = fs.readFileSync(sourceFile, 'utf8');
const annotationIndex = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'pdf-annotations.json'), 'utf8')).annotations;
const directUuidsByCardId = new Map();
const lines = source.split(/\r?\n/);

for(let index = 0; index < lines.length; index++) {
    if(!/#\+BEGIN_EXTRA/i.test(lines[index])) continue;
    const uuids = [];
    let end = index + 1;
    for(; end < lines.length && !/#\+END_EXTRA/i.test(lines[end]); end++) {
        for(const match of lines[end].matchAll(/\(\(([0-9a-f-]{36})\)\)/gi)) {
            const uuid = match[1].toLowerCase();
            if(annotationIndex[uuid]?.lsType === 'annotation') uuids.push(uuid);
        }
    }
    // Some EXTRA drawers belong to a card block whose id:: property is placed
    // immediately before the drawer (instead of to following child cards).
    for(let owner = index - 1; owner >= Math.max(0, index - 4); owner--) {
        const id = (lines[owner].match(/\bid::\s*([0-9a-f-]{36})/i) || [])[1];
        if(id && uuids.length) { directUuidsByCardId.set(id.toLowerCase(), uuids.slice()); break; }
    }
    let siblingEnd = end + 1;
    while(siblingEnd < lines.length && !/#\+BEGIN_EXTRA/i.test(lines[siblingEnd]) && !/^\s*-\s+\d+\s*$/i.test(lines[siblingEnd])) {
        const id = (lines[siblingEnd].match(/\bid::\s*([0-9a-f-]{36})/i) || [])[1];
        if(id && uuids.length) directUuidsByCardId.set(id.toLowerCase(), uuids.slice());
        siblingEnd++;
    }
    index = end;
}

let changedRows = 0;
let changedOccurrences = 0;
let output = fs.readFileSync(deckFile, 'utf8').split(/\r?\n/).map(row => {
    const columns = row.split('\t');
    const cardId = String(columns[1] || '').toLowerCase();
    const uuids = directUuidsByCardId.get(cardId);
    if(!uuids || !columns[3]) return row;
    let occurrence = 0;
    const updated = columns[3].replace(/<span class=""extra-annotation""([^>]*)>/gi, (tag, attributes) => {
        const uuid = uuids[occurrence++];
        if(/data-source-uuid/i.test(attributes) || !uuid) return tag;
        changedOccurrences++;
        return `<span class=""extra-annotation"" data-source-uuid=""${uuid}"">`;
    });
    if(updated !== columns[3]) { columns[3] = updated; changedRows++; }
    return columns.join('\t');
}).join('\n');

// TSV fields may legally contain newlines. Handle those records as a second
// pass so EXTRA HTML stored in a multiline answer field is also migrated.
output = output.split(/\n(?=[^\n\t]+\t[0-9a-f-]{36}\t[0-9a-f-]{36}\t)/gi).map(record => {
    const cardId = (record.match(/^[^\n\t]+\t([0-9a-f-]{36})\t/i) || [])[1]?.toLowerCase();
    const uuids = directUuidsByCardId.get(cardId);
    if(!uuids || !/<span class=""extra-annotation""(?![^>]*data-source-uuid)/i.test(record)) return record;
    let occurrence = 0;
    const updated = record.replace(/<span class=""extra-annotation""([^>]*)>/gi, (tag, attributes) => {
        const uuid = uuids[occurrence++];
        if(/data-source-uuid/i.test(attributes) || !uuid) return tag;
        changedOccurrences++;
        return `<span class=""extra-annotation"" data-source-uuid=""${uuid}"">`;
    });
    if(updated !== record) changedRows++;
    return updated;
}).join('\n');

// Older published area annotations still retain their original UUID in the
// image filename even when the wrapper metadata was produced before this fix.
// This is an exact source identifier, not a text or positional guess.
let imageUuidRecoveries = 0;
output = output.replace(/<span class=""extra-annotation""(?![^>]*data-source-uuid)([^>]*)>/gi, (tag, attributes, offset) => {
    const contentEnd = output.indexOf('</span><br>', offset + tag.length);
    const nextWrapper = output.indexOf('<span class=""extra-annotation""', offset + tag.length);
    const end = contentEnd < 0 ? offset + tag.length + 1000 : contentEnd;
    if(nextWrapper >= 0 && nextWrapper < end) return tag;
    const imageUuid = (output.slice(offset + tag.length, end).match(/<img[^>]+?([0-9a-f-]{36})/i) || [])[1]?.toLowerCase();
    if(!imageUuid || annotationIndex[imageUuid]?.lsType !== 'annotation') return tag;
    imageUuidRecoveries++;
    return `<span class=""extra-annotation"" data-source-uuid=""${imageUuid}""${attributes}>`;
});

const verification = { expected: 0, preserved: 0, missing: 0, wrong: 0 };
for(const row of output.split(/\r?\n/)) {
    const columns = row.split('\t');
    const expected = directUuidsByCardId.get(String(columns[1] || '').toLowerCase());
    if(!expected?.length) continue;
    const wrapperCount = (String(columns[3] || '').match(/<span class=""extra-annotation""/gi) || []).length;
    const actual = Array.from(String(columns[3] || '').matchAll(/<span class=""extra-annotation""([^>]*)>/gi), match => (match[1].match(/data-source-uuid=""([0-9a-f-]{36})/i) || [])[1]?.toLowerCase() || null);
    expected.slice(0, wrapperCount).forEach((uuid, index) => {
        verification.expected++;
        if(!actual[index]) verification.missing++;
        else if(annotationIndex[actual[index]]?.lsType !== 'annotation') verification.wrong++;
        else verification.preserved++;
    });
}

if(verification.missing || verification.wrong) {
    throw new Error(`Direct UUID verification failed: ${JSON.stringify(verification)}`);
}
fs.writeFileSync(deckFile, output);
console.log(JSON.stringify({ sourceFile, deckFile, mappedCards: directUuidsByCardId.size, changedRows, changedOccurrences, imageUuidRecoveries, verification }));
