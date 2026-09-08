"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseArgs = parseArgs;
exports.main = main;
/**
 * Read AWS CloudFormation Exports and autogenerate ClouDNS records based on their names and values.
 * Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020-2026
 *
 * This tool can be used to autogenerate ClouDNS records for CloudFormation resources like
 * CloudFront distributions and API Gateway domains.
 *
 * CloudFormation export name must specify the resource type and record hostname as follows:
 * ClouDNS:CNAME:myhost:example:org
 *
 * CloudFormation export value must specify the record value as-is (for instance, a distribution domain name):
 * xxxxxxxxxxxxxx.cloudfront.net
 *
 * The above example will generate the following record in the ClouDNS zone example.org:
 * myhost.example.org CNAME xxxxxxxxxxxxxx.cloudfront.net
 *
 * Other resource types are also allowed (A, AAAA, ALIAS, etc).
 *
 * ## Ownership and pruning
 *
 * Every record this tool writes is stamped with a ClouDNS record note naming the tool, the stack
 * whose export produced it, and that export. The note is what makes deletion safe: a zone holds
 * plenty of records nobody here created, and without a marker there is no way to tell an orphan
 * left behind by a deleted export from something a human added by hand. Records without the marker
 * are never candidates for deletion.
 *
 * Stamping happens on every sync, so records created before this feature are adopted the next time
 * they are seen. That is safe because a record is only ever stamped when an export currently claims
 * it — the tool is already overwriting that record's value, so it already owns it.
 *
 * Pruning is opt-in and never happens by accident:
 *
 *   --prune        delete managed records whose export is gone, but only when this run actually
 *                  found exports. An empty export set is far more likely a wrong --stack or an AWS
 *                  error than a genuine instruction to delete every record.
 *   --force-prune  also prune when the export set is empty, for the real teardown case. Requires an
 *                  explicit --zone, because with no exports there is nothing to infer a zone from.
 *
 * A cap on how many records one run may delete applies to both.
 */
const client_ssm_1 = require("@aws-sdk/client-ssm");
const client_cloudformation_1 = require("@aws-sdk/client-cloudformation");
const querystring = __importStar(require("querystring"));
// Load ~/.aws/config
process.env.AWS_SDK_LOAD_CONFIG = '1';
/** Marks a record as ours. Present in the note of every record this tool manages. */
const NOTE_MARKER = 'managed-by=cloudns-cloudformation-sync';
/** Most records one run will delete before refusing. Raise with --max-prune when it is genuinely more. */
const DEFAULT_MAX_PRUNE = 10;
const USAGE = `ClouDNS CloudFormation Sync

Usage: cloudns-cloudformation-sync -u <username> -p <password-parameter> [options]
       cloudns-cloudformation-sync <username> <password-parameter> [ttl [stack...]]   (legacy)

  -u, --username <name>         ClouDNS API sub-auth-user
  -p, --password-parameter <p>  SSM parameter holding the encrypted ClouDNS API password
  -t, --ttl <seconds>           TTL for generated records (default 300)
  -s, --stack <name|arn>        Limit to this CloudFormation stack; repeatable
  -z, --zone <name>             Also scan this zone when pruning; repeatable
      --prune                   Delete managed records whose export is gone
      --force-prune             Also prune when no exports were found; requires --zone
      --max-prune <n>           Most records one run may delete (default ${DEFAULT_MAX_PRUNE})
  -n, --dry-run                 Report what would change without changing it
  -h, --help                    Show this help
  -V, --version                 Show the version

AWS_PROFILE selects the AWS credentials, as usual. DEBUG=1 prints full stack traces on error.`;
function parseArgs(argv) {
    const options = {
        username: '',
        passwordParameter: '',
        ttl: '300',
        stackNames: [],
        zoneNames: [],
        prune: false,
        forcePrune: false,
        maxPrune: DEFAULT_MAX_PRUNE,
        dryRun: false,
    };
    /**
     * Anything not starting with "-" in the first position is the old positional form:
     * <username> <password-parameter> [ttl [stack...]]. Kept working so existing deploy scripts and
     * CI jobs do not have to change in the same release that adds pruning.
     */
    if (argv.length && !argv[0].startsWith('-')) {
        options.username = argv[0];
        options.passwordParameter = argv[1] || '';
        /**
         * Options are still honoured after the positional arguments. Treating a trailing "-n" as a
         * stack name instead is how a run the caller believed was a rehearsal writes for real — which
         * is exactly what happened the first time this was tested.
         */
        const rest = argv.slice(2);
        const flagIndex = rest.findIndex((arg) => arg.startsWith('-'));
        const positional = flagIndex === -1 ? rest : rest.slice(0, flagIndex);
        if (positional[0])
            options.ttl = positional[0];
        options.stackNames = positional.slice(1);
        if (flagIndex !== -1)
            applyFlags(rest.slice(flagIndex), options);
        return options;
    }
    applyFlags(argv, options);
    return options;
}
function applyFlags(argv, options) {
    const next = (index, flag) => {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('-'))
            throw new Error(`Missing value for ${flag}`);
        return value;
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '-u':
            case '--username':
                options.username = next(i, arg);
                i++;
                break;
            case '-p':
            case '--password-parameter':
                options.passwordParameter = next(i, arg);
                i++;
                break;
            case '-t':
            case '--ttl':
                options.ttl = next(i, arg);
                i++;
                break;
            case '-s':
            case '--stack':
                options.stackNames.push(next(i, arg));
                i++;
                break;
            case '-z':
            case '--zone':
                options.zoneNames.push(next(i, arg));
                i++;
                break;
            case '--prune':
                options.prune = true;
                break;
            case '--force-prune':
                options.prune = true;
                options.forcePrune = true;
                break;
            case '--max-prune': {
                const raw = next(i, arg);
                const parsed = Number(raw);
                // Number('abc') is NaN, and `orphans.length > NaN` is false — an unvalidated value here
                // would quietly remove the cap rather than tighten it.
                if (!Number.isInteger(parsed) || parsed < 0)
                    throw new Error(`--max-prune needs a non-negative integer, got: ${raw}`);
                options.maxPrune = parsed;
                i++;
                break;
            }
            case '-n':
            case '--dry-run':
                options.dryRun = true;
                break;
            case '-h':
            case '--help':
                console.log(USAGE);
                process.exit(0);
                break;
            case '-V':
            case '--version':
                console.log(require('../package.json').version);
                process.exit(0);
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }
}
async function cloudnsRestCall(cloudnsUsername, cloudnsPassword, method, relativeUrl, queryOptions) {
    const fullUrl = 'https://api.cloudns.net' +
        relativeUrl +
        '?' +
        querystring.stringify(Object.assign({
            'sub-auth-user': cloudnsUsername,
            'auth-password': cloudnsPassword,
        }, queryOptions || {}));
    const response = await fetch(fullUrl, {
        method: method,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
    });
    if (!response.ok) {
        const errorText = await response.text();
        console.error('HTTP Error', response.status, response.statusText, errorText);
        throw new Error(errorText);
    }
    return (await response.json());
}
/**
 * ClouDNS reports failures in the body with HTTP 200, so a call is only successful if it says so.
 *
 * Treating "not the string Failed" as success is how a rejected write gets reported as done —
 * checked positively here instead.
 */
function assertSuccess(result, what) {
    const status = result === null || result === void 0 ? void 0 : result.status;
    if (status === 'Success' || status === 1 || status === '1')
        return;
    throw new Error(`${what} failed: ${(result === null || result === void 0 ? void 0 : result.statusDescription) || (result === null || result === void 0 ? void 0 : result.statusMessage) || JSON.stringify(result)}`);
}
async function autoDetectCloudnsHostAndZone(cloudnsUsername, cloudnsPassword, name, zoneCache) {
    const nameParts = name.split('.');
    // Zone and host name for xxx.tld
    const hostName1 = nameParts.slice(0, nameParts.length - 2).join('.');
    const zoneName1 = nameParts.slice(nameParts.length - 2).join('.');
    // Zone and host name for xxx.subtld.tld
    const hostName2 = nameParts.slice(0, nameParts.length - 3).join('.');
    const zoneName2 = nameParts.slice(nameParts.length - 3).join('.');
    // Check which zone exists
    const zoneResponse1 = zoneCache[zoneName1] ||
        (await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/get-zone-info.json', {
            'domain-name': zoneName1,
        }));
    zoneCache[zoneName1] = zoneResponse1;
    const zoneResponse2 = zoneCache[zoneName2] ||
        (await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/get-zone-info.json', {
            'domain-name': zoneName2,
        }));
    zoneCache[zoneName2] = zoneResponse2;
    const zoneName = zoneResponse1.status === '1' ? zoneName1 : zoneResponse2.status === '1' ? zoneName2 : '';
    const hostName = zoneResponse1.status === '1' ? hostName1 : zoneResponse2.status === '1' ? hostName2 : '';
    if (!zoneName) {
        // Neither zone exists
        throw new Error('Zone Not Found: ' + name);
    }
    return {
        hostName: hostName,
        zoneName: zoneName,
    };
}
/**
 * Every record in a zone, notes included. Also the basis for finding orphans.
 *
 * Cached per run: looking a record up and then verifying it used to cost two whole-zone calls each,
 * so twenty exports meant forty listings against an API that rate limits. Any write invalidates the
 * zone, and verification always reads fresh, so a cached listing is never used to judge something
 * that has just changed.
 */
