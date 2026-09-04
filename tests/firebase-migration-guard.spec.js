const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const backupScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'backup-firebase-user-data.js'), 'utf8');

function extractFunction(source, name) {
    const start = source.indexOf(`async function ${name}(`);
    assert(start >= 0, `${name} not found`);
    const bodyStart = source.indexOf(') {', start) + 2;
    assert(bodyStart > 1, `${name} body start not found`);
    let depth = 0;
    for(let index = bodyStart; index < source.length; index += 1) {
        if(source[index] === '{') depth++;
        if(source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`${name} body is incomplete`);
}

assert(html.includes('https://mk87-66a88-default-rtdb.firebaseio.com'));
assert(!html.includes('https://mkapp-87823-default-rtdb.firebaseio.com'));
assert(backupScript.includes("const FIREBASE_ROOT = 'https://mk87-66a88-default-rtdb.firebaseio.com/apps/mk';"));

const flushBody = extractFunction(html, 'flushBackupToFirebase');
const backupBody = extractFunction(html, 'performFirebaseBackup');
const ledgerBody = extractFunction(html, 'syncLearningStatsEventLedgerWithFirebase');
const conflictBody = extractFunction(html, 'appendLearningStatsConflictEventToFirebaseIfAbsent');
assert(flushBody.includes('canWriteFirebaseDuringMigration'));
assert(flushBody.indexOf('isBackupInFlight = true') < flushBody.indexOf('canWriteFirebaseDuringMigration'));
assert(backupBody.includes('upload:!options.migrationBootstrap'));
assert(backupBody.includes('getFirebaseMigrationStatus({ refresh:true })'));
assert(backupBody.includes("migrationStatus.qualifyingRecord.id !== String(data.timestamp)"));
assert(ledgerBody.includes('uploadAllowed = migrationWrite.allowed'));
assert(conflictBody.includes('canWriteFirebaseDuringMigration'));
assert(html.includes("window.addEventListener('pagehide', flushPendingBackupOnExit)"));
assert(!/method\s*:\s*['\"]DELETE['\"]/i.test(html));

let cloudIndex = {};
let platform = 'Windows';
let statsKeyCount = 13102;
const requests = [];
const context = vm.createContext({
    URL,
    Date,
    Object,
    String,
    Number,
    FIREBASE_DB_URL:'https://mk87-66a88-default-rtdb.firebaseio.com',
    FIREBASE_BACKUP_INDEX_PATH:'/apps/mk/backupIndex',
    FIREBASE_MIGRATION_MIN_STATS_COUNT:13102,
    isMkBackupRecord:value => !!(value && value.appId === 'mk'),
    isAllowedStatsRestoreCount:value => Number(value) >= 9000,
    detectPlatform:() => platform,
    getLocalStatsKeyCount:() => statsKeyCount,
    fetch:async (url, options = {}) => {
        requests.push({ url:String(url), method:options.method || 'GET' });
        return { ok:true, json:async () => cloudIndex };
    }
});
vm.runInContext(`let firebaseMigrationStatusPromise = null;\n${extractFunction(html, 'getFirebaseMigrationStatus')}\n${extractFunction(html, 'canWriteFirebaseDuringMigration')}`, context);

async function authorize(options = {}) {
    return vm.runInContext(`canWriteFirebaseDuringMigration(${JSON.stringify(options)})`, context);
}

(async () => {
    const pcStartup = await authorize({ refresh:true });
    const pcReview = await authorize();
    const pcPagehide = await authorize();
    assert.strictEqual(pcStartup.allowed, false, 'PC startup automatic write must be blocked');
    assert.strictEqual(pcReview.allowed, false, 'PC review automatic write must be blocked');
    assert.strictEqual(pcPagehide.allowed, false, 'PC pagehide automatic write must be blocked');
    assert.strictEqual(requests.filter(request => request.method !== 'GET').length, 0);

    platform = 'iPhone';
    statsKeyCount = 13101;
    const iphoneLow = await authorize({ manual:true, refresh:true });
    assert.strictEqual(iphoneLow.allowed, false);
    assert.strictEqual(iphoneLow.reason, 'insufficient_stats');

    statsKeyCount = 13102;
    const iphoneReady = await authorize({ manual:true, refresh:true });
    assert.strictEqual(iphoneReady.allowed, true);
    assert.strictEqual(iphoneReady.bootstrap, true);

    cloudIndex = {
        '1788348879067': {
            appId:'mk',
            statsKeyCount:13102,
            metadata:{ platform:'iPhone' }
        }
    };
    const completed = await vm.runInContext('getFirebaseMigrationStatus({ refresh:true })', context);
    assert.strictEqual(completed.complete, true);
    assert.strictEqual(completed.qualifyingRecord.id, '1788348879067');
    const automaticAfterMigration = await authorize();
    assert.strictEqual(automaticAfterMigration.allowed, true);
    assert.strictEqual(automaticAfterMigration.bootstrap, false);
    assert.strictEqual(requests.filter(request => request.method !== 'GET').length, 0);

    process.stdout.write(JSON.stringify({
        pcStartupWrites:0,
        pcReviewWrites:0,
        pcPagehideWrites:0,
        iphoneBelowMinimum:'blocked',
        iphoneAtMinimum:'manual-bootstrap-allowed',
        verifiedBackupId:completed.qualifyingRecord.id,
        automaticAfterMigration:'allowed',
        actualFirebaseWrites:0,
        actualFirebaseDeletes:0,
        actualFirebaseRestores:0
    }, null, 2));
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
