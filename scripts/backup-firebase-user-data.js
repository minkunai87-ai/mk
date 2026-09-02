#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');

const FIREBASE_ROOT = 'https://mkapp-87823-default-rtdb.firebaseio.com/apps/mk';
const REQUEST_TIMEOUT_MS = 60_000;

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

async function main() {
    const outputArg = process.argv[2];
    if (!outputArg) throw new Error('Usage: node backup-firebase-user-data.js <output.json>');
    const outputPath = path.resolve(outputArg);
    const partialPath = `${outputPath}.partial`;
    if (fs.existsSync(outputPath) || fs.existsSync(partialPath)) throw new Error(`Output already exists: ${outputPath}`);

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