const zoneRecordsCache = new Map();
async function listZoneRecords(cloudnsUsername, cloudnsPassword, zoneName, fresh = false) {
    if (!fresh) {
        const cached = zoneRecordsCache.get(zoneName);
        if (cached)
            return cached;
    }
    const response = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/records.json', {
        'domain-name': zoneName,
        'include-notes': '1',
    });
    // An empty zone comes back as an empty array rather than an empty object.
    const records = !response || Array.isArray(response) ? [] : Object.values(response);
    zoneRecordsCache.set(zoneName, records);
    return records;
}
function ownershipNote(stackName, exportName) {
    return `${NOTE_MARKER} stack=${stackName} export=${exportName}`;
}
/** The stack named in a record's note, or undefined when the record is not ours. */
function noteStackName(record) {
    if (!record.note || record.note.indexOf(NOTE_MARKER) === -1)
        return undefined;
    const match = /stack=(\S+)/.exec(record.note);
    return match ? match[1] : '';
}
async function setRecordNote(cloudnsUsername, cloudnsPassword, zoneName, recordId, note, dryRun) {
    if (dryRun)
        return;
    const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/set-record-note.json', {
        'domain-name': zoneName,
        'record-id': recordId,
        note: note,
    });
    assertSuccess(result, 'Set record note');
    zoneRecordsCache.delete(zoneName);
}
async function createOrUpdateCloudnsResource(cloudnsUsername, cloudnsPassword, desired, ttlValue, dryRun) {
    var _a;
    const { zoneName, hostName, type, value } = desired;
    const name = hostName ? `${hostName}.${zoneName}` : zoneName;
    const records = await listZoneRecords(cloudnsUsername, cloudnsPassword, zoneName);
    /**
     * Match on host and type across the whole zone rather than trusting a filtered query's first
     * entry. Taking whichever record happened to come back first meant that a host with more than one
     * record of a type had one of them updated at random while the other kept serving traffic.
     */
    const matching = records.filter((record) => record.host === hostName && record.type === type);
    if (matching.length > 1) {
        console.warn('WARN', name, type, 'has', matching.length, 'records; updating the first and leaving the rest');
    }
    const existingRecord = matching[0];
    const note = ownershipNote(desired.stackName, desired.exportName);
    if (existingRecord && existingRecord.record === value && String(existingRecord.ttl) === String(ttlValue)) {
        if (existingRecord.note === note) {
            console.log('OK', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName);
        }
        else {
            // Adopts records created before ownership notes existed, and repairs a note that drifted.
            console.log('ADOPT', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName);
            await setRecordNote(cloudnsUsername, cloudnsPassword, zoneName, existingRecord.id, note, dryRun);
        }
        return;
    }
    if (existingRecord) {
        console.log('UPDATE', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName);
        if (!dryRun) {
            const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/mod-record.json', {
                'domain-name': zoneName,
                'record-id': existingRecord.id,
                host: hostName,
                'record-type': type,
                record: value,
                ttl: ttlValue,
            });
            assertSuccess(result, 'Modify record');
            await setRecordNote(cloudnsUsername, cloudnsPassword, zoneName, existingRecord.id, note, dryRun);
            await verifyRecord(cloudnsUsername, cloudnsPassword, desired, ttlValue);
        }
        return;
    }
    console.log('CREATE', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName);
    if (dryRun)
        return;
    const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/add-record.json', {
        'domain-name': zoneName,
        host: hostName,
        'record-type': type,
        record: value,
        ttl: ttlValue,
    });
    assertSuccess(result, 'Add record');
    const createdId = (_a = result === null || result === void 0 ? void 0 : result.data) === null || _a === void 0 ? void 0 : _a.id;
    if (createdId)
        await setRecordNote(cloudnsUsername, cloudnsPassword, zoneName, String(createdId), note, dryRun);
    await verifyRecord(cloudnsUsername, cloudnsPassword, desired, ttlValue);
}
/**
 * Reads the record back and complains if it is not what was just written.
 *
 * Without this the log reports intent rather than outcome, which is how a cutover that never
 * happened can look like a clean run. Note this confirms the stored record only — ClouDNS resolves
 * ALIAS targets on its own schedule, so what the zone *serves* can lag the record by a long way.
 */
async function verifyRecord(cloudnsUsername, cloudnsPassword, desired, ttlValue) {
    const records = await listZoneRecords(cloudnsUsername, cloudnsPassword, desired.zoneName, true);
    const stored = records.find((record) => record.host === desired.hostName && record.type === desired.type);
    if (!stored) {
        throw new Error(`Verification failed: ${desired.hostName}.${desired.zoneName} ${desired.type} is missing after write`);
    }
    if (stored.record !== desired.value || String(stored.ttl) !== String(ttlValue)) {
        throw new Error(`Verification failed: ${desired.hostName}.${desired.zoneName} ${desired.type} is ${stored.record} (ttl ${stored.ttl}), expected ${desired.value} (ttl ${ttlValue})`);
    }
}
/**
 * Deletes managed records whose export no longer exists.
 *
 * Only records carrying this tool's note are considered, and when --stack was given only those
 * whose note names one of those stacks — otherwise syncing one stack would delete the records of
 * another.
 */
