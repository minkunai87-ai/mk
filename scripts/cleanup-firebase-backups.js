#!/usr/bin/env node

const fs = require('node:fs');

const ROOT = 'https://mk87-66a88-default-rtdb.firebaseio.com/apps/mk';
const KEEP_COUNT = 20;
const MIN_STATS = 9000;
const MIN_RATIO = 0.8;

async function readJson(path, shallow = false) {
    const response = await fetch(`${ROOT}/${path}.json${shallow ? '?shallow=true' : ''}`);
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return response.json();
}

async function inspect() {
    const [index, payloads] = await Promise.all([readJson('backupIndex'), readJson('backups', true)]);
    const payloadIds = new Set(Object.keys(payloads || {}).filter(id => /^\d+$/.test(id)));
    const records = Object.entries(index || {})
        .filter(([id, value]) => /^\d+$/.test(id) && value && value.appId === 'mk' && payloadIds.has(id))
        .map(([id, value]) => ({ id, stats:Number(value.statsKeyCount) || 0, learning:Number(value.learningStatsEntryCount) || 0 }));
    const maxStats = records.reduce((max, row) => Math.max(max, row.stats), 0);
    const maxLearning = records.reduce((max, row) => Math.max(max, row.learning), 0);
    const keepIds = records
        .filter(row => row.stats >= MIN_STATS && row.stats >= Math.ceil(maxStats * MIN_RATIO) &&
            (!maxLearning || row.learning >= Math.ceil(maxLearning * MIN_RATIO)))
        .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, KEEP_COUNT).map(row => row.id);
    const allIds = new Set([...Object.keys(index || {}).filter(id => /^\d+$/.test(id)), ...payloadIds]);
    return { index, payloadIds, keepIds, deleteIds:[...allIds].filter(id => !keepIds.includes(id)).sort((a,b) => Number(b)-Number(a)) };
}

async function main() {
    const backupFile = process.argv[2];
    const expectedKeep = String(process.argv[3] || '').split(',').filter(Boolean);
    const apply = process.argv.includes('--apply');
    if (!backupFile || !fs.existsSync(backupFile) || fs.statSync(backupFile).size === 0) throw new Error('Verified local backup file is required');
    const saved = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    if (!saved.backupId || !saved.snapshot) throw new Error('Local backup JSON verification failed');
    const before = await inspect();
    if (before.keepIds.length !== KEEP_COUNT) throw new Error(`Expected ${KEEP_COUNT} normal backups, found ${before.keepIds.length}`);
    if (JSON.stringify(before.keepIds) !== JSON.stringify(expectedKeep)) throw new Error(`Keep IDs changed: ${before.keepIds.join(',')}`);
    const report = { apply, beforeIndex:Object.keys(before.index || {}).length, beforePayload:before.payloadIds.size, keepIds:before.keepIds, deleteCount:before.deleteIds.length };
    if (!apply) return console.log(JSON.stringify(report, null, 2));
    const updates = {};
    for (const id of before.deleteIds) {
        updates[`backups/${id}`] = null;
        updates[`backupIndex/${id}`] = null;
    }
    const response = await fetch(`${ROOT}.json`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(updates) });
    if (!response.ok) throw new Error(`PATCH cleanup: HTTP ${response.status}`);
    const after = await inspect();
    if (after.deleteIds.length || JSON.stringify(after.keepIds) !== JSON.stringify(expectedKeep) ||
        Object.keys(after.index || {}).length !== KEEP_COUNT || after.payloadIds.size !== KEEP_COUNT) {
        throw new Error('Post-cleanup verification failed');
    }
    console.log(JSON.stringify({ ...report, afterIndex:Object.keys(after.index).length, afterPayload:after.payloadIds.size, danglingIndex:0, orphanPayload:0 }, null, 2));
}

main().catch(error => { console.error(`CLEANUP_FAILED ${error.message}`); process.exitCode = 1; });
