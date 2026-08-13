const fs = require('node:fs');
const path = require('node:path');

const graphRoot = process.argv[2] || process.env.LOGSEQ_GRAPH_ROOT;
const outputPath = process.argv[3] || path.resolve(__dirname, '..', 'pdf-annotations.json');
if (!graphRoot) throw new Error('Usage: node generate-pdf-annotation-index.js <logseq-graph> [output]');

const assetsDir = path.join(graphRoot, 'assets');
const pagesDir = path.join(graphRoot, 'pages');
const annotations = {};
const sources = [];
const normalize = value => String(value || '').normalize('NFC').toLowerCase();
const decodeFileName = value => {
    let result = String(value || '').replace(/\+/g, ' ');
    for (let attempt = 0; attempt < 3; attempt++) {
        try { const decoded = decodeURIComponent(result); if (decoded === result) break; result = decoded; } catch { break; }
    }
    return result.normalize('NFC');
};
const pdfFiles = fs.readdirSync(assetsDir).filter(name => name.toLowerCase().endsWith('.pdf'));
const pdfByNormalizedName = new Map(pdfFiles.map(name => [normalize(decodeFileName(name)), name.normalize('NFC')]));

function numberFrom(block, key) {
    const match = block.match(new RegExp(`:${key}\\s+(-?\\d+(?:\\.\\d+)?)`));
    return match ? Number(match[1]) : null;
}

function resolvePdfFileName(ednName) {
    const candidate = `${decodeFileName(ednName.slice(0, -4))}.pdf`;
    return pdfByNormalizedName.get(normalize(candidate)) || null;
}

for (const name of fs.readdirSync(assetsDir).filter(name => name.toLowerCase().endsWith('.edn')).sort()) {
    const pdfFileName = resolvePdfFileName(name);
    if (!pdfFileName) continue; // An EDN without an exact asset link is not a confirmed PDF source.
    const source = fs.readFileSync(path.join(assetsDir, name), 'utf8');
    const starts = [...source.matchAll(/\{:id\s+#uuid\s+"([0-9a-f-]{36})"/gi)];
    sources.push({ edn: name.normalize('NFC'), pdfFileName, count: starts.length });
    starts.forEach((match, index) => {
        const uuid = match[1].toLowerCase();
        const end = index + 1 < starts.length ? starts[index + 1].index : source.length;
        const block = source.slice(match.index, end);
        const page = numberFrom(block, 'page');
        if (!Number.isInteger(page) || page < 1) return;
        const x = numberFrom(block, 'x1'); const y = numberFrom(block, 'y1');
        const x2 = numberFrom(block, 'x2'); const y2 = numberFrom(block, 'y2');
        const sourceWidth = numberFrom(block, 'width'); const sourceHeight = numberFrom(block, 'height');
        annotations[uuid] = { lsType: 'annotation', sourceUuid: uuid, pdfFileName, page, annotationType: 'text',
            x, y, width: Number.isFinite(x) && Number.isFinite(x2) ? x2 - x : null,
            height: Number.isFinite(y) && Number.isFinite(y2) ? y2 - y : null, sourceWidth, sourceHeight };
    });
}

const pageUuidSet = new Set();
let annotationPageCount = 0;
if (fs.existsSync(pagesDir)) for (const name of fs.readdirSync(pagesDir).filter(name => /^hls__.*\.md$/i.test(name))) {
    const text = fs.readFileSync(path.join(pagesDir, name), 'utf8');
    const linkedPdf = (text.match(/^file-path::\s*\.\.\/assets\/(.+\.pdf)\s*$/mi) || [])[1];
    const pdfFileName = linkedPdf ? pdfByNormalizedName.get(normalize(decodeFileName(linkedPdf))) : null;
    let hasAnnotations = false;
    for (const block of text.split(/\n(?=- )/)) if (/\bls-type::\s*annotation\b/i.test(block)) {
        const uuid = (block.match(/\bid::\s*([0-9a-f-]{36})/i) || [])[1];
        const page = Number((block.match(/\bhl-page::\s*(\d+)/i) || [])[1]);
        if (!uuid) continue;
        hasAnnotations = true;
        const normalizedUuid = uuid.toLowerCase();
        pageUuidSet.add(normalizedUuid);
        const annotationType = /\bhl-type::\s*area\b/i.test(block) ? 'area' : 'text';
        if (annotations[normalizedUuid]) annotations[normalizedUuid].annotationType = annotationType;
        else if (pdfFileName && Number.isInteger(page) && page > 0) annotations[normalizedUuid] = {
            lsType: 'annotation', sourceUuid: normalizedUuid, pdfFileName, page, annotationType,
            x: null, y: null, width: null, height: null, sourceWidth: null, sourceHeight: null
        };
    }
    if (hasAnnotations) annotationPageCount++;
}
const indexUuids = Object.keys(annotations);
const payload = { schemaVersion: 2, generatedAt: new Date().toISOString(), graphRoot: path.basename(graphRoot),
    pdfFileCount: new Set(Object.values(annotations).map(value => value.pdfFileName)).size,
    annotationPageCount, ednSourceCount: sources.length, count: indexUuids.length,
    sourceAnnotationCount: indexUuids.length, sourcePageAnnotationCount: pageUuidSet.size,
    sourcePageMissingFromIndex: [...pageUuidSet].filter(uuid => !annotations[uuid]).sort(), sources, annotations };
fs.writeFileSync(outputPath, `${JSON.stringify(payload)}\n`, 'utf8');
console.log(`Wrote ${payload.count} annotations from ${payload.pdfFileCount} PDFs; page-only missing: ${payload.sourcePageMissingFromIndex.length}`);