async function pruneOrphans(cloudnsUsername, cloudnsPassword, zoneNames, desired, stackScope, options) {
    const desiredKeys = new Set(desired.map((record) => `${record.zoneName}|${record.hostName}|${record.type}`));
    const orphans = [];
    for (const zoneName of zoneNames) {
        for (const record of await listZoneRecords(cloudnsUsername, cloudnsPassword, zoneName, true)) {
            const stack = noteStackName(record);
            if (stack === undefined)
                continue; // not ours
            if (stackScope && !stackScope.has(stack))
                continue; // another stack's
            if (desiredKeys.has(`${zoneName}|${record.host}|${record.type}`))
                continue; // still wanted
            orphans.push({ zoneName, record });
        }
    }
    if (!orphans.length) {
        console.log('PRUNE none');
        return;
    }
    for (const { zoneName, record } of orphans) {
        const name = record.host ? `${record.host}.${zoneName}` : zoneName;
        console.log(options.dryRun ? 'WOULD PRUNE' : 'PRUNE', name, record.type, record.record, 'ZONE', zoneName);
    }
    const overCap = orphans.length > options.maxPrune;
    if (options.dryRun) {
        if (overCap)
            console.warn('WARN', `A real run would refuse: ${orphans.length} records exceeds --max-prune ${options.maxPrune}`);
        return;
    }
    if (overCap) {
        throw new Error(`Refusing to delete ${orphans.length} records in one run (limit ${options.maxPrune}); raise --max-prune if this is intended`);
    }
    for (const { zoneName, record } of orphans) {
        const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/delete-record.json', {
            'domain-name': zoneName,
            'record-id': record.id,
        });
        assertSuccess(result, 'Delete record');
    }
}
async function main() {
    var _a, _b, _c;
    // Parsed before the banner so --version and --help print only what a caller asked for.
    const options = parseArgs(process.argv.slice(2));
    console.log('ClouDNS CloudFormation Sync by Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020-2026');
    if (!options.username || !options.passwordParameter) {
        console.error(USAGE);
        process.exit(1);
    }
    if (options.forcePrune && !options.zoneNames.length) {
        console.error('--force-prune needs at least one --zone: with no exports there is nothing to infer a zone from');
        process.exit(1);
    }
    const ssm = new client_ssm_1.SSMClient({});
    const zoneCache = {};
    const response = await ssm.send(new client_ssm_1.GetParameterCommand({
        Name: options.passwordParameter,
        WithDecryption: true,
    }));
    const cloudnsPassword = ((_a = response.Parameter) === null || _a === void 0 ? void 0 : _a.Value) || '';
    // Collect everything the exports ask for before writing anything, so pruning can compare against
    // the complete picture rather than against whatever has been processed so far.
    const desired = [];
    /** Every spelling of a stack that matched, so --stack can be given as a name or a full ARN. */
    const matchedStacks = new Set();
    /** Short names only, which is the form ownership notes carry, so pruning can be scoped by them. */
    const matchedStackNames = new Set();
    const cloudFormation = new client_cloudformation_1.CloudFormationClient({});
    let nextToken;
    do {
        const response = await cloudFormation.send(new client_cloudformation_1.ListExportsCommand({ NextToken: nextToken }));
        for (const exportObj of response.Exports || []) {
            const stackMatch = (_b = exportObj.ExportingStackId) === null || _b === void 0 ? void 0 : _b.match(/^arn:[^:]+:cloudformation:[^:]+:[^:]+:stack\/([^/]+)\//);
            const stackName = stackMatch ? stackMatch[1] : exportObj.ExportingStackId || '';
            if (options.stackNames.length && !options.stackNames.includes(exportObj.ExportingStackId || '') && !options.stackNames.includes(stackName)) {
                continue;
            }
            if (!((_c = exportObj.Name) === null || _c === void 0 ? void 0 : _c.match(/^ClouDNS:/)))
                continue;
            const nameParts = exportObj.Name.split(':');
            const resourceType = nameParts[1];
            const resourceName = nameParts.slice(2).join('.');
            const { zoneName, hostName } = await autoDetectCloudnsHostAndZone(options.username, cloudnsPassword, resourceName, zoneCache);
            matchedStacks.add(stackName);
            matchedStackNames.add(stackName);
            if (exportObj.ExportingStackId)
                matchedStacks.add(exportObj.ExportingStackId);
            desired.push({
                zoneName,
                hostName,
                type: resourceType,
                value: exportObj.Value,
                stackName,
                exportName: exportObj.Name,
            });
        }
        nextToken = response.NextToken;
    } while (nextToken);
    /**
     * A --stack that matched nothing is nearly always a typo or a stack that has not deployed yet.
     * It used to pass silently as a no-op; with --prune the same condition would look like "every
     * record is an orphan", so it is fatal there and a warning otherwise.
     *
     * --force-prune is the exception: a torn-down stack producing no exports is precisely the case it
     * exists for, and the caller has already had to name the zone explicitly to get this far.
     */
    for (const stackName of options.stackNames) {
        if (!matchedStacks.has(stackName)) {
            const message = `Stack ${stackName} produced no ClouDNS exports`;
            if (options.prune && !options.forcePrune)
                throw new Error(`${message}; refusing to prune on an unverified stack name`);
            console.warn('WARN', message);
        }
    }
    for (const record of desired) {
        await createOrUpdateCloudnsResource(options.username, cloudnsPassword, record, options.ttl, options.dryRun);
    }
    if (!options.prune)
        return;
    if (!desired.length && !options.forcePrune) {
        console.warn('WARN No exports matched, so nothing is known to be wanted; skipping prune. Use --force-prune with --zone if this is a teardown.');
        return;
    }
    const zoneNames = [...new Set([...options.zoneNames, ...desired.map((record) => record.zoneName)])];
    /**
     * Notes record the short stack name, so scoping on the raw --stack values would silently prune
     * nothing when one was given as an ARN. Both spellings go in: the resolved names cover the ARN
     * case, and the raw values cover --force-prune, where a torn-down stack resolves to nothing.
     */
    const stackScope = options.stackNames.length ? new Set([...matchedStackNames, ...options.stackNames]) : undefined;
    await pruneOrphans(options.username, cloudnsPassword, zoneNames, desired, stackScope, options);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXVDRztBQUNILG9EQUFvRTtBQUNwRSwwRUFBNEc7QUFDNUcsTUFBWSxXQUFXLHdDQUFtQjtBQUUxQyxxQkFBcUI7QUFDckIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsR0FBRyxHQUFHLENBQUE7QUFFckMscUZBQXFGO0FBQ3JGLE1BQU0sV0FBVyxHQUFHLHdDQUF3QyxDQUFBO0FBRTVELDBHQUEwRztBQUMxRyxNQUFNLGlCQUFpQixHQUFHLEVBQUUsQ0FBQTtBQWtDNUIsTUFBTSxLQUFLLEdBQUc7Ozs7Ozs7Ozs7OzsyRUFZNkQsaUJBQWlCOzs7Ozs4RkFLRSxDQUFBO0FBRTlGLG1CQUEwQixJQUFjO0lBQ3RDLE1BQU0sT0FBTyxHQUFZO1FBQ3ZCLFFBQVEsRUFBRSxFQUFFO1FBQ1osaUJBQWlCLEVBQUUsRUFBRTtRQUNyQixHQUFHLEVBQUUsS0FBSztRQUNWLFVBQVUsRUFBRSxFQUFFO1FBQ2QsU0FBUyxFQUFFLEVBQUU7UUFDYixLQUFLLEVBQUUsS0FBSztRQUNaLFVBQVUsRUFBRSxLQUFLO1FBQ2pCLFFBQVEsRUFBRSxpQkFBaUI7UUFDM0IsTUFBTSxFQUFFLEtBQUs7S0FDZCxDQUFBO0lBRUQ7Ozs7T0FJRztJQUNILElBQUksSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUM1QyxPQUFPLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQTtRQUMxQixPQUFPLENBQUMs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SCxNQUFNLFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFFLGVBQWUsRUFBRSxTQUFTLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxPQUFPLENBQUMsQ0FBQTtBQUNoRyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZWFkIEFXUyBDbG91ZEZvcm1hdGlvbiBFeHBvcnRzIGFuZCBhdXRvZ2VuZXJhdGUgQ2xvdUROUyByZWNvcmRzIGJhc2VkIG9uIHRoZWlyIG5hbWVzIGFuZCB2YWx1ZXMuXG4gKiBLZW5uZXRoIEZhbGNrIDxrZW5udUBjbG91ZGVuLm5ldD4gKEMpIENsb3VkZW4gT3kgMjAyMC0yMDI2XG4gKlxuICogVGhpcyB0b29sIGNhbiBiZSB1c2VkIHRvIGF1dG9nZW5lcmF0ZSBDbG91RE5TIHJlY29yZHMgZm9yIENsb3VkRm9ybWF0aW9uIHJlc291cmNlcyBsaWtlXG4gKiBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbnMgYW5kIEFQSSBHYXRld2F5IGRvbWFpbnMuXG4gKlxuICogQ2xvdWRGb3JtYXRpb24gZXhwb3J0IG5hbWUgbXVzdCBzcGVjaWZ5IHRoZSByZXNvdXJjZSB0eXBlIGFuZCByZWNvcmQgaG9zdG5hbWUgYXMgZm9sbG93czpcbiAqIENsb3VETlM6Q05BTUU6bXlob3N0OmV4YW1wbGU6b3JnXG4gKlxuICogQ2xvdWRGb3JtYXRpb24gZXhwb3J0IHZhbHVlIG11c3Qgc3BlY2lmeSB0aGUgcmVjb3JkIHZhbHVlIGFzLWlzIChmb3IgaW5zdGFuY2UsIGEgZGlzdHJpYnV0aW9uIGRvbWFpbiBuYW1lKTpcbiAqIHh4eHh4eHh4eHh4eHh4LmNsb3VkZnJvbnQubmV0XG4gKlxuICogVGhlIGFib3ZlIGV4YW1wbGUgd2lsbCBnZW5lcmF0ZSB0aGUgZm9sbG93aW5nIHJlY29yZCBpbiB0aGUgQ2xvdUROUyB6b25lIGV4YW1wbGUub3JnOlxuICogbXlob3N0LmV4YW1wbGUub3JnIENOQU1FIHh4eHh4eHh4eHh4eHh4LmNsb3VkZnJvbnQubmV0XG4gKlxuICogT3RoZXIgcmVzb3VyY2UgdHlwZXMgYXJlIGFsc28gYWxsb3dlZCAoQSwgQUFBQSwgQUxJQVMsIGV0YykuXG4gKlxuICogIyMgT3duZXJzaGlwIGFuZCBwcnVuaW5nXG4gKlxuICogRXZlcnkgcmVjb3JkIHRoaXMgdG9vbCB3cml0ZXMgaXMgc3RhbXBlZCB3aXRoIGEgQ2xvdUROUyByZWNvcmQgbm90ZSBuYW1pbmcgdGhlIHRvb2wsIHRoZSBzdGFja1xuICogd2hvc2UgZXhwb3J0IHByb2R1Y2VkIGl0LCBhbmQgdGhhdCBleHBvcnQuIFRoZSBub3RlIGlzIHdoYXQgbWFrZXMgZGVsZXRpb24gc2FmZTogYSB6b25lIGhvbGRzXG4gKiBwbGVudHkgb2YgcmVjb3JkcyBub2JvZHkgaGVyZSBjcmVhdGVkLCBhbmQgd2l0aG91dCBhIG1hcmtlciB0aGVyZSBpcyBubyB3YXkgdG8gdGVsbCBhbiBvcnBoYW5cbiAqIGxlZnQgYmVoaW5kIGJ5IGEgZGVsZXRlZCBleHBvcnQgZnJvbSBzb21ldGhpbmcgYSBodW1hbiBhZGRlZCBieSBoYW5kLiBSZWNvcmRzIHdpdGhvdXQgdGhlIG1hcmtlclxuICogYXJlIG5ldmVyIGNhbmRpZGF0ZXMgZm9yIGRlbGV0aW9uLlxuICpcbiAqIFN0YW1waW5nIGhhcHBlbnMgb24gZXZlcnkgc3luYywgc28gcmVjb3JkcyBjcmVhdGVkIGJlZm9yZSB0aGlzIGZlYXR1cmUgYXJlIGFkb3B0ZWQgdGhlIG5leHQgdGltZVxuICogdGhleSBhcmUgc2Vlbi4gVGhhdCBpcyBzYWZlIGJlY2F1c2UgYSByZWNvcmQgaXMgb25seSBldmVyIHN0YW1wZWQgd2hlbiBhbiBleHBvcnQgY3VycmVudGx5IGNsYWltc1xuICogaXQg4oCUIHRoZSB0b29sIGlzIGFscmVhZHkgb3ZlcndyaXRpbmcgdGhhdCByZWNvcmQncyB2YWx1ZSwgc28gaXQgYWxyZWFkeSBvd25zIGl0LlxuICpcbiAqIFBydW5pbmcgaXMgb3B0LWluIGFuZCBuZXZlciBoYXBwZW5zIGJ5IGFjY2lkZW50OlxuICpcbiAqICAgLS1wcnVuZSAgICAgICAgZGVsZXRlIG1hbmFnZWQgcmVjb3JkcyB3aG9zZSBleHBvcnQgaXMgZ29uZSwgYnV0IG9ubHkgd2hlbiB0aGlzIHJ1biBhY3R1YWxseVxuICogICAgICAgICAgICAgICAgICBmb3VuZCBleHBvcnRzLiBBbiBlbXB0eSBleHBvcnQgc2V0IGlzIGZhciBtb3JlIGxpa2VseSBhIHdyb25nIC0tc3RhY2sgb3IgYW4gQVdTXG4gKiAgICAgICAgICAgICAgICAgIGVycm9yIHRoYW4gYSBnZW51aW5lIGluc3RydWN0aW9uIHRvIGRlbGV0ZSBldmVyeSByZWNvcmQuXG4gKiAgIC0tZm9yY2UtcHJ1bmUgIGFsc28gcHJ1bmUgd2hlbiB0aGUgZXhwb3J0IHNldCBpcyBlbXB0eSwgZm9yIHRoZSByZWFsIHRlYXJkb3duIGNhc2UuIFJlcXVpcmVzIGFuXG4gKiAgICAgICAgICAgICAgICAgIGV4cGxpY2l0IC0tem9uZSwgYmVjYXVzZSB3aXRoIG5vIGV4cG9ydHMgdGhlcmUgaXMgbm90aGluZyB0byBpbmZlciBhIHpvbmUgZnJvbS5cbiAqXG4gKiBBIGNhcCBvbiBob3cgbWFueSByZWNvcmRzIG9uZSBydW4gbWF5IGRlbGV0ZSBhcHBsaWVzIHRvIGJvdGguXG4gKi9cbmltcG9ydCB7IFNTTUNsaWVudCwgR2V0UGFyYW1ldGVyQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zc20nXG5pbXBvcnQgeyBDbG91ZEZvcm1hdGlvbkNsaWVudCwgTGlzdEV4cG9ydHNDb21tYW5kLCBMaXN0RXhwb3J0c091dHB1dCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1jbG91ZGZvcm1hdGlvbidcbmltcG9ydCAqIGFzIHF1ZXJ5c3RyaW5nIGZyb20gJ3F1ZXJ5c3RyaW5nJ1xuXG4vLyBMb2FkIH4vLmF3cy9jb25maWdcbnByb2Nlc3MuZW52LkFXU19TREtfTE9BRF9DT05GSUcgPSAnMSdcblxuLyoqIE1hcmtzIGEgcmVjb3JkIGFzIG91cnMuIFByZXNlbnQgaW4gdGhlIG5vdGUgb2YgZXZlcnkgcmVjb3JkIHRoaXMgdG9vbCBtYW5hZ2VzLiAqL1xuY29uc3QgTk9URV9NQVJLRVIgPSAnbWFuYWdlZC1ieT1jbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMnXG5cbi8qKiBNb3N0IHJlY29yZHMgb25lIHJ1biB3aWxsIGRlbGV0ZSBiZWZvcmUgcmVmdXNpbmcuIFJhaXNlIHdpdGggLS1tYXgtcHJ1bmUgd2hlbiBpdCBpcyBnZW51aW5lbHkgbW9yZS4gKi9cbmNvbnN0IERFRkFVTFRfTUFYX1BSVU5FID0gMTBcblxudHlwZSBDbG91ZG5zUmVzdENhbGxSZXNwb25zZSA9IGFueVxuXG5pbnRlcmZhY2UgT3B0aW9ucyB7XG4gIHVzZXJuYW1lOiBzdHJpbmdcbiAgcGFzc3dvcmRQYXJhbWV0ZXI6IHN0cmluZ1xuICB0dGw6IHN0cmluZ1xuICBzdGFja05hbWVzOiBzdHJpbmdbXVxuICB6b25lTmFtZXM6IHN0cmluZ1tdXG4gIHBydW5lOiBib29sZWFuXG4gIGZvcmNlUHJ1bmU6IGJvb2xlYW5cbiAgbWF4UHJ1bmU6IG51bWJlclxuICBkcnlSdW46IGJvb2xlYW5cbn1cblxuaW50ZXJmYWNlIERlc2lyZWRSZWNvcmQge1xuICB6b25lTmFtZTogc3RyaW5nXG4gIGhvc3ROYW1lOiBzdHJpbmdcbiAgdHlwZTogc3RyaW5nXG4gIHZhbHVlOiBzdHJpbmdcbiAgc3RhY2tOYW1lOiBzdHJpbmdcbiAgZXhwb3J0TmFtZTogc3RyaW5nXG59XG5cbmludGVyZmFjZSBDbG91ZG5zUmVjb3JkIHtcbiAgaWQ6IHN0cmluZ1xuICBob3N0OiBzdHJpbmdcbiAgdHlwZTogc3RyaW5nXG4gIHR0bDogc3RyaW5nXG4gIHJlY29yZDogc3RyaW5nXG4gIG5vdGU/OiBzdHJpbmdcbn1cblxuY29uc3QgVVNBR0UgPSBgQ2xvdUROUyBDbG91ZEZvcm1hdGlvbiBTeW5jXG5cblVzYWdlOiBjbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMgLXUgPHVzZXJuYW1lPiAtcCA8cGFzc3dvcmQtcGFyYW1ldGVyPiBbb3B0aW9uc11cbiAgICAgICBjbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMgPHVzZXJuYW1lPiA8cGFzc3dvcmQtcGFyYW1ldGVyPiBbdHRsIFtzdGFjay4uLl1dICAgKGxlZ2FjeSlcblxuICAtdSwgLS11c2VybmFtZSA8bmFtZT4gICAgICAgICBDbG91RE5TIEFQSSBzdWItYXV0aC11c2VyXG4gIC1wLCAtLXBhc3N3b3JkLXBhcmFtZXRlciA8cD4gIFNTTSBwYXJhbWV0ZXIgaG9sZGluZyB0aGUgZW5jcnlwdGVkIENsb3VETlMgQVBJIHBhc3N3b3JkXG4gIC10LCAtLXR0bCA8c2Vjb25kcz4gICAgICAgICAgIFRUTCBmb3IgZ2VuZXJhdGVkIHJlY29yZHMgKGRlZmF1bHQgMzAwKVxuICAtcywgLS1zdGFjayA8bmFtZXxhcm4+ICAgICAgICBMaW1pdCB0byB0aGlzIENsb3VkRm9ybWF0aW9uIHN0YWNrOyByZXBlYXRhYmxlXG4gIC16LCAtLXpvbmUgPG5hbWU+ICAgICAgICAgICAgIEFsc28gc2NhbiB0aGlzIHpvbmUgd2hlbiBwcnVuaW5nOyByZXBlYXRhYmxlXG4gICAgICAtLXBydW5lICAgICAgICAgICAgICAgICAgIERlbGV0ZSBtYW5hZ2VkIHJlY29yZHMgd2hvc2UgZXhwb3J0IGlzIGdvbmVcbiAgICAgIC0tZm9yY2UtcHJ1bmUgICAgICAgICAgICAgQWxzbyBwcnVuZSB3aGVuIG5vIGV4cG9ydHMgd2VyZSBmb3VuZDsgcmVxdWlyZXMgLS16b25lXG4gICAgICAtLW1heC1wcnVuZSA8bj4gICAgICAgICAgIE1vc3QgcmVjb3JkcyBvbmUgcnVuIG1heSBkZWxldGUgKGRlZmF1bHQgJHtERUZBVUxUX01BWF9QUlVORX0pXG4gIC1uLCAtLWRyeS1ydW4gICAgICAgICAgICAgICAgIFJlcG9ydCB3aGF0IHdvdWxkIGNoYW5nZSB3aXRob3V0IGNoYW5naW5nIGl0XG4gIC1oLCAtLWhlbHAgICAgICAgICAgICAgICAgICAgIFNob3cgdGhpcyBoZWxwXG4gIC1WLCAtLXZlcnNpb24gICAgICAgICAgICAgICAgIFNob3cgdGhlIHZlcnNpb25cblxuQVdTX1BST0ZJTEUgc2VsZWN0cyB0aGUgQVdTIGNyZWRlbnRpYWxzLCBhcyB1c3VhbC4gREVCVUc9MSBwcmludHMgZnVsbCBzdGFjayB0cmFjZXMgb24gZXJyb3IuYFxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VBcmdzKGFyZ3Y6IHN0cmluZ1tdKTogT3B0aW9ucyB7XG4gIGNvbnN0IG9wdGlvbnM6IE9wdGlvbnMgPSB7XG4gICAgdXNlcm5hbWU6ICcnLFxuICAgIHBhc3N3b3JkUGFyYW1ldGVyOiAnJyxcbiAgICB0dGw6ICczMDAnLFxuICAgIHN0YWNrTmFtZXM6IFtdLFxuICAgIHpvbmVOYW1lczogW10sXG4gICAgcHJ1bmU6IGZhbHNlLFxuICAgIGZvcmNlUHJ1bmU6IGZhbHNlLFxuICAgIG1heFBydW5lOiBERUZBVUxUX01BWF9QUlVORSxcbiAgICBkcnlSdW46IGZhbHNlLFxuICB9XG5cbiAgLyoqXG4gICAqIEFueXRoaW5nIG5vdCBzdGFydGluZyB3aXRoIFwiLVwiIGluIHRoZSBmaXJzdCBwb3NpdGlvbiBpcyB0aGUgb2xkIHBvc2l0aW9uYWwgZm9ybTpcbiAgICogPHVzZXJuYW1lPiA8cGFzc3dvcmQtcGFyYW1ldGVyPiBbdHRsIFtzdGFjay4uLl1dLiBLZXB0IHdvcmtpbmcgc28gZXhpc3RpbmcgZGVwbG95IHNjcmlwdHMgYW5kXG4gICAqIENJIGpvYnMgZG8gbm90IGhhdmUgdG8gY2hhbmdlIGluIHRoZSBzYW1lIHJlbGVhc2UgdGhhdCBhZGRzIHBydW5pbmcuXG4gICAqL1xuICBpZiAoYXJndi5sZW5ndGggJiYgIWFyZ3ZbMF0uc3RhcnRzV2l0aCgnLScpKSB7XG4gICAgb3B0aW9ucy51c2VybmFtZSA9IGFyZ3ZbMF1cbiAgICBvcHRpb25zLnBhc3N3b3JkUGFyYW1ldGVyID0gYXJndlsxXSB8fCAnJ1xuICAgIC8qKlxuICAgICAqIE9wdGlvbnMgYXJlIHN0aWxsIGhvbm91cmVkIGFmdGVyIHRoZSBwb3NpdGlvbmFsIGFyZ3VtZW50cy4gVHJlYXRpbmcgYSB0cmFpbGluZyBcIi1uXCIgYXMgYVxuICAgICAqIHN0YWNrIG5hbWUgaW5zdGVhZCBpcyBob3cgYSBydW4gdGhlIGNhbGxlciBiZWxpZXZlZCB3YXMgYSByZWhlYXJzYWwgd3JpdGVzIGZvciByZWFsIOKAlCB3aGljaFxuICAgICAqIGlzIGV4YWN0bHkgd2hhdCBoYXBwZW5lZCB0aGUgZmlyc3QgdGltZSB0aGlzIHdhcyB0ZXN0ZWQuXG4gICAgICovXG4gICAgY29uc3QgcmVzdCA9IGFyZ3Yuc2xpY2UoMilcbiAgICBjb25zdCBmbGFnSW5kZXggPSByZXN0LmZpbmRJbmRleCgoYXJnKSA9PiBhcmcuc3RhcnRzV2l0aCgnLScpKVxuICAgIGNvbnN0IHBvc2l0aW9uYWwgPSBmbGFnSW5kZXggPT09IC0xID8gcmVzdCA6IHJlc3Quc2xpY2UoMCwgZmxhZ0luZGV4KVxuICAgIGlmIChwb3NpdGlvbmFsWzBdKSBvcHRpb25zLnR0bCA9IHBvc2l0aW9uYWxbMF1cbiAgICBvcHRpb25zLnN0YWNrTmFtZXMgPSBwb3NpdGlvbmFsLnNsaWNlKDEpXG4gICAgaWYgKGZsYWdJbmRleCAhPT0gLTEpIGFwcGx5RmxhZ3MocmVzdC5zbGljZShmbGFnSW5kZXgpLCBvcHRpb25zKVxuICAgIHJldHVybiBvcHRpb25zXG4gIH1cblxuICBhcHBseUZsYWdzKGFyZ3YsIG9wdGlvbnMpXG4gIHJldHVybiBvcHRpb25zXG59XG5cbmZ1bmN0aW9uIGFwcGx5RmxhZ3MoYXJndjogc3RyaW5nW10sIG9wdGlvbnM6IE9wdGlvbnMpOiB2b2lkIHtcbiAgY29uc3QgbmV4dCA9IChpbmRleDogbnVtYmVyLCBmbGFnOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gYXJndltpbmRleCArIDFdXG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUuc3RhcnRzV2l0aCgnLScpKSB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgdmFsdWUgZm9yICR7ZmxhZ31gKVxuICAgIHJldHVybiB2YWx1ZVxuICB9XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmd2Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYXJnID0gYXJndltpXVxuICAgIHN3aXRjaCAoYXJnKSB7XG4gICAgICBjYXNlICctdSc6XG4gICAgICBjYXNlICctLXVzZXJuYW1lJzpcbiAgICAgICAgb3B0aW9ucy51c2VybmFtZSA9IG5leHQoaSwgYXJnKVxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy1wJzpcbiAgICAgIGNhc2UgJy0tcGFzc3dvcmQtcGFyYW1ldGVyJzpcbiAgICAgICAgb3B0aW9ucy5wYXNzd29yZFBhcmFtZXRlciA9IG5leHQoaSwgYXJnKVxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy10JzpcbiAgICAgIGNhc2UgJy0tdHRsJzpcbiAgICAgICAgb3B0aW9ucy50dGwgPSBuZXh0KGksIGFyZylcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctcyc6XG4gICAgICBjYXNlICctLXN0YWNrJzpcbiAgICAgICAgb3B0aW9ucy5zdGFja05hbWVzLnB1c2gobmV4dChpLCBhcmcpKVxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy16JzpcbiAgICAgIGNhc2UgJy0tem9uZSc6XG4gICAgICAgIG9wdGlvbnMuem9uZU5hbWVzLnB1c2gobmV4dChpLCBhcmcpKVxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy0tcHJ1bmUnOlxuICAgICAgICBvcHRpb25zLnBydW5lID0gdHJ1ZVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLS1mb3JjZS1wcnVuZSc6XG4gICAgICAgIG9wdGlvbnMucHJ1bmUgPSB0cnVlXG4gICAgICAgIG9wdGlvbnMuZm9yY2VQcnVuZSA9IHRydWVcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy0tbWF4LXBydW5lJzoge1xuICAgICAgICBjb25zdCByYXcgPSBuZXh0KGksIGFyZylcbiAgICAgICAgY29uc3QgcGFyc2VkID0gTnVtYmVyKHJhdylcbiAgICAgICAgLy8gTnVtYmVyKCdhYmMnKSBpcyBOYU4sIGFuZCBgb3JwaGFucy5sZW5ndGggPiBOYU5gIGlzIGZhbHNlIOKAlCBhbiB1bnZhbGlkYXRlZCB2YWx1ZSBoZXJlXG4gICAgICAgIC8vIHdvdWxkIHF1aWV0bHkgcmVtb3ZlIHRoZSBjYXAgcmF0aGVyIHRoYW4gdGlnaHRlbiBpdC5cbiAgICAgICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHBhcnNlZCkgfHwgcGFyc2VkIDwgMCkgdGhyb3cgbmV3IEVycm9yKGAtLW1heC1wcnVuZSBuZWVkcyBhIG5vbi1uZWdhdGl2ZSBpbnRlZ2VyLCBnb3Q6ICR7cmF3fWApXG4gICAgICAgIG9wdGlvbnMubWF4UHJ1bmUgPSBwYXJzZWRcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICB9XG4gICAgICBjYXNlICctbic6XG4gICAgICBjYXNlICctLWRyeS1ydW4nOlxuICAgICAgICBvcHRpb25zLmRyeVJ1biA9IHRydWVcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy1oJzpcbiAgICAgIGNhc2UgJy0taGVscCc6XG4gICAgICAgIGNvbnNvbGUubG9nKFVTQUdFKVxuICAgICAgICBwcm9jZXNzLmV4aXQoMClcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy1WJzpcbiAgICAgIGNhc2UgJy0tdmVyc2lvbic6XG4gICAgICAgIGNvbnNvbGUubG9nKHJlcXVpcmUoJy4uL3BhY2thZ2UuanNvbicpLnZlcnNpb24pXG4gICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICBicmVha1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIG9wdGlvbjogJHthcmd9YClcbiAgICB9XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY2xvdWRuc1Jlc3RDYWxsKFxuICBjbG91ZG5zVXNlcm5hbWU6IHN0cmluZyxcbiAgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsXG4gIG1ldGhvZDogc3RyaW5nLFxuICByZWxhdGl2ZVVybDogc3RyaW5nLFxuICBxdWVyeU9wdGlvbnM6IGFueVxuKTogUHJvbWlzZTxDbG91ZG5zUmVzdENhbGxSZXNwb25zZT4ge1xuICBjb25zdCBmdWxsVXJsID1cbiAgICAnaHR0cHM6Ly9hcGkuY2xvdWRucy5uZXQnICtcbiAgICByZWxhdGl2ZVVybCArXG4gICAgJz8nICtcbiAgICBxdWVyeXN0cmluZy5zdHJpbmdpZnkoXG4gICAgICBPYmplY3QuYXNzaWduKFxuICAgICAgICB7XG4gICAgICAgICAgJ3N1Yi1hdXRoLXVzZXInOiBjbG91ZG5zVXNlcm5hbWUsXG4gICAgICAgICAgJ2F1dGgtcGFzc3dvcmQnOiBjbG91ZG5zUGFzc3dvcmQsXG4gICAgICAgIH0sXG4gICAgICAgIHF1ZXJ5T3B0aW9ucyB8fCB7fVxuICAgICAgKVxuICAgIClcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGZ1bGxVcmwsIHtcbiAgICBtZXRob2Q6IG1ldGhvZCxcbiAgICBoZWFkZXJzOiB7XG4gICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgfSxcbiAgfSlcbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKVxuICAgIGNvbnNvbGUuZXJyb3IoJ0hUVFAgRXJyb3InLCByZXNwb25zZS5zdGF0dXMsIHJlc3BvbnNlLnN0YXR1c1RleHQsIGVycm9yVGV4dClcbiAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JUZXh0KVxuICB9XG4gIHJldHVybiAoYXdhaXQgcmVzcG9uc2UuanNvbigpKSBhcyBDbG91ZG5zUmVzdENhbGxSZXNwb25zZVxufVxuXG4vKipcbiAqIENsb3VETlMgcmVwb3J0cyBmYWlsdXJlcyBpbiB0aGUgYm9keSB3aXRoIEhUVFAgMjAwLCBzbyBhIGNhbGwgaXMgb25seSBzdWNjZXNzZnVsIGlmIGl0IHNheXMgc28uXG4gKlxuICogVHJlYXRpbmcgXCJub3QgdGhlIHN0cmluZyBGYWlsZWRcIiBhcyBzdWNjZXNzIGlzIGhvdyBhIHJlamVjdGVkIHdyaXRlIGdldHMgcmVwb3J0ZWQgYXMgZG9uZSDigJRcbiAqIGNoZWNrZWQgcG9zaXRpdmVseSBoZXJlIGluc3RlYWQuXG4gKi9cbmZ1bmN0aW9uIGFzc2VydFN1Y2Nlc3MocmVzdWx0OiBhbnksIHdoYXQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBzdGF0dXMgPSByZXN1bHQ/LnN0YXR1c1xuICBpZiAoc3RhdHVzID09PSAnU3VjY2VzcycgfHwgc3RhdHVzID09PSAxIHx8IHN0YXR1cyA9PT0gJzEnKSByZXR1cm5cbiAgdGhyb3cgbmV3IEVycm9yKGAke3doYXR9IGZhaWxlZDogJHtyZXN1bHQ/LnN0YXR1c0Rlc2NyaXB0aW9uIHx8IHJlc3VsdD8uc3RhdHVzTWVzc2FnZSB8fCBKU09OLnN0cmluZ2lmeShyZXN1bHQpfWApXG59XG5cbmFzeW5jIGZ1bmN0aW9uIGF1dG9EZXRlY3RDbG91ZG5zSG9zdEFuZFpvbmUoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHpvbmVDYWNoZTogYW55KSB7XG4gIGNvbnN0IG5hbWVQYXJ0cyA9IG5hbWUuc3BsaXQoJy4nKVxuXG4gIC8vIFpvbmUgYW5kIGhvc3QgbmFtZSBmb3IgeHh4LnRsZFxuICBjb25zdCBob3N0TmFtZTEgPSBuYW1lUGFydHMuc2xpY2UoMCwgbmFtZVBhcnRzLmxlbmd0aCAtIDIpLmpvaW4oJy4nKVxuICBjb25zdCB6b25lTmFtZTEgPSBuYW1lUGFydHMuc2xpY2UobmFtZVBhcnRzLmxlbmd0aCAtIDIpLmpvaW4oJy4nKVxuXG4gIC8vIFpvbmUgYW5kIGhvc3QgbmFtZSBmb3IgeHh4LnN1YnRsZC50bGRcbiAgY29uc3QgaG9zdE5hbWUyID0gbmFtZVBhcnRzLnNsaWNlKDAsIG5hbWVQYXJ0cy5sZW5ndGggLSAzKS5qb2luKCcuJylcbiAgY29uc3Qgem9uZU5hbWUyID0gbmFtZVBhcnRzLnNsaWNlKG5hbWVQYXJ0cy5sZW5ndGggLSAzKS5qb2luKCcuJylcblxuICAvLyBDaGVjayB3aGljaCB6b25lIGV4aXN0c1xuICBjb25zdCB6b25lUmVzcG9uc2UxID1cbiAgICB6b25lQ2FjaGVbem9uZU5hbWUxXSB8fFxuICAgIChhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdHRVQnLCAnL2Rucy9nZXQtem9uZS1pbmZvLmpzb24nLCB7XG4gICAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZTEsXG4gICAgfSkpXG4gIHpvbmVDYWNoZVt6b25lTmFtZTFdID0gem9uZVJlc3BvbnNlMVxuICBjb25zdCB6b25lUmVzcG9uc2UyID1cbiAgICB6b25lQ2FjaGVbem9uZU5hbWUyXSB8fFxuICAgIChhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdHRVQnLCAnL2Rucy9nZXQtem9uZS1pbmZvLmpzb24nLCB7XG4gICAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZTIsXG4gICAgfSkpXG4gIHpvbmVDYWNoZVt6b25lTmFtZTJdID0gem9uZVJlc3BvbnNlMlxuXG4gIGNvbnN0IHpvbmVOYW1lID0gem9uZVJlc3BvbnNlMS5zdGF0dXMgPT09ICcxJyA/IHpvbmVOYW1lMSA6IHpvbmVSZXNwb25zZTIuc3RhdHVzID09PSAnMScgPyB6b25lTmFtZTIgOiAnJ1xuICBjb25zdCBob3N0TmFtZSA9IHpvbmVSZXNwb25zZTEuc3RhdHVzID09PSAnMScgPyBob3N0TmFtZTEgOiB6b25lUmVzcG9uc2UyLnN0YXR1cyA9PT0gJzEnID8gaG9zdE5hbWUyIDogJydcbiAgaWYgKCF6b25lTmFtZSkge1xuICAgIC8vIE5laXRoZXIgem9uZSBleGlzdHNcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1pvbmUgTm90IEZvdW5kOiAnICsgbmFtZSlcbiAgfVxuICByZXR1cm4ge1xuICAgIGhvc3ROYW1lOiBob3N0TmFtZSxcbiAgICB6b25lTmFtZTogem9uZU5hbWUsXG4gIH1cbn1cblxuLyoqXG4gKiBFdmVyeSByZWNvcmQgaW4gYSB6b25lLCBub3RlcyBpbmNsdWRlZC4gQWxzbyB0aGUgYmFzaXMgZm9yIGZpbmRpbmcgb3JwaGFucy5cbiAqXG4gKiBDYWNoZWQgcGVyIHJ1bjogbG9va2luZyBhIHJlY29yZCB1cCBhbmQgdGhlbiB2ZXJpZnlpbmcgaXQgdXNlZCB0byBjb3N0IHR3byB3aG9sZS16b25lIGNhbGxzIGVhY2gsXG4gKiBzbyB0d2VudHkgZXhwb3J0cyBtZWFudCBmb3J0eSBsaXN0aW5ncyBhZ2FpbnN0IGFuIEFQSSB0aGF0IHJhdGUgbGltaXRzLiBBbnkgd3JpdGUgaW52YWxpZGF0ZXMgdGhlXG4gKiB6b25lLCBhbmQgdmVyaWZpY2F0aW9uIGFsd2F5cyByZWFkcyBmcmVzaCwgc28gYSBjYWNoZWQgbGlzdGluZyBpcyBuZXZlciB1c2VkIHRvIGp1ZGdlIHNvbWV0aGluZ1xuICogdGhhdCBoYXMganVzdCBjaGFuZ2VkLlxuICovXG5jb25zdCB6b25lUmVjb3Jkc0NhY2hlID0gbmV3IE1hcDxzdHJpbmcsIENsb3VkbnNSZWNvcmRbXT4oKVxuXG5hc3luYyBmdW5jdGlvbiBsaXN0Wm9uZVJlY29yZHMoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCB6b25lTmFtZTogc3RyaW5nLCBmcmVzaCA9IGZhbHNlKTogUHJvbWlzZTxDbG91ZG5zUmVjb3JkW10+IHtcbiAgaWYgKCFmcmVzaCkge1xuICAgIGNvbnN0IGNhY2hlZCA9IHpvbmVSZWNvcmRzQ2FjaGUuZ2V0KHpvbmVOYW1lKVxuICAgIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWRcbiAgfVxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ0dFVCcsICcvZG5zL3JlY29yZHMuanNvbicsIHtcbiAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAnaW5jbHVkZS1ub3Rlcyc6ICcxJyxcbiAgfSlcbiAgLy8gQW4gZW1wdHkgem9uZSBjb21lcyBiYWNrIGFzIGFuIGVtcHR5IGFycmF5IHJhdGhlciB0aGFuIGFuIGVtcHR5IG9iamVjdC5cbiAgY29uc3QgcmVjb3JkcyA9ICFyZXNwb25zZSB8fCBBcnJheS5pc0FycmF5KHJlc3BvbnNlKSA/IFtdIDogKE9iamVjdC52YWx1ZXMocmVzcG9uc2UpIGFzIENsb3VkbnNSZWNvcmRbXSlcbiAgem9uZVJlY29yZHNDYWNoZS5zZXQoem9uZU5hbWUsIHJlY29yZHMpXG4gIHJldHVybiByZWNvcmRzXG59XG5cbmZ1bmN0aW9uIG93bmVyc2hpcE5vdGUoc3RhY2tOYW1lOiBzdHJpbmcsIGV4cG9ydE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtOT1RFX01BUktFUn0gc3RhY2s9JHtzdGFja05hbWV9IGV4cG9ydD0ke2V4cG9ydE5hbWV9YFxufVxuXG4vKiogVGhlIHN0YWNrIG5hbWVkIGluIGEgcmVjb3JkJ3Mgbm90ZSwgb3IgdW5kZWZpbmVkIHdoZW4gdGhlIHJlY29yZCBpcyBub3Qgb3Vycy4gKi9cbmZ1bmN0aW9uIG5vdGVTdGFja05hbWUocmVjb3JkOiBDbG91ZG5zUmVjb3JkKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFyZWNvcmQubm90ZSB8fCByZWNvcmQubm90ZS5pbmRleE9mKE5PVEVfTUFSS0VSKSA9PT0gLTEpIHJldHVybiB1bmRlZmluZWRcbiAgY29uc3QgbWF0Y2ggPSAvc3RhY2s9KFxcUyspLy5leGVjKHJlY29yZC5ub3RlKVxuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFsxXSA6ICcnXG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNldFJlY29yZE5vdGUoXG4gIGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLFxuICBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZyxcbiAgem9uZU5hbWU6IHN0cmluZyxcbiAgcmVjb3JkSWQ6IHN0cmluZyxcbiAgbm90ZTogc3RyaW5nLFxuICBkcnlSdW46IGJvb2xlYW5cbik6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoZHJ5UnVuKSByZXR1cm5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnUE9TVCcsICcvZG5zL3NldC1yZWNvcmQtbm90ZS5qc29uJywge1xuICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICdyZWNvcmQtaWQnOiByZWNvcmRJZCxcbiAgICBub3RlOiBub3RlLFxuICB9KVxuICBhc3NlcnRTdWNjZXNzKHJlc3VsdCwgJ1NldCByZWNvcmQgbm90ZScpXG4gIHpvbmVSZWNvcmRzQ2FjaGUuZGVsZXRlKHpvbmVOYW1lKVxufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVPclVwZGF0ZUNsb3VkbnNSZXNvdXJjZShcbiAgY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsXG4gIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLFxuICBkZXNpcmVkOiBEZXNpcmVkUmVjb3JkLFxuICB0dGxWYWx1ZTogc3RyaW5nLFxuICBkcnlSdW46IGJvb2xlYW5cbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IHpvbmVOYW1lLCBob3N0TmFtZSwgdHlwZSwgdmFsdWUgfSA9IGRlc2lyZWRcbiAgY29uc3QgbmFtZSA9IGhvc3ROYW1lID8gYCR7aG9zdE5hbWV9LiR7em9uZU5hbWV9YCA6IHpvbmVOYW1lXG5cbiAgY29uc3QgcmVjb3JkcyA9IGF3YWl0IGxpc3Rab25lUmVjb3JkcyhjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWUpXG4gIC8qKlxuICAgKiBNYXRjaCBvbiBob3N0IGFuZCB0eXBlIGFjcm9zcyB0aGUgd2hvbGUgem9uZSByYXRoZXIgdGhhbiB0cnVzdGluZyBhIGZpbHRlcmVkIHF1ZXJ5J3MgZmlyc3RcbiAgICogZW50cnkuIFRha2luZyB3aGljaGV2ZXIgcmVjb3JkIGhhcHBlbmVkIHRvIGNvbWUgYmFjayBmaXJzdCBtZWFudCB0aGF0IGEgaG9zdCB3aXRoIG1vcmUgdGhhbiBvbmVcbiAgICogcmVjb3JkIG9mIGEgdHlwZSBoYWQgb25lIG9mIHRoZW0gdXBkYXRlZCBhdCByYW5kb20gd2hpbGUgdGhlIG90aGVyIGtlcHQgc2VydmluZyB0cmFmZmljLlxuICAgKi9cbiAgY29uc3QgbWF0Y2hpbmcgPSByZWNvcmRzLmZpbHRlcigocmVjb3JkKSA9PiByZWNvcmQuaG9zdCA9PT0gaG9zdE5hbWUgJiYgcmVjb3JkLnR5cGUgPT09IHR5cGUpXG4gIGlmIChtYXRjaGluZy5sZW5ndGggPiAxKSB7XG4gICAgY29uc29sZS53YXJuKCdXQVJOJywgbmFtZSwgdHlwZSwgJ2hhcycsIG1hdGNoaW5nLmxlbmd0aCwgJ3JlY29yZHM7IHVwZGF0aW5nIHRoZSBmaXJzdCBhbmQgbGVhdmluZyB0aGUgcmVzdCcpXG4gIH1cbiAgY29uc3QgZXhpc3RpbmdSZWNvcmQgPSBtYXRjaGluZ1swXVxuICBjb25zdCBub3RlID0gb3duZXJzaGlwTm90ZShkZXNpcmVkLnN0YWNrTmFtZSwgZGVzaXJlZC5leHBvcnROYW1lKVxuXG4gIGlmIChleGlzdGluZ1JlY29yZCAmJiBleGlzdGluZ1JlY29yZC5yZWNvcmQgPT09IHZhbHVlICYmIFN0cmluZyhleGlzdGluZ1JlY29yZC50dGwpID09PSBTdHJpbmcodHRsVmFsdWUpKSB7XG4gICAgaWYgKGV4aXN0aW5nUmVjb3JkLm5vdGUgPT09IG5vdGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKCdPSycsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQWRvcHRzIHJlY29yZHMgY3JlYXRlZCBiZWZvcmUgb3duZXJzaGlwIG5vdGVzIGV4aXN0ZWQsIGFuZCByZXBhaXJzIGEgbm90ZSB0aGF0IGRyaWZ0ZWQuXG4gICAgICBjb25zb2xlLmxvZygnQURPUFQnLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gICAgICBhd2FpdCBzZXRSZWNvcmROb3RlKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCB6b25lTmFtZSwgZXhpc3RpbmdSZWNvcmQuaWQsIG5vdGUsIGRyeVJ1bilcbiAgICB9XG4gICAgcmV0dXJuXG4gIH1cblxuICBpZiAoZXhpc3RpbmdSZWNvcmQpIHtcbiAgICBjb25zb2xlLmxvZygnVVBEQVRFJywgbmFtZSwgdHlwZSwgdHRsVmFsdWUsIHZhbHVlLCAnWk9ORScsIHpvbmVOYW1lLCAnSE9TVCcsIGhvc3ROYW1lKVxuICAgIGlmICghZHJ5UnVuKSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdQT1NUJywgJy9kbnMvbW9kLXJlY29yZC5qc29uJywge1xuICAgICAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAgICAgJ3JlY29yZC1pZCc6IGV4aXN0aW5nUmVjb3JkLmlkLFxuICAgICAgICBob3N0OiBob3N0TmFtZSxcbiAgICAgICAgJ3JlY29yZC10eXBlJzogdHlwZSxcbiAgICAgICAgcmVjb3JkOiB2YWx1ZSxcbiAgICAgICAgdHRsOiB0dGxWYWx1ZSxcbiAgICAgIH0pXG4gICAgICBhc3NlcnRTdWNjZXNzKHJlc3VsdCwgJ01vZGlmeSByZWNvcmQnKVxuICAgICAgYXdhaXQgc2V0UmVjb3JkTm90ZShjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWUsIGV4aXN0aW5nUmVjb3JkLmlkLCBub3RlLCBkcnlSdW4pXG4gICAgICBhd2FpdCB2ZXJpZnlSZWNvcmQoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIGRlc2lyZWQsIHR0bFZhbHVlKVxuICAgIH1cbiAgICByZXR1cm5cbiAgfVxuXG4gIGNvbnNvbGUubG9nKCdDUkVBVEUnLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gIGlmIChkcnlSdW4pIHJldHVyblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdQT1NUJywgJy9kbnMvYWRkLXJlY29yZC5qc29uJywge1xuICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgIGhvc3Q6IGhvc3ROYW1lLFxuICAgICdyZWNvcmQtdHlwZSc6IHR5cGUsXG4gICAgcmVjb3JkOiB2YWx1ZSxcbiAgICB0dGw6IHR0bFZhbHVlLFxuICB9KVxuICBhc3NlcnRTdWNjZXNzKHJlc3VsdCwgJ0FkZCByZWNvcmQnKVxuICBjb25zdCBjcmVhdGVkSWQgPSByZXN1bHQ/LmRhdGE/LmlkXG4gIGlmIChjcmVhdGVkSWQpIGF3YWl0IHNldFJlY29yZE5vdGUoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHpvbmVOYW1lLCBTdHJpbmcoY3JlYXRlZElkKSwgbm90ZSwgZHJ5UnVuKVxuICBhd2FpdCB2ZXJpZnlSZWNvcmQoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIGRlc2lyZWQsIHR0bFZhbHVlKVxufVxuXG4vKipcbiAqIFJlYWRzIHRoZSByZWNvcmQgYmFjayBhbmQgY29tcGxhaW5zIGlmIGl0IGlzIG5vdCB3aGF0IHdhcyBqdXN0IHdyaXR0ZW4uXG4gKlxuICogV2l0aG91dCB0aGlzIHRoZSBsb2cgcmVwb3J0cyBpbnRlbnQgcmF0aGVyIHRoYW4gb3V0Y29tZSwgd2hpY2ggaXMgaG93IGEgY3V0b3ZlciB0aGF0IG5ldmVyXG4gKiBoYXBwZW5lZCBjYW4gbG9vayBsaWtlIGEgY2xlYW4gcnVuLiBOb3RlIHRoaXMgY29uZmlybXMgdGhlIHN0b3JlZCByZWNvcmQgb25seSDigJQgQ2xvdUROUyByZXNvbHZlc1xuICogQUxJQVMgdGFyZ2V0cyBvbiBpdHMgb3duIHNjaGVkdWxlLCBzbyB3aGF0IHRoZSB6b25lICpzZXJ2ZXMqIGNhbiBsYWcgdGhlIHJlY29yZCBieSBhIGxvbmcgd2F5LlxuICovXG5hc3luYyBmdW5jdGlvbiB2ZXJpZnlSZWNvcmQoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCBkZXNpcmVkOiBEZXNpcmVkUmVjb3JkLCB0dGxWYWx1ZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJlY29yZHMgPSBhd2FpdCBsaXN0Wm9uZVJlY29yZHMoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIGRlc2lyZWQuem9uZU5hbWUsIHRydWUpXG4gIGNvbnN0IHN0b3JlZCA9IHJlY29yZHMuZmluZCgocmVjb3JkKSA9PiByZWNvcmQuaG9zdCA9PT0gZGVzaXJlZC5ob3N0TmFtZSAmJiByZWNvcmQudHlwZSA9PT0gZGVzaXJlZC50eXBlKVxuICBpZiAoIXN0b3JlZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgVmVyaWZpY2F0aW9uIGZhaWxlZDogJHtkZXNpcmVkLmhvc3ROYW1lfS4ke2Rlc2lyZWQuem9uZU5hbWV9ICR7ZGVzaXJlZC50eXBlfSBpcyBtaXNzaW5nIGFmdGVyIHdyaXRlYClcbiAgfVxuICBpZiAoc3RvcmVkLnJlY29yZCAhPT0gZGVzaXJlZC52YWx1ZSB8fCBTdHJpbmcoc3RvcmVkLnR0bCkgIT09IFN0cmluZyh0dGxWYWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgVmVyaWZpY2F0aW9uIGZhaWxlZDogJHtkZXNpcmVkLmhvc3ROYW1lfS4ke2Rlc2lyZWQuem9uZU5hbWV9ICR7ZGVzaXJlZC50eXBlfSBpcyAke3N0b3JlZC5yZWNvcmR9ICh0dGwgJHtzdG9yZWQudHRsfSksIGV4cGVjdGVkICR7ZGVzaXJlZC52YWx1ZX0gKHR0bCAke3R0bFZhbHVlfSlgXG4gICAgKVxuICB9XG59XG5cbi8qKlxuICogRGVsZXRlcyBtYW5hZ2VkIHJlY29yZHMgd2hvc2UgZXhwb3J0IG5vIGxvbmdlciBleGlzdHMuXG4gKlxuICogT25seSByZWNvcmRzIGNhcnJ5aW5nIHRoaXMgdG9vbCdzIG5vdGUgYXJlIGNvbnNpZGVyZWQsIGFuZCB3aGVuIC0tc3RhY2sgd2FzIGdpdmVuIG9ubHkgdGhvc2VcbiAqIHdob3NlIG5vdGUgbmFtZXMgb25lIG9mIHRob3NlIHN0YWNrcyDigJQgb3RoZXJ3aXNlIHN5bmNpbmcgb25lIHN0YWNrIHdvdWxkIGRlbGV0ZSB0aGUgcmVjb3JkcyBvZlxuICogYW5vdGhlci5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcHJ1bmVPcnBoYW5zKFxuICBjbG91ZG5zVXNlcm5hbWU6IHN0cmluZyxcbiAgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsXG4gIHpvbmVOYW1lczogc3RyaW5nW10sXG4gIGRlc2lyZWQ6IERlc2lyZWRSZWNvcmRbXSxcbiAgc3RhY2tTY29wZTogU2V0PHN0cmluZz4gfCB1bmRlZmluZWQsXG4gIG9wdGlvbnM6IE9wdGlvbnNcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBkZXNpcmVkS2V5cyA9IG5ldyBTZXQoZGVzaXJlZC5tYXAoKHJlY29yZCkgPT4gYCR7cmVjb3JkLnpvbmVOYW1lfXwke3JlY29yZC5ob3N0TmFtZX18JHtyZWNvcmQudHlwZX1gKSlcbiAgY29uc3Qgb3JwaGFuczogeyB6b25lTmFtZTogc3RyaW5nOyByZWNvcmQ6IENsb3VkbnNSZWNvcmQgfVtdID0gW11cblxuICBmb3IgKGNvbnN0IHpvbmVOYW1lIG9mIHpvbmVOYW1lcykge1xuICAgIGZvciAoY29uc3QgcmVjb3JkIG9mIGF3YWl0IGxpc3Rab25lUmVjb3JkcyhjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWUsIHRydWUpKSB7XG4gICAgICBjb25zdCBzdGFjayA9IG5vdGVTdGFja05hbWUocmVjb3JkKVxuICAgICAgaWYgKHN0YWNrID09PSB1bmRlZmluZWQpIGNvbnRpbnVlIC8vIG5vdCBvdXJzXG4gICAgICBpZiAoc3RhY2tTY29wZSAmJiAhc3RhY2tTY29wZS5oYXMoc3RhY2spKSBjb250aW51ZSAvLyBhbm90aGVyIHN0YWNrJ3NcbiAgICAgIGlmIChkZXNpcmVkS2V5cy5oYXMoYCR7em9uZU5hbWV9fCR7cmVjb3JkLmhvc3R9fCR7cmVjb3JkLnR5cGV9YCkpIGNvbnRpbnVlIC8vIHN0aWxsIHdhbnRlZFxuICAgICAgb3JwaGFucy5wdXNoKHsgem9uZU5hbWUsIHJlY29yZCB9KVxuICAgIH1cbiAgfVxuXG4gIGlmICghb3JwaGFucy5sZW5ndGgpIHtcbiAgICBjb25zb2xlLmxvZygnUFJVTkUgbm9uZScpXG4gICAgcmV0dXJuXG4gIH1cblxuICBmb3IgKGNvbnN0IHsgem9uZU5hbWUsIHJlY29yZCB9IG9mIG9ycGhhbnMpIHtcbiAgICBjb25zdCBuYW1lID0gcmVjb3JkLmhvc3QgPyBgJHtyZWNvcmQuaG9zdH0uJHt6b25lTmFtZX1gIDogem9uZU5hbWVcbiAgICBjb25zb2xlLmxvZyhvcHRpb25zLmRyeVJ1biA/ICdXT1VMRCBQUlVORScgOiAnUFJVTkUnLCBuYW1lLCByZWNvcmQudHlwZSwgcmVjb3JkLnJlY29yZCwgJ1pPTkUnLCB6b25lTmFtZSlcbiAgfVxuXG4gIGNvbnN0IG92ZXJDYXAgPSBvcnBoYW5zLmxlbmd0aCA+IG9wdGlvbnMubWF4UHJ1bmVcbiAgaWYgKG9wdGlvbnMuZHJ5UnVuKSB7XG4gICAgaWYgKG92ZXJDYXApIGNvbnNvbGUud2FybignV0FSTicsIGBBIHJlYWwgcnVuIHdvdWxkIHJlZnVzZTogJHtvcnBoYW5zLmxlbmd0aH0gcmVjb3JkcyBleGNlZWRzIC0tbWF4LXBydW5lICR7b3B0aW9ucy5tYXhQcnVuZX1gKVxuICAgIHJldHVyblxuICB9XG4gIGlmIChvdmVyQ2FwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBSZWZ1c2luZyB0byBkZWxldGUgJHtvcnBoYW5zLmxlbmd0aH0gcmVjb3JkcyBpbiBvbmUgcnVuIChsaW1pdCAke29wdGlvbnMubWF4UHJ1bmV9KTsgcmFpc2UgLS1tYXgtcHJ1bmUgaWYgdGhpcyBpcyBpbnRlbmRlZGApXG4gIH1cblxuICBmb3IgKGNvbnN0IHsgem9uZU5hbWUsIHJlY29yZCB9IG9mIG9ycGhhbnMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdQT1NUJywgJy9kbnMvZGVsZXRlLXJlY29yZC5qc29uJywge1xuICAgICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgICAncmVjb3JkLWlkJzogcmVjb3JkLmlkLFxuICAgIH0pXG4gICAgYXNzZXJ0U3VjY2VzcyhyZXN1bHQsICdEZWxldGUgcmVjb3JkJylcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgLy8gUGFyc2VkIGJlZm9yZSB0aGUgYmFubmVyIHNvIC0tdmVyc2lvbiBhbmQgLS1oZWxwIHByaW50IG9ubHkgd2hhdCBhIGNhbGxlciBhc2tlZCBmb3IuXG4gIGNvbnN0IG9wdGlvbnMgPSBwYXJzZUFyZ3MocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKVxuICBjb25zb2xlLmxvZygnQ2xvdUROUyBDbG91ZEZvcm1hdGlvbiBTeW5jIGJ5IEtlbm5ldGggRmFsY2sgPGtlbm51QGNsb3VkZW4ubmV0PiAoQykgQ2xvdWRlbiBPeSAyMDIwLTIwMjYnKVxuXG4gIGlmICghb3B0aW9ucy51c2VybmFtZSB8fCAhb3B0aW9ucy5wYXNzd29yZFBhcmFtZXRlcikge1xuICAgIGNvbnNvbGUuZXJyb3IoVVNBR0UpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cbiAgaWYgKG9wdGlvbnMuZm9yY2VQcnVuZSAmJiAhb3B0aW9ucy56b25lTmFtZXMubGVuZ3RoKSB7XG4gICAgY29uc29sZS5lcnJvcignLS1mb3JjZS1wcnVuZSBuZWVkcyBhdCBsZWFzdCBvbmUgLS16b25lOiB3aXRoIG5vIGV4cG9ydHMgdGhlcmUgaXMgbm90aGluZyB0byBpbmZlciBhIHpvbmUgZnJvbScpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBjb25zdCBzc20gPSBuZXcgU1NNQ2xpZW50KHt9KVxuICBjb25zdCB6b25lQ2FjaGUgPSB7fVxuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc3NtLnNlbmQoXG4gICAgbmV3IEdldFBhcmFtZXRlckNvbW1hbmQoe1xuICAgICAgTmFtZTogb3B0aW9ucy5wYXNzd29yZFBhcmFtZXRlcixcbiAgICAgIFdpdGhEZWNyeXB0aW9uOiB0cnVlLFxuICAgIH0pXG4gIClcbiAgY29uc3QgY2xvdWRuc1Bhc3N3b3JkID0gcmVzcG9uc2UuUGFyYW1ldGVyPy5WYWx1ZSB8fCAnJ1xuXG4gIC8vIENvbGxlY3QgZXZlcnl0aGluZyB0aGUgZXhwb3J0cyBhc2sgZm9yIGJlZm9yZSB3cml0aW5nIGFueXRoaW5nLCBzbyBwcnVuaW5nIGNhbiBjb21wYXJlIGFnYWluc3RcbiAgLy8gdGhlIGNvbXBsZXRlIHBpY3R1cmUgcmF0aGVyIHRoYW4gYWdhaW5zdCB3aGF0ZXZlciBoYXMgYmVlbiBwcm9jZXNzZWQgc28gZmFyLlxuICBjb25zdCBkZXNpcmVkOiBEZXNpcmVkUmVjb3JkW10gPSBbXVxuICAvKiogRXZlcnkgc3BlbGxpbmcgb2YgYSBzdGFjayB0aGF0IG1hdGNoZWQsIHNvIC0tc3RhY2sgY2FuIGJlIGdpdmVuIGFzIGEgbmFtZSBvciBhIGZ1bGwgQVJOLiAqL1xuICBjb25zdCBtYXRjaGVkU3RhY2tzID0gbmV3IFNldDxzdHJpbmc+KClcbiAgLyoqIFNob3J0IG5hbWVzIG9ubHksIHdoaWNoIGlzIHRoZSBmb3JtIG93bmVyc2hpcCBub3RlcyBjYXJyeSwgc28gcHJ1bmluZyBjYW4gYmUgc2NvcGVkIGJ5IHRoZW0uICovXG4gIGNvbnN0IG1hdGNoZWRTdGFja05hbWVzID0gbmV3IFNldDxzdHJpbmc+KClcbiAgY29uc3QgY2xvdWRGb3JtYXRpb24gPSBuZXcgQ2xvdWRGb3JtYXRpb25DbGllbnQoe30pXG4gIGxldCBuZXh0VG9rZW5cbiAgZG8ge1xuICAgIGNvbnN0IHJlc3BvbnNlOiBMaXN0RXhwb3J0c091dHB1dCA9IGF3YWl0IGNsb3VkRm9ybWF0aW9uLnNlbmQobmV3IExpc3RFeHBvcnRzQ29tbWFuZCh7IE5leHRUb2tlbjogbmV4dFRva2VuIH0pKVxuICAgIGZvciAoY29uc3QgZXhwb3J0T2JqIG9mIHJlc3BvbnNlLkV4cG9ydHMgfHwgW10pIHtcbiAgICAgIGNvbnN0IHN0YWNrTWF0Y2ggPSBleHBvcnRPYmouRXhwb3J0aW5nU3RhY2tJZD8ubWF0Y2goL15hcm46W146XSs6Y2xvdWRmb3JtYXRpb246W146XSs6W146XSs6c3RhY2tcXC8oW14vXSspXFwvLylcbiAgICAgIGNvbnN0IHN0YWNrTmFtZSA9IHN0YWNrTWF0Y2ggPyBzdGFja01hdGNoWzFdIDogZXhwb3J0T2JqLkV4cG9ydGluZ1N0YWNrSWQgfHwgJydcbiAgICAgIGlmIChvcHRpb25zLnN0YWNrTmFtZXMubGVuZ3RoICYmICFvcHRpb25zLnN0YWNrTmFtZXMuaW5jbHVkZXMoZXhwb3J0T2JqLkV4cG9ydGluZ1N0YWNrSWQgfHwgJycpICYmICFvcHRpb25zLnN0YWNrTmFtZXMuaW5jbHVkZXMoc3RhY2tOYW1lKSkge1xuICAgICAgICBjb250aW51ZVxuICAgICAgfVxuICAgICAgaWYgKCFleHBvcnRPYmouTmFtZT8ubWF0Y2goL15DbG91RE5TOi8pKSBjb250aW51ZVxuXG4gICAgICBjb25zdCBuYW1lUGFydHMgPSBleHBvcnRPYmouTmFtZS5zcGxpdCgnOicpXG4gICAgICBjb25zdCByZXNvdXJjZVR5cGUgPSBuYW1lUGFydHNbMV1cbiAgICAgIGNvbnN0IHJlc291cmNlTmFtZSA9IG5hbWVQYXJ0cy5zbGljZSgyKS5qb2luKCcuJylcbiAgICAgIGNvbnN0IHsgem9uZU5hbWUsIGhvc3ROYW1lIH0gPSBhd2FpdCBhdXRvRGV0ZWN0Q2xvdWRuc0hvc3RBbmRab25lKG9wdGlvbnMudXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgcmVzb3VyY2VOYW1lLCB6b25lQ2FjaGUpXG4gICAgICBtYXRjaGVkU3RhY2tzLmFkZChzdGFja05hbWUpXG4gICAgICBtYXRjaGVkU3RhY2tOYW1lcy5hZGQoc3RhY2tOYW1lKVxuICAgICAgaWYgKGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkKSBtYXRjaGVkU3RhY2tzLmFkZChleHBvcnRPYmouRXhwb3J0aW5nU3RhY2tJZClcbiAgICAgIGRlc2lyZWQucHVzaCh7XG4gICAgICAgIHpvbmVOYW1lLFxuICAgICAgICBob3N0TmFtZSxcbiAgICAgICAgdHlwZTogcmVzb3VyY2VUeXBlLFxuICAgICAgICB2YWx1ZTogZXhwb3J0T2JqLlZhbHVlISxcbiAgICAgICAgc3RhY2tOYW1lLFxuICAgICAgICBleHBvcnROYW1lOiBleHBvcnRPYmouTmFtZSxcbiAgICAgIH0pXG4gICAgfVxuICAgIG5leHRUb2tlbiA9IHJlc3BvbnNlLk5leHRUb2tlblxuICB9IHdoaWxlIChuZXh0VG9rZW4pXG5cbiAgLyoqXG4gICAqIEEgLS1zdGFjayB0aGF0IG1hdGNoZWQgbm90aGluZyBpcyBuZWFybHkgYWx3YXlzIGEgdHlwbyBvciBhIHN0YWNrIHRoYXQgaGFzIG5vdCBkZXBsb3llZCB5ZXQuXG4gICAqIEl0IHVzZWQgdG8gcGFzcyBzaWxlbnRseSBhcyBhIG5vLW9wOyB3aXRoIC0tcHJ1bmUgdGhlIHNhbWUgY29uZGl0aW9uIHdvdWxkIGxvb2sgbGlrZSBcImV2ZXJ5XG4gICAqIHJlY29yZCBpcyBhbiBvcnBoYW5cIiwgc28gaXQgaXMgZmF0YWwgdGhlcmUgYW5kIGEgd2FybmluZyBvdGhlcndpc2UuXG4gICAqXG4gICAqIC0tZm9yY2UtcHJ1bmUgaXMgdGhlIGV4Y2VwdGlvbjogYSB0b3JuLWRvd24gc3RhY2sgcHJvZHVjaW5nIG5vIGV4cG9ydHMgaXMgcHJlY2lzZWx5IHRoZSBjYXNlIGl0XG4gICAqIGV4aXN0cyBmb3IsIGFuZCB0aGUgY2FsbGVyIGhhcyBhbHJlYWR5IGhhZCB0byBuYW1lIHRoZSB6b25lIGV4cGxpY2l0bHkgdG8gZ2V0IHRoaXMgZmFyLlxuICAgKi9cbiAgZm9yIChjb25zdCBzdGFja05hbWUgb2Ygb3B0aW9ucy5zdGFja05hbWVzKSB7XG4gICAgaWYgKCFtYXRjaGVkU3RhY2tzLmhhcyhzdGFja05hbWUpKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYFN0YWNrICR7c3RhY2tOYW1lfSBwcm9kdWNlZCBubyBDbG91RE5TIGV4cG9ydHNgXG4gICAgICBpZiAob3B0aW9ucy5wcnVuZSAmJiAhb3B0aW9ucy5mb3JjZVBydW5lKSB0aHJvdyBuZXcgRXJyb3IoYCR7bWVzc2FnZX07IHJlZnVzaW5nIHRvIHBydW5lIG9uIGFuIHVudmVyaWZpZWQgc3RhY2sgbmFtZWApXG4gICAgICBjb25zb2xlLndhcm4oJ1dBUk4nLCBtZXNzYWdlKVxuICAgIH1cbiAgfVxuXG4gIGZvciAoY29uc3QgcmVjb3JkIG9mIGRlc2lyZWQpIHtcbiAgICBhd2FpdCBjcmVhdGVPclVwZGF0ZUNsb3VkbnNSZXNvdXJjZShvcHRpb25zLnVzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHJlY29yZCwgb3B0aW9ucy50dGwsIG9wdGlvbnMuZHJ5UnVuKVxuICB9XG5cbiAgaWYgKCFvcHRpb25zLnBydW5lKSByZXR1cm5cblxuICBpZiAoIWRlc2lyZWQubGVuZ3RoICYmICFvcHRpb25zLmZvcmNlUHJ1bmUpIHtcbiAgICBjb25zb2xlLndhcm4oJ1dBUk4gTm8gZXhwb3J0cyBtYXRjaGVkLCBzbyBub3RoaW5nIGlzIGtub3duIHRvIGJlIHdhbnRlZDsgc2tpcHBpbmcgcHJ1bmUuIFVzZSAtLWZvcmNlLXBydW5lIHdpdGggLS16b25lIGlmIHRoaXMgaXMgYSB0ZWFyZG93bi4nKVxuICAgIHJldHVyblxuICB9XG5cbiAgY29uc3Qgem9uZU5hbWVzID0gWy4uLm5ldyBTZXQoWy4uLm9wdGlvbnMuem9uZU5hbWVzLCAuLi5kZXNpcmVkLm1hcCgocmVjb3JkKSA9PiByZWNvcmQuem9uZU5hbWUpXSldXG4gIC8qKlxuICAgKiBOb3RlcyByZWNvcmQgdGhlIHNob3J0IHN0YWNrIG5hbWUsIHNvIHNjb3Bpbmcgb24gdGhlIHJhdyAtLXN0YWNrIHZhbHVlcyB3b3VsZCBzaWxlbnRseSBwcnVuZVxuICAgKiBub3RoaW5nIHdoZW4gb25lIHdhcyBnaXZlbiBhcyBhbiBBUk4uIEJvdGggc3BlbGxpbmdzIGdvIGluOiB0aGUgcmVzb2x2ZWQgbmFtZXMgY292ZXIgdGhlIEFSTlxuICAgKiBjYXNlLCBhbmQgdGhlIHJhdyB2YWx1ZXMgY292ZXIgLS1mb3JjZS1wcnVuZSwgd2hlcmUgYSB0b3JuLWRvd24gc3RhY2sgcmVzb2x2ZXMgdG8gbm90aGluZy5cbiAgICovXG4gIGNvbnN0IHN0YWNrU2NvcGUgPSBvcHRpb25zLnN0YWNrTmFtZXMubGVuZ3RoID8gbmV3IFNldChbLi4ubWF0Y2hlZFN0YWNrTmFtZXMsIC4uLm9wdGlvbnMuc3RhY2tOYW1lc10pIDogdW5kZWZpbmVkXG4gIGF3YWl0IHBydW5lT3JwaGFucyhvcHRpb25zLnVzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHpvbmVOYW1lcywgZGVzaXJlZCwgc3RhY2tTY29wZSwgb3B0aW9ucylcbn1cbiJdfQ==