const fs = require('fs');
const path = require('path');

const graphRoot = process.argv[2];
const outputPath = process.argv[3] || path.resolve(__dirname, '..', 'pdf-annotations.json');
if (!graphRoot) throw new Error('Usage: node generate-pdf-annotation-index.js <logseq-graph> [output]');

const assetsDir = path.join(graphRoot, 'assets');
const annotations = {};

function numberFrom(block, key) {
    const match = block.match(new RegExp(`:${key}\\s+(-?\\d+(?:\\.\\d+)?)`));
    return match ? Number(match[1]) : null;
}

for (const name of fs.readdirSync(assetsDir)) {
    if (!name.toLowerCase().endsWith('.edn')) continue;
    const pdfFileName = `${name.slice(0, -4)}.pdf`;
    if (!fs.existsSync(path.join(assetsDir, pdfFileName))) continue;
    const source = fs.readFileSync(path.join(assetsDir, name), 'utf8');
    const starts = [...source.matchAll(/\{:id\s+#uuid\s+"([0-9a-f-]{36})"/gi)];
    starts.forEach((match, index) => {
        const uuid = match[1].toLowerCase();
        const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
        const block = source.slice(match.index, end);
        const page = numberFrom(block, 'page');
        if (!Number.isFinite(page)) return;
        const x = numberFrom(block, 'x1');
        const y = numberFrom(block, 'y1');
        const x2 = numberFrom(block, 'x2');
        const y2 = numberFrom(block, 'y2');
        const sourceWidth = numberFrom(block, 'width');
        const sourceHeight = numberFrom(block, 'height');
        annotations[uuid] = {
            lsType: 'annotation',
            pdfFileName,
            page,
            x,
            y,
            width: Number.isFinite(x) && Number.isFinite(x2) ? x2 - x : null,
            height: Number.isFinite(y) && Number.isFinite(y2) ? y2 - y : null,
            sourceWidth,
            sourceHeight
        };
    });
}

const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    count: Object.keys(annotations).length,
    annotations
};
fs.writeFileSync(outputPath, `${JSON.stringify(payload)}\n`, 'utf8');
console.log(`Wrote ${payload.count} PDF annotations to ${outputPath}`);
