#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const FIREBASE_ROOT = 'https://mkapp-87823-default-rtdb.firebaseio.com/apps/mk';
const REQUEST_TIMEOUT_MS = 60_000;
const STATS_RESTORE_ALLOW_MIN_COUNT = 9_000;
const STATS_MIN_RETAIN_RATIO = 0.8;

function firebaseUrl(parts, shallow = false) {
    const suffix = parts.length ? `/${parts.map(encodeURIComponent).join('/')}` : '';
    return `${FIREBASE_ROOT}${suffix}.json${shallow ? '?shallow=true' : ''}`;
}

async function request(parts, shallow = false) {
    const label = `/apps/mk${parts.length ? `/${parts.join('/')}` : ''}`;
    const response = await fetch(firebaseUrl(parts, shallow), {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (response.status === 413) {
        if (shallow) throw new Error(`413 while listing children: ${label}`);
        return { split: true, label };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${label}${shallow ? ' (shallow)' : ''}`);
    return { split: false, label, response };
}

async function writeChunk(stream, chunk) {
    if (!stream.write(chunk)) await once(stream, 'drain');
}

async function writeFirebasePath(stream, parts, trace) {
    const result = await request(parts);
    if (!result.split) {
        trace.readPaths.push(result.label);
        const json = await result.response.text();
        JSON.parse(json);
        await writeChunk(stream, json);
        return;
    }

    trace.split413Paths.push(result.label);
    const listingResult = await request(parts, true);
    const listing = await listingResult.response.json();
    if (!listing || typeof listing !== 'object' || Array.isArray(listing)) {
        throw new Error(`Cannot split non-object path: ${result.label}`);
    }

    const childKeys = Object.keys(listing);
    await writeChunk(stream, '{');
    for (let index = 0; index < childKeys.length; index += 1) {
        const childKey = childKeys[index];
        if (index) await writeChunk(stream, ',');
        await writeChunk(stream, JSON.stringify(childKey));
        await writeChunk(stream, ':');
        await writeFirebasePath(stream, [...parts, childKey], trace);
    }
    await writeChunk(stream, '}');
}

async function backupLatestNormalSnapshot(outputPath) {
    const indexUrl = new URL(`${FIREBASE_ROOT}/backupIndex.json`);
    indexUrl.searchParams.set('orderBy', JSON.stringify('$key'));
    indexUrl.searchParams.set('limitToLast', '50');
    const indexResponse = await fetch(indexUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!indexResponse.ok) throw new Error(`HTTP ${indexResponse.status}: /apps/mk/backupIndex`);
    const index = await indexResponse.json();
    const records = Object.entries(index || {})
        .filter(([id, metadata]) => /^\d+$/.test(id) && metadata && typeof metadata === 'object')
        .map(([id, metadata]) => ({
            id,
            metadata,
            statsKeyCount:Number(metadata.statsKeyCount) || 0,
            learningStatsEntryCount:Number(metadata.learningStatsEntryCount) || 0
        }))
        .sort((a, b) => Number(b.id) - Number(a.id));
    const learningStatsBaseline = records.reduce((max, record) => Math.max(max, record.learningStatsEntryCount), 0);
    const latest = records.find(record =>
        record.statsKeyCount >= STATS_RESTORE_ALLOW_MIN_COUNT &&
        (!learningStatsBaseline || record.learningStatsEntryCount >= Math.ceil(learningStatsBaseline * STATS_MIN_RETAIN_RATIO))
    );
    if (!latest) throw new Error('No normal backup found in backupIndex');
    const snapshotResponse = await fetch(`${FIREBASE_ROOT}/backups/${encodeURIComponent(latest.id)}.json`, {
        method: 'GET',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!snapshotResponse.ok) throw new Error(`HTTP ${snapshotResponse.status}: /apps/mk/backups/${latest.id}`);
    const snapshot = await snapshotResponse.json();
    const document = { backupId:latest.id, backupIndex:latest.metadata, snapshot };
    await fs.promises.writeFile(outputPath, JSON.stringify(document));
    const parsed = JSON.parse(await fs.promises.readFile(outputPath, 'utf8'));
    if (!parsed.snapshot || parsed.backupId !== latest.id) throw new Error('Written snapshot JSON is invalid');
    const stat = await fs.promises.stat(outputPath);
    process.stdout.write(`${JSON.stringify({ ok:true, mode:'latest-normal', orderBy:'$key', backupId:latest.id, outputPath, bytes:stat.size }, null, 2)}\n`);
}

async function main() {
    const outputArg = process.argv[2];
    if (!outputArg) throw new Error('Usage: node backup-firebase-user-data.js <output.json> [--latest-normal]');
    const outputPath = path.resolve(outputArg);
    const partialPath = `${outputPath}.partial`;
    if (fs.existsSync(outputPath) || fs.existsSync(partialPath)) throw new Error(`Output already exists: ${outputPath}`);

    if (process.argv.includes('--latest-normal')) {
        await backupLatestNormalSnapshot(outputPath);
        return;
    }

    const rootListingResult = await request([], true);
    const rootListing = await rootListingResult.response.json();
    const topLevelKeys = Object.keys(rootListing || {});
    if (!topLevelKeys.length) throw new Error('Firebase root has no top-level keys');

    const trace = { topLevelKeys, readPaths: [], split413Paths: [] };
    const stream = fs.createWriteStream(partialPath, { flags: 'wx' });
    try {
        await writeChunk(stream, '{');
        for (let index = 0; index < topLevelKeys.length; index += 1) {
            const key = topLevelKeys[index];
            if (index) await writeChunk(stream, ',');
            await writeChunk(stream, JSON.stringify(key));
            await writeChunk(stream, ':');
            await writeFirebasePath(stream, [key], trace);
        }
        await writeChunk(stream, '}');
        stream.end();
        await once(stream, 'finish');

        const partialStat = await fs.promises.stat(partialPath);
        if (partialStat.size <= 0) throw new Error('Final JSON is empty');
        await fs.promises.rename(partialPath, outputPath);
        const stat = await fs.promises.stat(outputPath);
        process.stdout.write(`${JSON.stringify({ ok: true, outputPath, bytes: stat.size, ...trace }, null, 2)}\n`);
    } catch (error) {
        stream.destroy();
        await fs.promises.rm(partialPath, { force: true });
        throw error;
    }
}

main().catch(error => {
    process.stderr.write(`BACKUP_FAILED ${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
});
