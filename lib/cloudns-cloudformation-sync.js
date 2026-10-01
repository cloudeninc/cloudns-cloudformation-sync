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
exports.parseExportName = parseExportName;
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
/**
 * Turns an export name into the record it describes: ClouDNS:<type>:<host labels...>.
 *
 * DKIM is the one form that is not a record type. An export name may only hold letters, digits,
 * colons and hyphens, and a DKIM record lives under `_domainkey`, which no export name can spell.
 * So ClouDNS:DKIM:<selector>:example:org stands for the CNAME <selector>._domainkey.example.org -
 * the shape SES Easy DKIM asks for, three of them per domain.
 */
function parseExportName(exportName) {
    const nameParts = exportName.split(':');
    if (nameParts[1] === 'DKIM') {
        const [selector, ...domainParts] = nameParts.slice(2);
        if (!selector || domainParts.length < 2) {
            throw new Error(`Export ${exportName} must be ClouDNS:DKIM:<selector>:<domain labels>`);
        }
        return { resourceType: 'CNAME', resourceName: `${selector}._domainkey.${domainParts.join('.')}` };
    }
    return { resourceType: nameParts[1], resourceName: nameParts.slice(2).join('.') };
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
            const { resourceType, resourceName } = parseExportName(exportObj.Name);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F1Q0c7QUFDSCxvREFBb0U7QUFDcEUsMEVBQTRHO0FBQzVHLE1BQVksV0FBVyx3Q0FBbUI7QUFFMUMscUJBQXFCO0FBQ3JCLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CLEdBQUcsR0FBRyxDQUFBO0FBRXJDLHFGQUFxRjtBQUNyRixNQUFNLFdBQVcsR0FBRyx3Q0FBd0MsQ0FBQTtBQUU1RCwwR0FBMEc7QUFDMUcsTUFBTSxpQkFBaUIsR0FBRyxFQUFFLENBQUE7QUFrQzVCLE1BQU0sS0FBSyxHQUFHOzs7Ozs7Ozs7Ozs7MkVBWTZELGlCQUFpQjs7Ozs7OEZBS0UsQ0FBQTtBQUU5RixtQkFBMEIsSUFBYztJQUN0QyxNQUFNLE9BQU8sR0FBWTtRQUN2QixRQUFRLEVBQUUsRUFBRTtRQUNaLGlCQUFpQixFQUFFLEVBQUU7UUFDckIsR0FBRyxFQUFFLEtBQUs7UUFDVixVQUFVLEVBQUUsRUFBRTtRQUNkLFNBQVMsRUFBRSxFQUFFO1FBQ2IsS0FBSyxFQUFFLEtBQUs7UUFDWixVQUFVLEVBQUUsS0FBSztRQUNqQixRQUFRLEVBQUUsaUJBQWlCO1FBQzNCLE1BQU0sRUFBRSxLQUFLO0tBQ2QsQ0FBQTtJQUVEOzs7O09BSUc7SUFDSCxJQUFJLElBQUksQ0FBQyxNQUFNLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDNUMsT0FBTyxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUE7UUFDMUIsT0FBTyxDQUFDLGlCQUFpQixHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUE7UUFDekM7Ozs7V0FJRztRQUNILE1BQU0sSUFBSSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUE7UUFDMUIsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFLENBQUMsR0FBRyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFBO1FBQzlELE1BQU0sVUFBVSxHQUFHLFNBQVMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxTQUFTLENBQUMsQ0FBQTtRQUNyRSxJQUFJLFVBQVUsQ0FBQyxDQUFDLENBQUM7WUFBRSxPQUFPLENBQUMsR0FBRyxHQUFHLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQTtRQUM5QyxPQUFPLENBQUMsVUFBVSxHQUFHLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUE7UUFDeEMsSUFBSSxTQUFTLEtBQUssQ0FBQyxDQUFDO1lBQUUsVUFBVSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLEVBQUUsT0FBTyxDQUFDLENBQUE7UUFDaEUsT0FBTyxPQUFPLENBQUE7SUFDaEIsQ0FBQztJQUVELFVBQVUsQ0FBQyxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUE7SUFDekIsT0FBTyxPQUFPLENBQUE7QUFDaEIsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLElBQWMsRUFBRSxPQUFnQjtJQUNsRCxNQUFNLElBQUksR0FBRyxDQUFDLEtBQWEsRUFBRSxJQUFZLEVBQVUsRUFBRTtRQUNuRCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFBO1FBQzdCLElBQUksS0FBSyxLQUFLLFNBQVMsSUFBSSxLQUFLLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQztZQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMscUJBQXFCLElBQUksRUFBRSxDQUFDLENBQUE7UUFDOUYsT0FBTyxLQUFLLENBQUE7SUFDZCxDQUFDLENBQUE7SUFFRCxLQUFLLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO1FBQ3JDLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQTtRQUNuQixRQUFRLEdBQUcsRUFBRSxDQUFDO1lBQ1osS0FBSyxJQUFJLENBQUM7WUFDVixLQUFLLFlBQVk7Z0JBQ2YsT0FBTyxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFBO2dCQUMvQixDQUFDLEVBQUUsQ0FBQTtnQkFDSCxNQUFLO1lBQ1AsS0FBSyxJQUFJLENBQUM7WUFDVixLQUFLLHNCQUFzQjtnQkFDekIsT0FBTyxDQUFDLGlCQUFpQixHQUFHLElBQUksQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUE7Z0JBQ3hDLENBQUMsRUFBRSxDQUFBO2dCQUNILE1BQUs7WUFDUCxLQUFLLElBQUksQ0FBQztZQUNWLEtBQUssT0FBTztnQkFDVixPQUFPLENBQUMsR0FBRyxHQUFHLElBQUksQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUE7Z0JBQzFCLENBQUMsRUFBRSxDQUFBO2dCQUNILE1BQUs7WUFDUCxLQUFLLElBQUksQ0FBQztZQUNWLEtBQUssU0FBUztnQkFDWixPQUFPLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUE7Z0JBQ3JDLENBQUMsRUFBRSxDQUFBO2dCQUNILE1BQUs7WUFDUCxLQUFLLElBQUksQ0FBQztZQUNWLEtBQUssUUFBUTtnQkFDWCxPQUFPLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDLENBQUE7Z0JBQ3BDLENBQUMsRUFBRSxDQUFBO2dCQUNILE1BQUs7WUFDUCxLQUFLLFNBQVM7Z0JBQ1osT0FBTyxDQUFDLEtBQUssR0FBRyxJQUFJLENBQUE7Z0JBQ3BCLE1BQUs7WUFDUCxLQUFLLGVBQWU7Z0JBQ2xCLE9BQU8sQ0FBQyxLQUFLLEdBQUcsSUFBSSxDQUFBO2dCQUNwQixPQUFPLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQTtnQkFDekIsTUFBSztZQUNQLEtBQUssYUFBYSxFQUFFLENBQUM7Z0JBQ25CLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDLENBQUE7Z0JBQ3hCLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQTtnQkFDMUIsd0ZBQXdGO2dCQUN4Rix1REFBdUQ7Z0JBQ3ZELElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQU0sR0FBRyxDQUFDO29CQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsa0RBQWtELEdBQUcsRUFBRSxDQUFDLENBQUE7Z0JBQ3JILE9BQU8sQ0FBQyxRQUFRLEdBQUcsTUFBTSxDQUFBO2dCQUN6QixDQUFDLEVBQUUsQ0FBQTtnQkFDSCxNQUFLO1lBQ1AsQ0FBQztZQUNELEtBQUssSUFBSSxDQUFDO1lBQ1YsS0FBSyxXQUFXO2dCQUNkLE9BQU8sQ0FBQyxNQUFNLEdBQUcsSUFBSSxDQUFBO2dCQUNyQixNQUFLO1lBQ1AsS0FBSyxJQUFJLENBQUM7WUFDVixLQUFLLFFBQVE7Z0JBQ1gsT0FBTyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQTtnQkFDbEIsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQTtnQkFDZixNQUFLO1lBQ1AsS0FBSyxJQUFJLENBQUM7WUFDVixLQUFLLFdBQVc7Z0JBQ2QsT0FBTyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQTtnQkFDL0MsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQTtnQkFDZixNQUFLO1lBQ1A7Z0JBQ0UsTUFBTSxJQUFJLEtBQUssQ0FBQyxtQkFBbUIsR0FBRyxFQUFFLENBQUMsQ0FBQTtRQUM3QyxDQUFDO0lBQ0gsQ0FBQztBQUNILENBQUM7QUFFRCxLQUFLLFVBQVUsZUFBZSxDQUM1QixlQUF1QixFQUN2QixlQUF1QixFQUN2QixNQUFjLEVBQ2QsV0FBbUIsRUFDbkIsWUFBaUI7SUFFakIsTUFBTSxPQUFPLEdBQ1gseUJBQXlCO1FBQ3pCLFdBQVc7UUFDWCxHQUFHO1FBQ0gsV0FBVyxDQUFDLFNBQVMsQ0FDbkIsTUFBTSxDQUFDLE1BQU0sQ0FDWDtZQUNFLGVBQWUsRUFBRSxlQUFlO1lBQ2hDLGVBQWUsRUFBRSxlQUFlO1NBQ2pDLEVBQ0QsWUFBWSxJQUFJLEVBQUUsQ0FDbkIsQ0FDRixDQUFBO0lBRUgsTUFBTSxRQUFRLEdBQUcsTUFBTSxLQUFLLENBQUMsT0FBTyxFQUFFO1FBQ3BDLE1BQU0sRUFBRSxNQUFNO1FBQ2QsT0FBTyxFQUFFO1lBQ1AsY0FBYyxFQUFFLGtCQUFrQjtZQUNsQyxNQUFNLEVBQUUsa0JBQWtCO1NBQzNCO0tBQ0YsQ0FBQyxDQUFBO0lBQ0YsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLEVBQUUsQ0FBQztRQUNqQixNQUFNLFNBQVMsR0FBRyxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQTtRQUN2QyxPQUFPLENBQUMsS0FBSyxDQUFDLFlBQVksRUFBRSxRQUFRLENBQUMsTUFBTSxFQUFFLFFBQVEsQ0FBQyxVQUFVLEVBQUUsU0FBUyxDQUFDLENBQUE7UUFDNUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQTtJQUM1QixDQUFDO0lBQ0QsT0FBTyxDQUFDLE1BQU0sUUFBUSxDQUFDLElBQUksRUFBRSxDQUE0QixDQUFBO0FBQzNELENBQUM7QUFFRDs7Ozs7R0FLRztBQUNILFNBQVMsYUFBYSxDQUFDLE1BQVcsRUFBRSxJQUFZO0lBQzlDLE1BQU0sTUFBTSxHQUFHLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxNQUFNLENBQUE7SUFDN0IsSUFBSSxNQUFNLEtBQUssU0FBUyxJQUFJLE1BQU0sS0FBSyxDQUFDLElBQUksTUFBTSxLQUFLLEdBQUc7UUFBRSxPQUFNO0lBQ2xFLE1BQU0sSUFBSSxLQUFLLENBQUMsR0FBRyxJQUFJLFlBQVksQ0FBQSxNQUFNLGFBQU4sTUFBTSx1QkFBTixNQUFNLENBQUUsaUJBQWlCLE1BQUksTUFBTSxhQUFOLE1BQU0sdUJBQU4sTUFBTSxDQUFFLGFBQWEsQ0FBQSxJQUFJLElBQUksQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFBO0FBQ3BILENBQUM7QUFFRCxLQUFLLFVBQVUsNEJBQTRCLENBQUMsZUFBdUIsRUFBRSxlQUF1QixFQUFFLElBQVksRUFBRSxTQUFjO0lBQ3hILE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7SUFFakMsaUNBQWlDO0lBQ2pDLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFBO0lBQ3BFLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUE7SUFFakUsd0NBQXdDO0lBQ3hDLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLFNBQVMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFBO0lBQ3BFLE1BQU0sU0FBUyxHQUFHLFNBQVMsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUE7SUFFakUsMEJBQTBCO0lBQzFCLE1BQU0sYUFBYSxHQUNqQixTQUFTLENBQUMsU0FBUyxDQUFDO1FBQ3BCLENBQUMsTUFBTSxlQUFlLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxLQUFLLEVBQUUseUJBQXlCLEVBQUU7WUFDekYsYUFBYSxFQUFFLFNBQVM7U0FDekIsQ0FBQyxDQUFDLENBQUE7SUFDTCxTQUFTLENBQUMsU0FBUyxDQUFDLEdBQUcsYUFBYSxDQUFBO0lBQ3BDLE1BQU0sYUFBYSxHQUNqQixTQUFTLENBQUMsU0FBUyxDQUFDO1FBQ3BCLENBQUMsTUFBTSxlQUFlLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxLQUFLLEVBQUUseUJBQXlCLEVBQUU7WUFDekYsYUFBYSxFQUFFLFNBQVM7U0FDekIsQ0FBQyxDQUFDLENBQUE7SUFDTCxTQUFTLENBQUMsU0FBUyxDQUFDLEdBQUcsYUFBYSxDQUFBO0lBRXBDLE1BQU0sUUFBUSxHQUFHLGFBQWEsQ0FBQyxNQUFNLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxNQUFNLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQTtJQUN6RyxNQUFNLFFBQVEsR0FBRyxhQUFhLENBQUMsTUFBTSxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsTUFBTSxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUE7SUFDekcsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1FBQ2Qsc0JBQXNCO1FBQ3RCLE1BQU0sSUFBSSxLQUFLLENBQUMsa0JBQWtCLEdBQUcsSUFBSSxDQUFDLENBQUE7SUFDNUMsQ0FBQztJQUNELE9BQU87UUFDTCxRQUFRLEVBQUUsUUFBUTtRQUNsQixRQUFRLEVBQUUsUUFBUTtLQUNuQixDQUFBO0FBQ0gsQ0FBQztBQUVEOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLGdCQUFnQixHQUFHLElBQUksR0FBRyxFQUEyQixDQUFBO0FBRTNELEtBQUssVUFBVSxlQUFlLENBQUMsZUFBdUIsRUFBRSxlQUF1QixFQUFFLFFBQWdCLEVBQUUsS0FBSyxHQUFHLEtBQUs7SUFDOUcsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ1gsTUFBTSxNQUFNLEdBQUcsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFBO1FBQzdDLElBQUksTUFBTTtZQUFFLE9BQU8sTUFBTSxDQUFBO0lBQzNCLENBQUM7SUFDRCxNQUFNLFFBQVEsR0FBRyxNQUFNLGVBQWUsQ0FBQyxlQUFlLEVBQUUsZUFBZSxFQUFFLEtBQUssRUFBRSxtQkFBbUIsRUFBRTtRQUNuRyxhQUFhLEVBQUUsUUFBUTtRQUN2QixlQUFlLEVBQUUsR0FBRztLQUNyQixDQUFDLENBQUE7SUFDRiwwRUFBMEU7SUFDMUUsTUFBTSxPQUFPLEdBQUcsQ0FBQyxRQUFRLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBRSxNQUFNLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBcUIsQ0FBQTtJQUN4RyxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsUUFBUSxFQUFFLE9BQU8sQ0FBQyxDQUFBO0lBQ3ZDLE9BQU8sT0FBTyxDQUFBO0FBQ2hCLENBQUM7QUFFRCxTQUFTLGFBQWEsQ0FBQyxTQUFpQixFQUFFLFVBQWtCO0lBQzFELE9BQU8sR0FBRyxXQUFXLFVBQVUsU0FBUyxXQUFXLFVBQVUsRUFBRSxDQUFBO0FBQ2pFLENBQUM7QUFFRCxvRkFBb0Y7QUFDcEYsU0FBUyxhQUFhLENBQUMsTUFBcUI7SUFDMUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQUUsT0FBTyxTQUFTLENBQUE7SUFDN0UsTUFBTSxLQUFLLEdBQUcsYUFBYSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUE7SUFDN0MsT0FBTyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFBO0FBQzlCLENBQUM7QUFFRCxLQUFLLFVBQVUsYUFBYSxDQUMxQixlQUF1QixFQUN2QixlQUF1QixFQUN2QixRQUFnQixFQUNoQixRQUFnQixFQUNoQixJQUFZLEVBQ1osTUFBZTtJQUVmLElBQUksTUFBTTtRQUFFLE9BQU07SUFDbEIsTUFBTSxNQUFNLEdBQUcsTUFBTSxlQUFlLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxNQUFNLEVBQUUsMkJBQTJCLEVBQUU7UUFDMUcsYUFBYSxFQUFFLFFBQVE7UUFDdkIsV0FBVyxFQUFFLFFBQVE7UUFDckIsSUFBSSxFQUFFLElBQUk7S0FDWCxDQUFDLENBQUE7SUFDRixhQUFhLENBQUMsTUFBTSxFQUFFLGlCQUFpQixDQUFDLENBQUE7SUFDeEMsZ0JBQWdCLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFBO0FBQ25DLENBQUM7QUFFRCxLQUFLLFVBQVUsNkJBQTZCLENBQzFDLGVBQXVCLEVBQ3ZCLGVBQXVCLEVBQ3ZCLE9BQXNCLEVBQ3RCLFFBQWdCLEVBQ2hCLE1BQWU7O0lBRWYsTUFBTSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxHQUFHLE9BQU8sQ0FBQTtJQUNuRCxNQUFNLElBQUksR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsUUFBUSxJQUFJLFFBQVEsRUFBRSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUE7SUFFNUQsTUFBTSxPQUFPLEdBQUcsTUFBTSxlQUFlLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxRQUFRLENBQUMsQ0FBQTtJQUNqRjs7OztPQUlHO0lBQ0gsTUFBTSxRQUFRLEdBQUcsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksS0FBSyxRQUFRLElBQUksTUFBTSxDQUFDLElBQUksS0FBSyxJQUFJLENBQUMsQ0FBQTtJQUM3RixJQUFJLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDeEIsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsUUFBUSxDQUFDLE1BQU0sRUFBRSxrREFBa0QsQ0FBQyxDQUFBO0lBQzlHLENBQUM7SUFDRCxNQUFNLGNBQWMsR0FBRyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDbEMsTUFBTSxJQUFJLEdBQUcsYUFBYSxDQUFDLE9BQU8sQ0FBQyxTQUFTLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFBO0lBRWpFLElBQUksY0FBYyxJQUFJLGNBQWMsQ0FBQyxNQUFNLEtBQUssS0FBSyxJQUFJLE1BQU0sQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLEtBQUssTUFBTSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7UUFDekcsSUFBSSxjQUFjLENBQUMsSUFBSSxLQUFLLElBQUksRUFBRSxDQUFDO1lBQ2pDLE9BQU8sQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxRQUFRLENBQUMsQ0FBQTtRQUNwRixDQUFDO2FBQU0sQ0FBQztZQUNOLDBGQUEwRjtZQUMxRixPQUFPLENBQUMsR0FBRyxDQUFDLE9BQU8sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxNQUFNLEVBQUUsUUFBUSxDQUFDLENBQUE7WUFDckYsTUFBTSxhQUFhLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxRQUFRLEVBQUUsY0FBYyxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxDQUFDLENBQUE7UUFDbEcsQ0FBQztRQUNELE9BQU07SUFDUixDQUFDO0lBRUQsSUFBSSxjQUFjLEVBQUUsQ0FBQztRQUNuQixPQUFPLENBQUMsR0FBRyxDQUFDLFFBQVEsRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLFFBQVEsRUFBRSxNQUFNLEVBQUUsUUFBUSxDQUFDLENBQUE7UUFDdEYsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ1osTUFBTSxNQUFNLEdBQUcsTUFBTSxlQUFlLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxNQUFNLEVBQUUsc0JBQXNCLEVBQUU7Z0JBQ3JHLGFBQWEsRUFBRSxRQUFRO2dCQUN2QixXQUFXLEVBQUUsY0FBYyxDQUFDLEVBQUU7Z0JBQzlCLElBQUksRUFBRSxRQUFRO2dCQUNkLGFBQWEsRUFBRSxJQUFJO2dCQUNuQixNQUFNLEVBQUUsS0FBSztnQkFDYixHQUFHLEVBQUUsUUFBUTthQUNkLENBQUMsQ0FBQTtZQUNGLGFBQWEsQ0FBQyxNQUFNLEVBQUUsZUFBZSxDQUFDLENBQUE7WUFDdEMsTUFBTSxhQUFhLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxRQUFRLEVBQUUsY0FBYyxDQUFDLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxDQUFDLENBQUE7WUFDaEcsTUFBTSxZQUFZLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxPQUFPLEVBQUUsUUFBUSxDQUFDLENBQUE7UUFDekUsQ0FBQztRQUNELE9BQU07SUFDUixDQUFDO0lBRUQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxRQUFRLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxRQUFRLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUFBO0lBQ3RGLElBQUksTUFBTTtRQUFFLE9BQU07SUFDbEIsTUFBTSxNQUFNLEdBQUcsTUFBTSxlQUFlLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxNQUFNLEVBQUUsc0JBQXNCLEVBQUU7UUFDckcsYUFBYSxFQUFFLFFBQVE7UUFDdkIsSUFBSSxFQUFFLFFBQVE7UUFDZCxhQUFhLEVBQUUsSUFBSTtRQUNuQixNQUFNLEVBQUUsS0FBSztRQUNiLEdBQUcsRUFBRSxRQUFRO0tBQ2QsQ0FBQyxDQUFBO0lBQ0YsYUFBYSxDQUFDLE1BQU0sRUFBRSxZQUFZLENBQUMsQ0FBQTtJQUNuQyxNQUFNLFNBQVMsR0FBRyxNQUFBLE1BQU0sYUFBTixNQUFNLHVCQUFOLE1BQU0sQ0FBRSxJQUFJLDBDQUFFLEVBQUUsQ0FBQTtJQUNsQyxJQUFJLFNBQVM7UUFBRSxNQUFNLGFBQWEsQ0FBQyxlQUFlLEVBQUUsZUFBZSxFQUFFLFFBQVEsRUFBRSxNQUFNLENBQUMsU0FBUyxDQUFDLEVBQUUsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFBO0lBQy9HLE1BQU0sWUFBWSxDQUFDLGVBQWUsRUFBRSxlQUFlLEVBQUUsT0FBTyxFQUFFLFFBQVEsQ0FBQyxDQUFBO0FBQ3pFLENBQUM7QUFFRDs7Ozs7O0dBTUc7QUFDSCxLQUFLLFVBQVUsWUFBWSxDQUFDLGVBQXVCLEVBQUUsZUFBdUIsRUFBRSxPQUFzQixFQUFFLFFBQWdCO0lBQ3BILE1BQU0sT0FBTyxHQUFHLE1BQU0sZUFBZSxDQUFDLGVBQWUsRUFBRSxlQUFlLEVBQUUsT0FBTyxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsQ0FBQTtJQUMvRixNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsSUFBSSxLQUFLLE9BQU8sQ0FBQyxRQUFRLElBQUksTUFBTSxDQUFDLElBQUksS0FBSyxPQUFPLENBQUMsSUFBSSxDQUFDLENBQUE7SUFDekcsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ1osTUFBTSxJQUFJLEtBQUssQ0FBQyx3QkFBd0IsT0FBTyxDQUFDLFFBQVEsSUFBSSxPQUFPLENBQUMsUUFBUSxJQUFJLE9BQU8sQ0FBQyxJQUFJLHlCQUF5QixDQUFDLENBQUE7SUFDeEgsQ0FBQztJQUNELElBQUksTUFBTSxDQUFDLE1BQU0sS0FBSyxPQUFPLENBQUMsS0FBSyxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLEtBQUssTUFBTSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7UUFDL0UsTUFBTSxJQUFJLEtBQUssQ0FDYix3QkFBd0IsT0FBTyxDQUFDLFFBQVEsSUFBSSxPQUFPLENBQUMsUUFBUSxJQUFJLE9BQU8sQ0FBQyxJQUFJLE9BQU8sTUFBTSxDQUFDLE1BQU0sU0FBUyxNQUFNLENBQUMsR0FBRyxlQUFlLE9BQU8sQ0FBQyxLQUFLLFNBQVMsUUFBUSxHQUFHLENBQ3BLLENBQUE7SUFDSCxDQUFDO0FBQ0gsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILEtBQUssVUFBVSxZQUFZLENBQ3pCLGVBQXVCLEVBQ3ZCLGVBQXVCLEVBQ3ZCLFNBQW1CLEVBQ25CLE9BQXdCLEVBQ3hCLFVBQW1DLEVBQ25DLE9BQWdCO0lBRWhCLE1BQU0sV0FBVyxHQUFHLElBQUksR0FBRyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLEdBQUcsTUFBTSxDQUFDLFFBQVEsSUFBSSxNQUFNLENBQUMsUUFBUSxJQUFJLE1BQU0sQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUE7SUFDNUcsTUFBTSxPQUFPLEdBQWtELEVBQUUsQ0FBQTtJQUVqRSxLQUFLLE1BQU0sUUFBUSxJQUFJLFNBQVMsRUFBRSxDQUFDO1FBQ2pDLEtBQUssTUFBTSxNQUFNLElBQUksTUFBTSxlQUFlLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxRQUFRLEVBQUUsSUFBSSxDQUFDLEVBQUUsQ0FBQztZQUM3RixNQUFNLEtBQUssR0FBRyxhQUFhLENBQUMsTUFBTSxDQUFDLENBQUE7WUFDbkMsSUFBSSxLQUFLLEtBQUssU0FBUztnQkFBRSxTQUFRLENBQUMsV0FBVztZQUM3QyxJQUFJLFVBQVUsSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDO2dCQUFFLFNBQVEsQ0FBQyxrQkFBa0I7WUFDckUsSUFBSSxXQUFXLENBQUMsR0FBRyxDQUFDLEdBQUcsUUFBUSxJQUFJLE1BQU0sQ0FBQyxJQUFJLElBQUksTUFBTSxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUFFLFNBQVEsQ0FBQyxlQUFlO1lBQzFGLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxRQUFRLEVBQUUsTUFBTSxFQUFFLENBQUMsQ0FBQTtRQUNwQyxDQUFDO0lBQ0gsQ0FBQztJQUVELElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDcEIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxZQUFZLENBQUMsQ0FBQTtRQUN6QixPQUFNO0lBQ1IsQ0FBQztJQUVELEtBQUssTUFBTSxFQUFFLFFBQVEsRUFBRSxNQUFNLEVBQUUsSUFBSSxPQUFPLEVBQUUsQ0FBQztRQUMzQyxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxHQUFHLE1BQU0sQ0FBQyxJQUFJLElBQUksUUFBUSxFQUFFLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQTtRQUNsRSxPQUFPLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxFQUFFLE1BQU0sQ0FBQyxNQUFNLEVBQUUsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUFBO0lBQzNHLENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsTUFBTSxHQUFHLE9BQU8sQ0FBQyxRQUFRLENBQUE7SUFDakQsSUFBSSxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDbkIsSUFBSSxPQUFPO1lBQUUsT0FBTyxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsNEJBQTRCLE9BQU8sQ0FBQyxNQUFNLGdDQUFnQyxPQUFPLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQTtRQUMvSCxPQUFNO0lBQ1IsQ0FBQztJQUNELElBQUksT0FBTyxFQUFFLENBQUM7UUFDWixNQUFNLElBQUksS0FBSyxDQUFDLHNCQUFzQixPQUFPLENBQUMsTUFBTSw4QkFBOEIsT0FBTyxDQUFDLFFBQVEsMENBQTBDLENBQUMsQ0FBQTtJQUMvSSxDQUFDO0lBRUQsS0FBSyxNQUFNLEVBQUUsUUFBUSxFQUFFLE1BQU0sRUFBRSxJQUFJLE9BQU8sRUFBRSxDQUFDO1FBQzNDLE1BQU0sTUFBTSxHQUFHLE1BQU0sZUFBZSxDQUFDLGVBQWUsRUFBRSxlQUFlLEVBQUUsTUFBTSxFQUFFLHlCQUF5QixFQUFFO1lBQ3hHLGFBQWEsRUFBRSxRQUFRO1lBQ3ZCLFdBQVcsRUFBRSxNQUFNLENBQUMsRUFBRTtTQUN2QixDQUFDLENBQUE7UUFDRixhQUFhLENBQUMsTUFBTSxFQUFFLGVBQWUsQ0FBQyxDQUFBO0lBQ3hDLENBQUM7QUFDSCxDQUFDO0FBRUQ7Ozs7Ozs7R0FPRztBQUNILHlCQUFnQyxVQUFrQjtJQUNoRCxNQUFNLFNBQVMsR0FBRyxVQUFVLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFBO0lBQ3ZDLElBQUksU0FBUyxDQUFDLENBQUMsQ0FBQyxLQUFLLE1BQU0sRUFBRSxDQUFDO1FBQzVCLE1BQU0sQ0FBQyxRQUFRLEVBQUUsR0FBRyxXQUFXLENBQUMsR0FBRyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFBO1FBQ3JELElBQUksQ0FBQyxRQUFRLElBQUksV0FBVyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUN4QyxNQUFNLElBQUksS0FBSyxDQUFDLFVBQVUsVUFBVSxrREFBa0QsQ0FBQyxDQUFBO1FBQ3pGLENBQUM7UUFDRCxPQUFPLEVBQUUsWUFBWSxFQUFFLE9BQU8sRUFBRSxZQUFZLEVBQUUsR0FBRyxRQUFRLGVBQWUsV0FBVyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxFQUFFLENBQUE7SUFDbkcsQ0FBQztJQUNELE9BQU8sRUFBRSxZQUFZLEVBQUUsU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLFlBQVksRUFBRSxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFBO0FBQ25GLENBQUM7QUFFTSxLQUFLOztJQUNWLHVGQUF1RjtJQUN2RixNQUFNLE9BQU8sR0FBRyxTQUFTLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQTtJQUNoRCxPQUFPLENBQUMsR0FBRyxDQUFDLDJGQUEyRixDQUFDLENBQUE7SUFFeEcsSUFBSSxDQUFDLE9BQU8sQ0FBQyxRQUFRLElBQUksQ0FBQyxPQUFPLENBQUMsaUJBQWlCLEVBQUUsQ0FBQztRQUNwRCxPQUFPLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFBO1FBQ3BCLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDakIsQ0FBQztJQUNELElBQUksT0FBTyxDQUFDLFVBQVUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDcEQsT0FBTyxDQUFDLEtBQUssQ0FBQyxnR0FBZ0csQ0FBQyxDQUFBO1FBQy9HLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDakIsQ0FBQztJQUVELE1BQU0sR0FBRyxHQUFHLElBQUksc0JBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQTtJQUM3QixNQUFNLFNBQVMsR0FBRyxFQUFFLENBQUE7SUFFcEIsTUFBTSxRQUFRLEdBQUcsTUFBTSxHQUFHLENBQUMsSUFBSSxDQUM3QixJQUFJLGdDQUFtQixDQUFDO1FBQ3RCLElBQUksRUFBRSxPQUFPLENBQUMsaUJBQWlCO1FBQy9CLGNBQWMsRUFBRSxJQUFJO0tBQ3JCLENBQUMsQ0FDSCxDQUFBO0lBQ0QsTUFBTSxlQUFlLEdBQUcsQ0FBQSxNQUFBLFFBQVEsQ0FBQyxTQUFTLDBDQUFFLEtBQUssS0FBSSxFQUFFLENBQUE7SUFFdkQsaUdBQWlHO0lBQ2pHLCtFQUErRTtJQUMvRSxNQUFNLE9BQU8sR0FBb0IsRUFBRSxDQUFBO0lBQ25DLCtGQUErRjtJQUMvRixNQUFNLGFBQWEsR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFBO0lBQ3ZDLG1HQUFtRztJQUNuRyxNQUFNLGlCQUFpQixHQUFHLElBQUksR0FBRyxFQUFVLENBQUE7SUFDM0MsTUFBTSxjQUFjLEdBQUcsSUFBSSw0Q0FBb0IsQ0FBQyxFQUFFLENBQUMsQ0FBQTtJQUNuRCxJQUFJLFNBQVMsQ0FBQTtJQUNiLEdBQUcsQ0FBQztRQUNGLE1BQU0sUUFBUSxHQUFzQixNQUFNLGNBQWMsQ0FBQyxJQUFJLENBQUMsSUFBSSwwQ0FBa0IsQ0FBQyxFQUFFLFNBQVMsRUFBRSxTQUFTLEVBQUUsQ0FBQyxDQUFDLENBQUE7UUFDL0csS0FBSyxNQUFNLFNBQVMsSUFBSSxRQUFRLENBQUMsT0FBTyxJQUFJLEVBQUUsRUFBRSxDQUFDO1lBQy9DLE1BQU0sVUFBVSxHQUFHLE1BQUEsU0FBUyxDQUFDLGdCQUFnQiwwQ0FBRSxLQUFLLENBQUMsd0RBQXdELENBQUMsQ0FBQTtZQUM5RyxNQUFNLFNBQVMsR0FBRyxVQUFVLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLGdCQUFnQixJQUFJLEVBQUUsQ0FBQTtZQUMvRSxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsTUFBTSxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLGdCQUFnQixJQUFJLEVBQUUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztnQkFDM0ksU0FBUTtZQUNWLENBQUM7WUFDRCxJQUFJLEVBQUMsTUFBQSxTQUFTLENBQUMsSUFBSSwwQ0FBRSxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUE7Z0JBQUUsU0FBUTtZQUVqRCxNQUFNLEVBQUUsWUFBWSxFQUFFLFlBQVksRUFBRSxHQUFHLGVBQWUsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUE7WUFDdEUsTUFBTSxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsR0FBRyxNQUFNLDRCQUE0QixDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUUsZUFBZSxFQUFFLFlBQVksRUFBRSxTQUFTLENBQUMsQ0FBQTtZQUM3SCxhQUFhLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFBO1lBQzVCLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQTtZQUNoQyxJQUFJLFNBQVMsQ0FBQyxnQkFBZ0I7Z0JBQUUsYUFBYSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsZ0JBQWdCLENBQUMsQ0FBQTtZQUM3RSxPQUFPLENBQUMsSUFBSSxDQUFDO2dCQUNYLFFBQVE7Z0JBQ1IsUUFBUTtnQkFDUixJQUFJLEVBQUUsWUFBWTtnQkFDbEIsS0FBSyxFQUFFLFNBQVMsQ0FBQyxLQUFNO2dCQUN2QixTQUFTO2dCQUNULFVBQVUsRUFBRSxTQUFTLENBQUMsSUFBSTthQUMzQixDQUFDLENBQUE7UUFDSixDQUFDO1FBQ0QsU0FBUyxHQUFHLFFBQVEsQ0FBQyxTQUFTLENBQUE7SUFDaEMsQ0FBQyxRQUFRLFNBQVMsRUFBQztJQUVuQjs7Ozs7OztPQU9HO0lBQ0gsS0FBSyxNQUFNLFNBQVMsSUFBSSxPQUFPLENBQUMsVUFBVSxFQUFFLENBQUM7UUFDM0MsSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQztZQUNsQyxNQUFNLE9BQU8sR0FBRyxTQUFTLFNBQVMsOEJBQThCLENBQUE7WUFDaEUsSUFBSSxPQUFPLENBQUMsS0FBSyxJQUFJLENBQUMsT0FBTyxDQUFDLFVBQVU7Z0JBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxHQUFHLE9BQU8saURBQWlELENBQUMsQ0FBQTtZQUN0SCxPQUFPLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxPQUFPLENBQUMsQ0FBQTtRQUMvQixDQUFDO0lBQ0gsQ0FBQztJQUVELEtBQUssTUFBTSxNQUFNLElBQUksT0FBTyxFQUFFLENBQUM7UUFDN0IsTUFBTSw2QkFBNkIsQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFFLGVBQWUsRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLEdBQUcsRUFBRSxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUE7SUFDN0csQ0FBQztJQUVELElBQUksQ0FBQyxPQUFPLENBQUMsS0FBSztRQUFFLE9BQU07SUFFMUIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLElBQUksQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLENBQUM7UUFDM0MsT0FBTyxDQUFDLElBQUksQ0FBQyxpSUFBaUksQ0FBQyxDQUFBO1FBQy9JLE9BQU07SUFDUixDQUFDO0lBRUQsTUFBTSxTQUFTLEdBQUcsQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsU0FBUyxFQUFFLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBO0lBQ25HOzs7O09BSUc7SUFDSCxNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUFHLGlCQUFpQixFQUFFLEdBQUcsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQTtJQUNqSCxNQUFNLFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFFLGVBQWUsRUFBRSxTQUFTLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxPQUFPLENBQUMsQ0FBQTtBQUNoRyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZWFkIEFXUyBDbG91ZEZvcm1hdGlvbiBFeHBvcnRzIGFuZCBhdXRvZ2VuZXJhdGUgQ2xvdUROUyByZWNvcmRzIGJhc2VkIG9uIHRoZWlyIG5hbWVzIGFuZCB2YWx1ZXMuXG4gKiBLZW5uZXRoIEZhbGNrIDxrZW5udUBjbG91ZGVuLm5ldD4gKEMpIENsb3VkZW4gT3kgMjAyMC0yMDI2XG4gKlxuICogVGhpcyB0b29sIGNhbiBiZSB1c2VkIHRvIGF1dG9nZW5lcmF0ZSBDbG91RE5TIHJlY29yZHMgZm9yIENsb3VkRm9ybWF0aW9uIHJlc291cmNlcyBsaWtlXG4gKiBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbnMgYW5kIEFQSSBHYXRld2F5IGRvbWFpbnMuXG4gKlxuICogQ2xvdWRGb3JtYXRpb24gZXhwb3J0IG5hbWUgbXVzdCBzcGVjaWZ5IHRoZSByZXNvdXJjZSB0eXBlIGFuZCByZWNvcmQgaG9zdG5hbWUgYXMgZm9sbG93czpcbiAqIENsb3VETlM6Q05BTUU6bXlob3N0OmV4YW1wbGU6b3JnXG4gKlxuICogQ2xvdWRGb3JtYXRpb24gZXhwb3J0IHZhbHVlIG11c3Qgc3BlY2lmeSB0aGUgcmVjb3JkIHZhbHVlIGFzLWlzIChmb3IgaW5zdGFuY2UsIGEgZGlzdHJpYnV0aW9uIGRvbWFpbiBuYW1lKTpcbiAqIHh4eHh4eHh4eHh4eHh4LmNsb3VkZnJvbnQubmV0XG4gKlxuICogVGhlIGFib3ZlIGV4YW1wbGUgd2lsbCBnZW5lcmF0ZSB0aGUgZm9sbG93aW5nIHJlY29yZCBpbiB0aGUgQ2xvdUROUyB6b25lIGV4YW1wbGUub3JnOlxuICogbXlob3N0LmV4YW1wbGUub3JnIENOQU1FIHh4eHh4eHh4eHh4eHh4LmNsb3VkZnJvbnQubmV0XG4gKlxuICogT3RoZXIgcmVzb3VyY2UgdHlwZXMgYXJlIGFsc28gYWxsb3dlZCAoQSwgQUFBQSwgQUxJQVMsIGV0YykuXG4gKlxuICogIyMgT3duZXJzaGlwIGFuZCBwcnVuaW5nXG4gKlxuICogRXZlcnkgcmVjb3JkIHRoaXMgdG9vbCB3cml0ZXMgaXMgc3RhbXBlZCB3aXRoIGEgQ2xvdUROUyByZWNvcmQgbm90ZSBuYW1pbmcgdGhlIHRvb2wsIHRoZSBzdGFja1xuICogd2hvc2UgZXhwb3J0IHByb2R1Y2VkIGl0LCBhbmQgdGhhdCBleHBvcnQuIFRoZSBub3RlIGlzIHdoYXQgbWFrZXMgZGVsZXRpb24gc2FmZTogYSB6b25lIGhvbGRzXG4gKiBwbGVudHkgb2YgcmVjb3JkcyBub2JvZHkgaGVyZSBjcmVhdGVkLCBhbmQgd2l0aG91dCBhIG1hcmtlciB0aGVyZSBpcyBubyB3YXkgdG8gdGVsbCBhbiBvcnBoYW5cbiAqIGxlZnQgYmVoaW5kIGJ5IGEgZGVsZXRlZCBleHBvcnQgZnJvbSBzb21ldGhpbmcgYSBodW1hbiBhZGRlZCBieSBoYW5kLiBSZWNvcmRzIHdpdGhvdXQgdGhlIG1hcmtlclxuICogYXJlIG5ldmVyIGNhbmRpZGF0ZXMgZm9yIGRlbGV0aW9uLlxuICpcbiAqIFN0YW1waW5nIGhhcHBlbnMgb24gZXZlcnkgc3luYywgc28gcmVjb3JkcyBjcmVhdGVkIGJlZm9yZSB0aGlzIGZlYXR1cmUgYXJlIGFkb3B0ZWQgdGhlIG5leHQgdGltZVxuICogdGhleSBhcmUgc2Vlbi4gVGhhdCBpcyBzYWZlIGJlY2F1c2UgYSByZWNvcmQgaXMgb25seSBldmVyIHN0YW1wZWQgd2hlbiBhbiBleHBvcnQgY3VycmVudGx5IGNsYWltc1xuICogaXQg4oCUIHRoZSB0b29sIGlzIGFscmVhZHkgb3ZlcndyaXRpbmcgdGhhdCByZWNvcmQncyB2YWx1ZSwgc28gaXQgYWxyZWFkeSBvd25zIGl0LlxuICpcbiAqIFBydW5pbmcgaXMgb3B0LWluIGFuZCBuZXZlciBoYXBwZW5zIGJ5IGFjY2lkZW50OlxuICpcbiAqICAgLS1wcnVuZSAgICAgICAgZGVsZXRlIG1hbmFnZWQgcmVjb3JkcyB3aG9zZSBleHBvcnQgaXMgZ29uZSwgYnV0IG9ubHkgd2hlbiB0aGlzIHJ1biBhY3R1YWxseVxuICogICAgICAgICAgICAgICAgICBmb3VuZCBleHBvcnRzLiBBbiBlbXB0eSBleHBvcnQgc2V0IGlzIGZhciBtb3JlIGxpa2VseSBhIHdyb25nIC0tc3RhY2sgb3IgYW4gQVdTXG4gKiAgICAgICAgICAgICAgICAgIGVycm9yIHRoYW4gYSBnZW51aW5lIGluc3RydWN0aW9uIHRvIGRlbGV0ZSBldmVyeSByZWNvcmQuXG4gKiAgIC0tZm9yY2UtcHJ1bmUgIGFsc28gcHJ1bmUgd2hlbiB0aGUgZXhwb3J0IHNldCBpcyBlbXB0eSwgZm9yIHRoZSByZWFsIHRlYXJkb3duIGNhc2UuIFJlcXVpcmVzIGFuXG4gKiAgICAgICAgICAgICAgICAgIGV4cGxpY2l0IC0tem9uZSwgYmVjYXVzZSB3aXRoIG5vIGV4cG9ydHMgdGhlcmUgaXMgbm90aGluZyB0byBpbmZlciBhIHpvbmUgZnJvbS5cbiAqXG4gKiBBIGNhcCBvbiBob3cgbWFueSByZWNvcmRzIG9uZSBydW4gbWF5IGRlbGV0ZSBhcHBsaWVzIHRvIGJvdGguXG4gKi9cbmltcG9ydCB7IFNTTUNsaWVudCwgR2V0UGFyYW1ldGVyQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zc20nXG5pbXBvcnQgeyBDbG91ZEZvcm1hdGlvbkNsaWVudCwgTGlzdEV4cG9ydHNDb21tYW5kLCBMaXN0RXhwb3J0c091dHB1dCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1jbG91ZGZvcm1hdGlvbidcbmltcG9ydCAqIGFzIHF1ZXJ5c3RyaW5nIGZyb20gJ3F1ZXJ5c3RyaW5nJ1xuXG4vLyBMb2FkIH4vLmF3cy9jb25maWdcbnByb2Nlc3MuZW52LkFXU19TREtfTE9BRF9DT05GSUcgPSAnMSdcblxuLyoqIE1hcmtzIGEgcmVjb3JkIGFzIG91cnMuIFByZXNlbnQgaW4gdGhlIG5vdGUgb2YgZXZlcnkgcmVjb3JkIHRoaXMgdG9vbCBtYW5hZ2VzLiAqL1xuY29uc3QgTk9URV9NQVJLRVIgPSAnbWFuYWdlZC1ieT1jbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMnXG5cbi8qKiBNb3N0IHJlY29yZHMgb25lIHJ1biB3aWxsIGRlbGV0ZSBiZWZvcmUgcmVmdXNpbmcuIFJhaXNlIHdpdGggLS1tYXgtcHJ1bmUgd2hlbiBpdCBpcyBnZW51aW5lbHkgbW9yZS4gKi9cbmNvbnN0IERFRkFVTFRfTUFYX1BSVU5FID0gMTBcblxudHlwZSBDbG91ZG5zUmVzdENhbGxSZXNwb25zZSA9IGFueVxuXG5pbnRlcmZhY2UgT3B0aW9ucyB7XG4gIHVzZXJuYW1lOiBzdHJpbmdcbiAgcGFzc3dvcmRQYXJhbWV0ZXI6IHN0cmluZ1xuICB0dGw6IHN0cmluZ1xuICBzdGFja05hbWVzOiBzdHJpbmdbXVxuICB6b25lTmFtZXM6IHN0cmluZ1tdXG4gIHBydW5lOiBib29sZWFuXG4gIGZvcmNlUHJ1bmU6IGJvb2xlYW5cbiAgbWF4UHJ1bmU6IG51bWJlclxuICBkcnlSdW46IGJvb2xlYW5cbn1cblxuaW50ZXJmYWNlIERlc2lyZWRSZWNvcmQge1xuICB6b25lTmFtZTogc3RyaW5nXG4gIGhvc3ROYW1lOiBzdHJpbmdcbiAgdHlwZTogc3RyaW5nXG4gIHZhbHVlOiBzdHJpbmdcbiAgc3RhY2tOYW1lOiBzdHJpbmdcbiAgZXhwb3J0TmFtZTogc3RyaW5nXG59XG5cbmludGVyZmFjZSBDbG91ZG5zUmVjb3JkIHtcbiAgaWQ6IHN0cmluZ1xuICBob3N0OiBzdHJpbmdcbiAgdHlwZTogc3RyaW5nXG4gIHR0bDogc3RyaW5nXG4gIHJlY29yZDogc3RyaW5nXG4gIG5vdGU/OiBzdHJpbmdcbn1cblxuY29uc3QgVVNBR0UgPSBgQ2xvdUROUyBDbG91ZEZvcm1hdGlvbiBTeW5jXG5cblVzYWdlOiBjbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMgLXUgPHVzZXJuYW1lPiAtcCA8cGFzc3dvcmQtcGFyYW1ldGVyPiBbb3B0aW9uc11cbiAgICAgICBjbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMgPHVzZXJuYW1lPiA8cGFzc3dvcmQtcGFyYW1ldGVyPiBbdHRsIFtzdGFjay4uLl1dICAgKGxlZ2FjeSlcblxuICAtdSwgLS11c2VybmFtZSA8bmFtZT4gICAgICAgICBDbG91RE5TIEFQSSBzdWItYXV0aC11c2VyXG4gIC1wLCAtLXBhc3N3b3JkLXBhcmFtZXRlciA8cD4gIFNTTSBwYXJhbWV0ZXIgaG9sZGluZyB0aGUgZW5jcnlwdGVkIENsb3VETlMgQVBJIHBhc3N3b3JkXG4gIC10LCAtLXR0bCA8c2Vjb25kcz4gICAgICAgICAgIFRUTCBmb3IgZ2VuZXJhdGVkIHJlY29yZHMgKGRlZmF1bHQgMzAwKVxuICAtcywgLS1zdGFjayA8bmFtZXxhcm4+ICAgICAgICBMaW1pdCB0byB0aGlzIENsb3VkRm9ybWF0aW9uIHN0YWNrOyByZXBlYXRhYmxlXG4gIC16LCAtLXpvbmUgPG5hbWU+ICAgICAgICAgICAgIEFsc28gc2NhbiB0aGlzIHpvbmUgd2hlbiBwcnVuaW5nOyByZXBlYXRhYmxlXG4gICAgICAtLXBydW5lICAgICAgICAgICAgICAgICAgIERlbGV0ZSBtYW5hZ2VkIHJlY29yZHMgd2hvc2UgZXhwb3J0IGlzIGdvbmVcbiAgICAgIC0tZm9yY2UtcHJ1bmUgICAgICAgICAgICAgQWxzbyBwcnVuZSB3aGVuIG5vIGV4cG9ydHMgd2VyZSBmb3VuZDsgcmVxdWlyZXMgLS16b25lXG4gICAgICAtLW1heC1wcnVuZSA8bj4gICAgICAgICAgIE1vc3QgcmVjb3JkcyBvbmUgcnVuIG1heSBkZWxldGUgKGRlZmF1bHQgJHtERUZBVUxUX01BWF9QUlVORX0pXG4gIC1uLCAtLWRyeS1ydW4gICAgICAgICAgICAgICAgIFJlcG9ydCB3aGF0IHdvdWxkIGNoYW5nZSB3aXRob3V0IGNoYW5naW5nIGl0XG4gIC1oLCAtLWhlbHAgICAgICAgICAgICAgICAgICAgIFNob3cgdGhpcyBoZWxwXG4gIC1WLCAtLXZlcnNpb24gICAgICAgICAgICAgICAgIFNob3cgdGhlIHZlcnNpb25cblxuQVdTX1BST0ZJTEUgc2VsZWN0cyB0aGUgQVdTIGNyZWRlbnRpYWxzLCBhcyB1c3VhbC4gREVCVUc9MSBwcmludHMgZnVsbCBzdGFjayB0cmFjZXMgb24gZXJyb3IuYFxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VBcmdzKGFyZ3Y6IHN0cmluZ1tdKTogT3B0aW9ucyB7XG4gIGNvbnN0IG9wdGlvbnM6IE9wdGlvbnMgPSB7XG4gICAgdXNlcm5hbWU6ICcnLFxuICAgIHBhc3N3b3JkUGFyYW1ldGVyOiAnJyxcbiAgICB0dGw6ICczMDAnLFxuICAgIHN0YWNrTmFtZXM6IFtdLFxuICAgIHpvbmVOYW1lczogW10sXG4gICAgcHJ1bmU6IGZhbHNlLFxuICAgIGZvcmNlUHJ1bmU6IGZhbHNlLFxuICAgIG1heFBydW5lOiBERUZBVUxUX01BWF9QUlVORSxcbiAgICBkcnlSdW46IGZhbHNlLFxuICB9XG5cbiAgLyoqXG4gICAqIEFueXRoaW5nIG5vdCBzdGFydGluZyB3aXRoIFwiLVwiIGluIHRoZSBmaXJzdCBwb3NpdGlvbiBpcyB0aGUgb2xkIHBvc2l0aW9uYWwgZm9ybTpcbiAgICogPHVzZXJuYW1lPiA8cGFzc3dvcmQtcGFyYW1ldGVyPiBbdHRsIFtzdGFjay4uLl1dLiBLZXB0IHdvcmtpbmcgc28gZXhpc3RpbmcgZGVwbG95IHNjcmlwdHMgYW5kXG4gICAqIENJIGpvYnMgZG8gbm90IGhhdmUgdG8gY2hhbmdlIGluIHRoZSBzYW1lIHJlbGVhc2UgdGhhdCBhZGRzIHBydW5pbmcuXG4gICAqL1xuICBpZiAoYXJndi5sZW5ndGggJiYgIWFyZ3ZbMF0uc3RhcnRzV2l0aCgnLScpKSB7XG4gICAgb3B0aW9ucy51c2VybmFtZSA9IGFyZ3ZbMF1cbiAgICBvcHRpb25zLnBhc3N3b3JkUGFyYW1ldGVyID0gYXJndlsxXSB8fCAnJ1xuICAgIC8qKlxuICAgICAqIE9wdGlvbnMgYXJlIHN0aWxsIGhvbm91cmVkIGFmdGVyIHRoZSBwb3NpdGlvbmFsIGFyZ3VtZW50cy4gVHJlYXRpbmcgYSB0cmFpbGluZyBcIi1uXCIgYXMgYVxuICAgICAqIHN0YWNrIG5hbWUgaW5zdGVhZCBpcyBob3cgYSBydW4gdGhlIGNhbGxlciBiZWxpZXZlZCB3YXMgYSByZWhlYXJzYWwgd3JpdGVzIGZvciByZWFsIOKAlCB3aGljaFxuICAgICAqIGlzIGV4YWN0bHkgd2hhdCBoYXBwZW5lZCB0aGUgZmlyc3QgdGltZSB0aGlzIHdhcyB0ZXN0ZWQuXG4gICAgICovXG4gICAgY29uc3QgcmVzdCA9IGFyZ3Yuc2xpY2UoMilcbiAgICBjb25zdCBmbGFnSW5kZXggPSByZXN0LmZpbmRJbmRleCgoYXJnKSA9PiBhcmcuc3RhcnRzV2l0aCgnLScpKVxuICAgIGNvbnN0IHBvc2l0aW9uYWwgPSBmbGFnSW5kZXggPT09IC0xID8gcmVzdCA6IHJlc3Quc2xpY2UoMCwgZmxhZ0luZGV4KVxuICAgIGlmIChwb3NpdGlvbmFsWzBdKSBvcHRpb25zLnR0bCA9IHBvc2l0aW9uYWxbMF1cbiAgICBvcHRpb25zLnN0YWNrTmFtZXMgPSBwb3NpdGlvbmFsLnNsaWNlKDEpXG4gICAgaWYgKGZsYWdJbmRleCAhPT0gLTEpIGFwcGx5RmxhZ3MocmVzdC5zbGljZShmbGFnSW5kZXgpLCBvcHRpb25zKVxuICAgIHJldHVybiBvcHRpb25zXG4gIH1cblxuICBhcHBseUZsYWdzKGFyZ3YsIG9wdGlvbnMpXG4gIHJldHVybiBvcHRpb25zXG59XG5cbmZ1bmN0aW9uIGFwcGx5RmxhZ3MoYXJndjogc3RyaW5nW10sIG9wdGlvbnM6IE9wdGlvbnMpOiB2b2lkIHtcbiAgY29uc3QgbmV4dCA9IChpbmRleDogbnVtYmVyLCBmbGFnOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gYXJndltpbmRleCArIDFdXG4gICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUuc3RhcnRzV2l0aCgnLScpKSB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgdmFsdWUgZm9yICR7ZmxhZ31gKVxuICAgIHJldHVybiB2YWx1ZVxuICB9XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmd2Lmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgYXJnID0gYXJndltpXVxuICAgIHN3aXRjaCAoYXJnKSB7XG4gICAgICBjYXNlICctdSc6XG4gICAgICBjYXNlICctLXVzZXJuYW1lJzpcbiAgICAgICAgb3B0aW9ucy51c2VybmFtZSA9IG5leHQoaSwgYXJnKVxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy1wJzpcbiAgICAgIGNhc2UgJy0tcGFzc3dvcmQtcGFyYW1ldGVyJzpcbiAgICAgICAgb3B0aW9ucy5wYXNzd29yZFBhcmFtZXRlciA9IG5leHQoaSwgYXJnKVxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy10JzpcbiAgICAgIGNhc2UgJy0tdHRsJzpcbiAgICAgICAgb3B0aW9ucy50dGwgPSBuZXh0KGksIGFyZylcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctcyc6XG4gICAgICBjYXNlICctLXN0YWNrJzpcbiAgICAgICAgb3B0aW9ucy5zdGFja05hbWVzLnB1c2gobmV4dChpLCBhcmcpKVxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy16JzpcbiAgICAgIGNhc2UgJy0tem9uZSc6XG4gICAgICAgIG9wdGlvbnMuem9uZU5hbWVzLnB1c2gobmV4dChpLCBhcmcpKVxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy0tcHJ1bmUnOlxuICAgICAgICBvcHRpb25zLnBydW5lID0gdHJ1ZVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLS1mb3JjZS1wcnVuZSc6XG4gICAgICAgIG9wdGlvbnMucHJ1bmUgPSB0cnVlXG4gICAgICAgIG9wdGlvbnMuZm9yY2VQcnVuZSA9IHRydWVcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy0tbWF4LXBydW5lJzoge1xuICAgICAgICBjb25zdCByYXcgPSBuZXh0KGksIGFyZylcbiAgICAgICAgY29uc3QgcGFyc2VkID0gTnVtYmVyKHJhdylcbiAgICAgICAgLy8gTnVtYmVyKCdhYmMnKSBpcyBOYU4sIGFuZCBgb3JwaGFucy5sZW5ndGggPiBOYU5gIGlzIGZhbHNlIOKAlCBhbiB1bnZhbGlkYXRlZCB2YWx1ZSBoZXJlXG4gICAgICAgIC8vIHdvdWxkIHF1aWV0bHkgcmVtb3ZlIHRoZSBjYXAgcmF0aGVyIHRoYW4gdGlnaHRlbiBpdC5cbiAgICAgICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHBhcnNlZCkgfHwgcGFyc2VkIDwgMCkgdGhyb3cgbmV3IEVycm9yKGAtLW1heC1wcnVuZSBuZWVkcyBhIG5vbi1uZWdhdGl2ZSBpbnRlZ2VyLCBnb3Q6ICR7cmF3fWApXG4gICAgICAgIG9wdGlvbnMubWF4UHJ1bmUgPSBwYXJzZWRcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICB9XG4gICAgICBjYXNlICctbic6XG4gICAgICBjYXNlICctLWRyeS1ydW4nOlxuICAgICAgICBvcHRpb25zLmRyeVJ1biA9IHRydWVcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy1oJzpcbiAgICAgIGNhc2UgJy0taGVscCc6XG4gICAgICAgIGNvbnNvbGUubG9nKFVTQUdFKVxuICAgICAgICBwcm9jZXNzLmV4aXQoMClcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy1WJzpcbiAgICAgIGNhc2UgJy0tdmVyc2lvbic6XG4gICAgICAgIGNvbnNvbGUubG9nKHJlcXVpcmUoJy4uL3BhY2thZ2UuanNvbicpLnZlcnNpb24pXG4gICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICBicmVha1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIG9wdGlvbjogJHthcmd9YClcbiAgICB9XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY2xvdWRuc1Jlc3RDYWxsKFxuICBjbG91ZG5zVXNlcm5hbWU6IHN0cmluZyxcbiAgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsXG4gIG1ldGhvZDogc3RyaW5nLFxuICByZWxhdGl2ZVVybDogc3RyaW5nLFxuICBxdWVyeU9wdGlvbnM6IGFueVxuKTogUHJvbWlzZTxDbG91ZG5zUmVzdENhbGxSZXNwb25zZT4ge1xuICBjb25zdCBmdWxsVXJsID1cbiAgICAnaHR0cHM6Ly9hcGkuY2xvdWRucy5uZXQnICtcbiAgICByZWxhdGl2ZVVybCArXG4gICAgJz8nICtcbiAgICBxdWVyeXN0cmluZy5zdHJpbmdpZnkoXG4gICAgICBPYmplY3QuYXNzaWduKFxuICAgICAgICB7XG4gICAgICAgICAgJ3N1Yi1hdXRoLXVzZXInOiBjbG91ZG5zVXNlcm5hbWUsXG4gICAgICAgICAgJ2F1dGgtcGFzc3dvcmQnOiBjbG91ZG5zUGFzc3dvcmQsXG4gICAgICAgIH0sXG4gICAgICAgIHF1ZXJ5T3B0aW9ucyB8fCB7fVxuICAgICAgKVxuICAgIClcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGZ1bGxVcmwsIHtcbiAgICBtZXRob2Q6IG1ldGhvZCxcbiAgICBoZWFkZXJzOiB7XG4gICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgfSxcbiAgfSlcbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKVxuICAgIGNvbnNvbGUuZXJyb3IoJ0hUVFAgRXJyb3InLCByZXNwb25zZS5zdGF0dXMsIHJlc3BvbnNlLnN0YXR1c1RleHQsIGVycm9yVGV4dClcbiAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JUZXh0KVxuICB9XG4gIHJldHVybiAoYXdhaXQgcmVzcG9uc2UuanNvbigpKSBhcyBDbG91ZG5zUmVzdENhbGxSZXNwb25zZVxufVxuXG4vKipcbiAqIENsb3VETlMgcmVwb3J0cyBmYWlsdXJlcyBpbiB0aGUgYm9keSB3aXRoIEhUVFAgMjAwLCBzbyBhIGNhbGwgaXMgb25seSBzdWNjZXNzZnVsIGlmIGl0IHNheXMgc28uXG4gKlxuICogVHJlYXRpbmcgXCJub3QgdGhlIHN0cmluZyBGYWlsZWRcIiBhcyBzdWNjZXNzIGlzIGhvdyBhIHJlamVjdGVkIHdyaXRlIGdldHMgcmVwb3J0ZWQgYXMgZG9uZSDigJRcbiAqIGNoZWNrZWQgcG9zaXRpdmVseSBoZXJlIGluc3RlYWQuXG4gKi9cbmZ1bmN0aW9uIGFzc2VydFN1Y2Nlc3MocmVzdWx0OiBhbnksIHdoYXQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBzdGF0dXMgPSByZXN1bHQ/LnN0YXR1c1xuICBpZiAoc3RhdHVzID09PSAnU3VjY2VzcycgfHwgc3RhdHVzID09PSAxIHx8IHN0YXR1cyA9PT0gJzEnKSByZXR1cm5cbiAgdGhyb3cgbmV3IEVycm9yKGAke3doYXR9IGZhaWxlZDogJHtyZXN1bHQ/LnN0YXR1c0Rlc2NyaXB0aW9uIHx8IHJlc3VsdD8uc3RhdHVzTWVzc2FnZSB8fCBKU09OLnN0cmluZ2lmeShyZXN1bHQpfWApXG59XG5cbmFzeW5jIGZ1bmN0aW9uIGF1dG9EZXRlY3RDbG91ZG5zSG9zdEFuZFpvbmUoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHpvbmVDYWNoZTogYW55KSB7XG4gIGNvbnN0IG5hbWVQYXJ0cyA9IG5hbWUuc3BsaXQoJy4nKVxuXG4gIC8vIFpvbmUgYW5kIGhvc3QgbmFtZSBmb3IgeHh4LnRsZFxuICBjb25zdCBob3N0TmFtZTEgPSBuYW1lUGFydHMuc2xpY2UoMCwgbmFtZVBhcnRzLmxlbmd0aCAtIDIpLmpvaW4oJy4nKVxuICBjb25zdCB6b25lTmFtZTEgPSBuYW1lUGFydHMuc2xpY2UobmFtZVBhcnRzLmxlbmd0aCAtIDIpLmpvaW4oJy4nKVxuXG4gIC8vIFpvbmUgYW5kIGhvc3QgbmFtZSBmb3IgeHh4LnN1YnRsZC50bGRcbiAgY29uc3QgaG9zdE5hbWUyID0gbmFtZVBhcnRzLnNsaWNlKDAsIG5hbWVQYXJ0cy5sZW5ndGggLSAzKS5qb2luKCcuJylcbiAgY29uc3Qgem9uZU5hbWUyID0gbmFtZVBhcnRzLnNsaWNlKG5hbWVQYXJ0cy5sZW5ndGggLSAzKS5qb2luKCcuJylcblxuICAvLyBDaGVjayB3aGljaCB6b25lIGV4aXN0c1xuICBjb25zdCB6b25lUmVzcG9uc2UxID1cbiAgICB6b25lQ2FjaGVbem9uZU5hbWUxXSB8fFxuICAgIChhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdHRVQnLCAnL2Rucy9nZXQtem9uZS1pbmZvLmpzb24nLCB7XG4gICAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZTEsXG4gICAgfSkpXG4gIHpvbmVDYWNoZVt6b25lTmFtZTFdID0gem9uZVJlc3BvbnNlMVxuICBjb25zdCB6b25lUmVzcG9uc2UyID1cbiAgICB6b25lQ2FjaGVbem9uZU5hbWUyXSB8fFxuICAgIChhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdHRVQnLCAnL2Rucy9nZXQtem9uZS1pbmZvLmpzb24nLCB7XG4gICAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZTIsXG4gICAgfSkpXG4gIHpvbmVDYWNoZVt6b25lTmFtZTJdID0gem9uZVJlc3BvbnNlMlxuXG4gIGNvbnN0IHpvbmVOYW1lID0gem9uZVJlc3BvbnNlMS5zdGF0dXMgPT09ICcxJyA/IHpvbmVOYW1lMSA6IHpvbmVSZXNwb25zZTIuc3RhdHVzID09PSAnMScgPyB6b25lTmFtZTIgOiAnJ1xuICBjb25zdCBob3N0TmFtZSA9IHpvbmVSZXNwb25zZTEuc3RhdHVzID09PSAnMScgPyBob3N0TmFtZTEgOiB6b25lUmVzcG9uc2UyLnN0YXR1cyA9PT0gJzEnID8gaG9zdE5hbWUyIDogJydcbiAgaWYgKCF6b25lTmFtZSkge1xuICAgIC8vIE5laXRoZXIgem9uZSBleGlzdHNcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1pvbmUgTm90IEZvdW5kOiAnICsgbmFtZSlcbiAgfVxuICByZXR1cm4ge1xuICAgIGhvc3ROYW1lOiBob3N0TmFtZSxcbiAgICB6b25lTmFtZTogem9uZU5hbWUsXG4gIH1cbn1cblxuLyoqXG4gKiBFdmVyeSByZWNvcmQgaW4gYSB6b25lLCBub3RlcyBpbmNsdWRlZC4gQWxzbyB0aGUgYmFzaXMgZm9yIGZpbmRpbmcgb3JwaGFucy5cbiAqXG4gKiBDYWNoZWQgcGVyIHJ1bjogbG9va2luZyBhIHJlY29yZCB1cCBhbmQgdGhlbiB2ZXJpZnlpbmcgaXQgdXNlZCB0byBjb3N0IHR3byB3aG9sZS16b25lIGNhbGxzIGVhY2gsXG4gKiBzbyB0d2VudHkgZXhwb3J0cyBtZWFudCBmb3J0eSBsaXN0aW5ncyBhZ2FpbnN0IGFuIEFQSSB0aGF0IHJhdGUgbGltaXRzLiBBbnkgd3JpdGUgaW52YWxpZGF0ZXMgdGhlXG4gKiB6b25lLCBhbmQgdmVyaWZpY2F0aW9uIGFsd2F5cyByZWFkcyBmcmVzaCwgc28gYSBjYWNoZWQgbGlzdGluZyBpcyBuZXZlciB1c2VkIHRvIGp1ZGdlIHNvbWV0aGluZ1xuICogdGhhdCBoYXMganVzdCBjaGFuZ2VkLlxuICovXG5jb25zdCB6b25lUmVjb3Jkc0NhY2hlID0gbmV3IE1hcDxzdHJpbmcsIENsb3VkbnNSZWNvcmRbXT4oKVxuXG5hc3luYyBmdW5jdGlvbiBsaXN0Wm9uZVJlY29yZHMoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCB6b25lTmFtZTogc3RyaW5nLCBmcmVzaCA9IGZhbHNlKTogUHJvbWlzZTxDbG91ZG5zUmVjb3JkW10+IHtcbiAgaWYgKCFmcmVzaCkge1xuICAgIGNvbnN0IGNhY2hlZCA9IHpvbmVSZWNvcmRzQ2FjaGUuZ2V0KHpvbmVOYW1lKVxuICAgIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWRcbiAgfVxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ0dFVCcsICcvZG5zL3JlY29yZHMuanNvbicsIHtcbiAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAnaW5jbHVkZS1ub3Rlcyc6ICcxJyxcbiAgfSlcbiAgLy8gQW4gZW1wdHkgem9uZSBjb21lcyBiYWNrIGFzIGFuIGVtcHR5IGFycmF5IHJhdGhlciB0aGFuIGFuIGVtcHR5IG9iamVjdC5cbiAgY29uc3QgcmVjb3JkcyA9ICFyZXNwb25zZSB8fCBBcnJheS5pc0FycmF5KHJlc3BvbnNlKSA/IFtdIDogKE9iamVjdC52YWx1ZXMocmVzcG9uc2UpIGFzIENsb3VkbnNSZWNvcmRbXSlcbiAgem9uZVJlY29yZHNDYWNoZS5zZXQoem9uZU5hbWUsIHJlY29yZHMpXG4gIHJldHVybiByZWNvcmRzXG59XG5cbmZ1bmN0aW9uIG93bmVyc2hpcE5vdGUoc3RhY2tOYW1lOiBzdHJpbmcsIGV4cG9ydE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtOT1RFX01BUktFUn0gc3RhY2s9JHtzdGFja05hbWV9IGV4cG9ydD0ke2V4cG9ydE5hbWV9YFxufVxuXG4vKiogVGhlIHN0YWNrIG5hbWVkIGluIGEgcmVjb3JkJ3Mgbm90ZSwgb3IgdW5kZWZpbmVkIHdoZW4gdGhlIHJlY29yZCBpcyBub3Qgb3Vycy4gKi9cbmZ1bmN0aW9uIG5vdGVTdGFja05hbWUocmVjb3JkOiBDbG91ZG5zUmVjb3JkKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFyZWNvcmQubm90ZSB8fCByZWNvcmQubm90ZS5pbmRleE9mKE5PVEVfTUFSS0VSKSA9PT0gLTEpIHJldHVybiB1bmRlZmluZWRcbiAgY29uc3QgbWF0Y2ggPSAvc3RhY2s9KFxcUyspLy5leGVjKHJlY29yZC5ub3RlKVxuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFsxXSA6ICcnXG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNldFJlY29yZE5vdGUoXG4gIGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLFxuICBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZyxcbiAgem9uZU5hbWU6IHN0cmluZyxcbiAgcmVjb3JkSWQ6IHN0cmluZyxcbiAgbm90ZTogc3RyaW5nLFxuICBkcnlSdW46IGJvb2xlYW5cbik6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoZHJ5UnVuKSByZXR1cm5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnUE9TVCcsICcvZG5zL3NldC1yZWNvcmQtbm90ZS5qc29uJywge1xuICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICdyZWNvcmQtaWQnOiByZWNvcmRJZCxcbiAgICBub3RlOiBub3RlLFxuICB9KVxuICBhc3NlcnRTdWNjZXNzKHJlc3VsdCwgJ1NldCByZWNvcmQgbm90ZScpXG4gIHpvbmVSZWNvcmRzQ2FjaGUuZGVsZXRlKHpvbmVOYW1lKVxufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVPclVwZGF0ZUNsb3VkbnNSZXNvdXJjZShcbiAgY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsXG4gIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLFxuICBkZXNpcmVkOiBEZXNpcmVkUmVjb3JkLFxuICB0dGxWYWx1ZTogc3RyaW5nLFxuICBkcnlSdW46IGJvb2xlYW5cbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IHpvbmVOYW1lLCBob3N0TmFtZSwgdHlwZSwgdmFsdWUgfSA9IGRlc2lyZWRcbiAgY29uc3QgbmFtZSA9IGhvc3ROYW1lID8gYCR7aG9zdE5hbWV9LiR7em9uZU5hbWV9YCA6IHpvbmVOYW1lXG5cbiAgY29uc3QgcmVjb3JkcyA9IGF3YWl0IGxpc3Rab25lUmVjb3JkcyhjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWUpXG4gIC8qKlxuICAgKiBNYXRjaCBvbiBob3N0IGFuZCB0eXBlIGFjcm9zcyB0aGUgd2hvbGUgem9uZSByYXRoZXIgdGhhbiB0cnVzdGluZyBhIGZpbHRlcmVkIHF1ZXJ5J3MgZmlyc3RcbiAgICogZW50cnkuIFRha2luZyB3aGljaGV2ZXIgcmVjb3JkIGhhcHBlbmVkIHRvIGNvbWUgYmFjayBmaXJzdCBtZWFudCB0aGF0IGEgaG9zdCB3aXRoIG1vcmUgdGhhbiBvbmVcbiAgICogcmVjb3JkIG9mIGEgdHlwZSBoYWQgb25lIG9mIHRoZW0gdXBkYXRlZCBhdCByYW5kb20gd2hpbGUgdGhlIG90aGVyIGtlcHQgc2VydmluZyB0cmFmZmljLlxuICAgKi9cbiAgY29uc3QgbWF0Y2hpbmcgPSByZWNvcmRzLmZpbHRlcigocmVjb3JkKSA9PiByZWNvcmQuaG9zdCA9PT0gaG9zdE5hbWUgJiYgcmVjb3JkLnR5cGUgPT09IHR5cGUpXG4gIGlmIChtYXRjaGluZy5sZW5ndGggPiAxKSB7XG4gICAgY29uc29sZS53YXJuKCdXQVJOJywgbmFtZSwgdHlwZSwgJ2hhcycsIG1hdGNoaW5nLmxlbmd0aCwgJ3JlY29yZHM7IHVwZGF0aW5nIHRoZSBmaXJzdCBhbmQgbGVhdmluZyB0aGUgcmVzdCcpXG4gIH1cbiAgY29uc3QgZXhpc3RpbmdSZWNvcmQgPSBtYXRjaGluZ1swXVxuICBjb25zdCBub3RlID0gb3duZXJzaGlwTm90ZShkZXNpcmVkLnN0YWNrTmFtZSwgZGVzaXJlZC5leHBvcnROYW1lKVxuXG4gIGlmIChleGlzdGluZ1JlY29yZCAmJiBleGlzdGluZ1JlY29yZC5yZWNvcmQgPT09IHZhbHVlICYmIFN0cmluZyhleGlzdGluZ1JlY29yZC50dGwpID09PSBTdHJpbmcodHRsVmFsdWUpKSB7XG4gICAgaWYgKGV4aXN0aW5nUmVjb3JkLm5vdGUgPT09IG5vdGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKCdPSycsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQWRvcHRzIHJlY29yZHMgY3JlYXRlZCBiZWZvcmUgb3duZXJzaGlwIG5vdGVzIGV4aXN0ZWQsIGFuZCByZXBhaXJzIGEgbm90ZSB0aGF0IGRyaWZ0ZWQuXG4gICAgICBjb25zb2xlLmxvZygnQURPUFQnLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gICAgICBhd2FpdCBzZXRSZWNvcmROb3RlKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCB6b25lTmFtZSwgZXhpc3RpbmdSZWNvcmQuaWQsIG5vdGUsIGRyeVJ1bilcbiAgICB9XG4gICAgcmV0dXJuXG4gIH1cblxuICBpZiAoZXhpc3RpbmdSZWNvcmQpIHtcbiAgICBjb25zb2xlLmxvZygnVVBEQVRFJywgbmFtZSwgdHlwZSwgdHRsVmFsdWUsIHZhbHVlLCAnWk9ORScsIHpvbmVOYW1lLCAnSE9TVCcsIGhvc3ROYW1lKVxuICAgIGlmICghZHJ5UnVuKSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdQT1NUJywgJy9kbnMvbW9kLXJlY29yZC5qc29uJywge1xuICAgICAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAgICAgJ3JlY29yZC1pZCc6IGV4aXN0aW5nUmVjb3JkLmlkLFxuICAgICAgICBob3N0OiBob3N0TmFtZSxcbiAgICAgICAgJ3JlY29yZC10eXBlJzogdHlwZSxcbiAgICAgICAgcmVjb3JkOiB2YWx1ZSxcbiAgICAgICAgdHRsOiB0dGxWYWx1ZSxcbiAgICAgIH0pXG4gICAgICBhc3NlcnRTdWNjZXNzKHJlc3VsdCwgJ01vZGlmeSByZWNvcmQnKVxuICAgICAgYXdhaXQgc2V0UmVjb3JkTm90ZShjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWUsIGV4aXN0aW5nUmVjb3JkLmlkLCBub3RlLCBkcnlSdW4pXG4gICAgICBhd2FpdCB2ZXJpZnlSZWNvcmQoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIGRlc2lyZWQsIHR0bFZhbHVlKVxuICAgIH1cbiAgICByZXR1cm5cbiAgfVxuXG4gIGNvbnNvbGUubG9nKCdDUkVBVEUnLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gIGlmIChkcnlSdW4pIHJldHVyblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdQT1NUJywgJy9kbnMvYWRkLXJlY29yZC5qc29uJywge1xuICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgIGhvc3Q6IGhvc3ROYW1lLFxuICAgICdyZWNvcmQtdHlwZSc6IHR5cGUsXG4gICAgcmVjb3JkOiB2YWx1ZSxcbiAgICB0dGw6IHR0bFZhbHVlLFxuICB9KVxuICBhc3NlcnRTdWNjZXNzKHJlc3VsdCwgJ0FkZCByZWNvcmQnKVxuICBjb25zdCBjcmVhdGVkSWQgPSByZXN1bHQ/LmRhdGE/LmlkXG4gIGlmIChjcmVhdGVkSWQpIGF3YWl0IHNldFJlY29yZE5vdGUoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHpvbmVOYW1lLCBTdHJpbmcoY3JlYXRlZElkKSwgbm90ZSwgZHJ5UnVuKVxuICBhd2FpdCB2ZXJpZnlSZWNvcmQoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIGRlc2lyZWQsIHR0bFZhbHVlKVxufVxuXG4vKipcbiAqIFJlYWRzIHRoZSByZWNvcmQgYmFjayBhbmQgY29tcGxhaW5zIGlmIGl0IGlzIG5vdCB3aGF0IHdhcyBqdXN0IHdyaXR0ZW4uXG4gKlxuICogV2l0aG91dCB0aGlzIHRoZSBsb2cgcmVwb3J0cyBpbnRlbnQgcmF0aGVyIHRoYW4gb3V0Y29tZSwgd2hpY2ggaXMgaG93IGEgY3V0b3ZlciB0aGF0IG5ldmVyXG4gKiBoYXBwZW5lZCBjYW4gbG9vayBsaWtlIGEgY2xlYW4gcnVuLiBOb3RlIHRoaXMgY29uZmlybXMgdGhlIHN0b3JlZCByZWNvcmQgb25seSDigJQgQ2xvdUROUyByZXNvbHZlc1xuICogQUxJQVMgdGFyZ2V0cyBvbiBpdHMgb3duIHNjaGVkdWxlLCBzbyB3aGF0IHRoZSB6b25lICpzZXJ2ZXMqIGNhbiBsYWcgdGhlIHJlY29yZCBieSBhIGxvbmcgd2F5LlxuICovXG5hc3luYyBmdW5jdGlvbiB2ZXJpZnlSZWNvcmQoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCBkZXNpcmVkOiBEZXNpcmVkUmVjb3JkLCB0dGxWYWx1ZTogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJlY29yZHMgPSBhd2FpdCBsaXN0Wm9uZVJlY29yZHMoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIGRlc2lyZWQuem9uZU5hbWUsIHRydWUpXG4gIGNvbnN0IHN0b3JlZCA9IHJlY29yZHMuZmluZCgocmVjb3JkKSA9PiByZWNvcmQuaG9zdCA9PT0gZGVzaXJlZC5ob3N0TmFtZSAmJiByZWNvcmQudHlwZSA9PT0gZGVzaXJlZC50eXBlKVxuICBpZiAoIXN0b3JlZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgVmVyaWZpY2F0aW9uIGZhaWxlZDogJHtkZXNpcmVkLmhvc3ROYW1lfS4ke2Rlc2lyZWQuem9uZU5hbWV9ICR7ZGVzaXJlZC50eXBlfSBpcyBtaXNzaW5nIGFmdGVyIHdyaXRlYClcbiAgfVxuICBpZiAoc3RvcmVkLnJlY29yZCAhPT0gZGVzaXJlZC52YWx1ZSB8fCBTdHJpbmcoc3RvcmVkLnR0bCkgIT09IFN0cmluZyh0dGxWYWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgVmVyaWZpY2F0aW9uIGZhaWxlZDogJHtkZXNpcmVkLmhvc3ROYW1lfS4ke2Rlc2lyZWQuem9uZU5hbWV9ICR7ZGVzaXJlZC50eXBlfSBpcyAke3N0b3JlZC5yZWNvcmR9ICh0dGwgJHtzdG9yZWQudHRsfSksIGV4cGVjdGVkICR7ZGVzaXJlZC52YWx1ZX0gKHR0bCAke3R0bFZhbHVlfSlgXG4gICAgKVxuICB9XG59XG5cbi8qKlxuICogRGVsZXRlcyBtYW5hZ2VkIHJlY29yZHMgd2hvc2UgZXhwb3J0IG5vIGxvbmdlciBleGlzdHMuXG4gKlxuICogT25seSByZWNvcmRzIGNhcnJ5aW5nIHRoaXMgdG9vbCdzIG5vdGUgYXJlIGNvbnNpZGVyZWQsIGFuZCB3aGVuIC0tc3RhY2sgd2FzIGdpdmVuIG9ubHkgdGhvc2VcbiAqIHdob3NlIG5vdGUgbmFtZXMgb25lIG9mIHRob3NlIHN0YWNrcyDigJQgb3RoZXJ3aXNlIHN5bmNpbmcgb25lIHN0YWNrIHdvdWxkIGRlbGV0ZSB0aGUgcmVjb3JkcyBvZlxuICogYW5vdGhlci5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcHJ1bmVPcnBoYW5zKFxuICBjbG91ZG5zVXNlcm5hbWU6IHN0cmluZyxcbiAgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsXG4gIHpvbmVOYW1lczogc3RyaW5nW10sXG4gIGRlc2lyZWQ6IERlc2lyZWRSZWNvcmRbXSxcbiAgc3RhY2tTY29wZTogU2V0PHN0cmluZz4gfCB1bmRlZmluZWQsXG4gIG9wdGlvbnM6IE9wdGlvbnNcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBkZXNpcmVkS2V5cyA9IG5ldyBTZXQoZGVzaXJlZC5tYXAoKHJlY29yZCkgPT4gYCR7cmVjb3JkLnpvbmVOYW1lfXwke3JlY29yZC5ob3N0TmFtZX18JHtyZWNvcmQudHlwZX1gKSlcbiAgY29uc3Qgb3JwaGFuczogeyB6b25lTmFtZTogc3RyaW5nOyByZWNvcmQ6IENsb3VkbnNSZWNvcmQgfVtdID0gW11cblxuICBmb3IgKGNvbnN0IHpvbmVOYW1lIG9mIHpvbmVOYW1lcykge1xuICAgIGZvciAoY29uc3QgcmVjb3JkIG9mIGF3YWl0IGxpc3Rab25lUmVjb3JkcyhjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWUsIHRydWUpKSB7XG4gICAgICBjb25zdCBzdGFjayA9IG5vdGVTdGFja05hbWUocmVjb3JkKVxuICAgICAgaWYgKHN0YWNrID09PSB1bmRlZmluZWQpIGNvbnRpbnVlIC8vIG5vdCBvdXJzXG4gICAgICBpZiAoc3RhY2tTY29wZSAmJiAhc3RhY2tTY29wZS5oYXMoc3RhY2spKSBjb250aW51ZSAvLyBhbm90aGVyIHN0YWNrJ3NcbiAgICAgIGlmIChkZXNpcmVkS2V5cy5oYXMoYCR7em9uZU5hbWV9fCR7cmVjb3JkLmhvc3R9fCR7cmVjb3JkLnR5cGV9YCkpIGNvbnRpbnVlIC8vIHN0aWxsIHdhbnRlZFxuICAgICAgb3JwaGFucy5wdXNoKHsgem9uZU5hbWUsIHJlY29yZCB9KVxuICAgIH1cbiAgfVxuXG4gIGlmICghb3JwaGFucy5sZW5ndGgpIHtcbiAgICBjb25zb2xlLmxvZygnUFJVTkUgbm9uZScpXG4gICAgcmV0dXJuXG4gIH1cblxuICBmb3IgKGNvbnN0IHsgem9uZU5hbWUsIHJlY29yZCB9IG9mIG9ycGhhbnMpIHtcbiAgICBjb25zdCBuYW1lID0gcmVjb3JkLmhvc3QgPyBgJHtyZWNvcmQuaG9zdH0uJHt6b25lTmFtZX1gIDogem9uZU5hbWVcbiAgICBjb25zb2xlLmxvZyhvcHRpb25zLmRyeVJ1biA/ICdXT1VMRCBQUlVORScgOiAnUFJVTkUnLCBuYW1lLCByZWNvcmQudHlwZSwgcmVjb3JkLnJlY29yZCwgJ1pPTkUnLCB6b25lTmFtZSlcbiAgfVxuXG4gIGNvbnN0IG92ZXJDYXAgPSBvcnBoYW5zLmxlbmd0aCA+IG9wdGlvbnMubWF4UHJ1bmVcbiAgaWYgKG9wdGlvbnMuZHJ5UnVuKSB7XG4gICAgaWYgKG92ZXJDYXApIGNvbnNvbGUud2FybignV0FSTicsIGBBIHJlYWwgcnVuIHdvdWxkIHJlZnVzZTogJHtvcnBoYW5zLmxlbmd0aH0gcmVjb3JkcyBleGNlZWRzIC0tbWF4LXBydW5lICR7b3B0aW9ucy5tYXhQcnVuZX1gKVxuICAgIHJldHVyblxuICB9XG4gIGlmIChvdmVyQ2FwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBSZWZ1c2luZyB0byBkZWxldGUgJHtvcnBoYW5zLmxlbmd0aH0gcmVjb3JkcyBpbiBvbmUgcnVuIChsaW1pdCAke29wdGlvbnMubWF4UHJ1bmV9KTsgcmFpc2UgLS1tYXgtcHJ1bmUgaWYgdGhpcyBpcyBpbnRlbmRlZGApXG4gIH1cblxuICBmb3IgKGNvbnN0IHsgem9uZU5hbWUsIHJlY29yZCB9IG9mIG9ycGhhbnMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdQT1NUJywgJy9kbnMvZGVsZXRlLXJlY29yZC5qc29uJywge1xuICAgICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgICAncmVjb3JkLWlkJzogcmVjb3JkLmlkLFxuICAgIH0pXG4gICAgYXNzZXJ0U3VjY2VzcyhyZXN1bHQsICdEZWxldGUgcmVjb3JkJylcbiAgfVxufVxuXG4vKipcbiAqIFR1cm5zIGFuIGV4cG9ydCBuYW1lIGludG8gdGhlIHJlY29yZCBpdCBkZXNjcmliZXM6IENsb3VETlM6PHR5cGU+Ojxob3N0IGxhYmVscy4uLj4uXG4gKlxuICogREtJTSBpcyB0aGUgb25lIGZvcm0gdGhhdCBpcyBub3QgYSByZWNvcmQgdHlwZS4gQW4gZXhwb3J0IG5hbWUgbWF5IG9ubHkgaG9sZCBsZXR0ZXJzLCBkaWdpdHMsXG4gKiBjb2xvbnMgYW5kIGh5cGhlbnMsIGFuZCBhIERLSU0gcmVjb3JkIGxpdmVzIHVuZGVyIGBfZG9tYWlua2V5YCwgd2hpY2ggbm8gZXhwb3J0IG5hbWUgY2FuIHNwZWxsLlxuICogU28gQ2xvdUROUzpES0lNOjxzZWxlY3Rvcj46ZXhhbXBsZTpvcmcgc3RhbmRzIGZvciB0aGUgQ05BTUUgPHNlbGVjdG9yPi5fZG9tYWlua2V5LmV4YW1wbGUub3JnIC1cbiAqIHRoZSBzaGFwZSBTRVMgRWFzeSBES0lNIGFza3MgZm9yLCB0aHJlZSBvZiB0aGVtIHBlciBkb21haW4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUV4cG9ydE5hbWUoZXhwb3J0TmFtZTogc3RyaW5nKTogeyByZXNvdXJjZVR5cGU6IHN0cmluZzsgcmVzb3VyY2VOYW1lOiBzdHJpbmcgfSB7XG4gIGNvbnN0IG5hbWVQYXJ0cyA9IGV4cG9ydE5hbWUuc3BsaXQoJzonKVxuICBpZiAobmFtZVBhcnRzWzFdID09PSAnREtJTScpIHtcbiAgICBjb25zdCBbc2VsZWN0b3IsIC4uLmRvbWFpblBhcnRzXSA9IG5hbWVQYXJ0cy5zbGljZSgyKVxuICAgIGlmICghc2VsZWN0b3IgfHwgZG9tYWluUGFydHMubGVuZ3RoIDwgMikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBFeHBvcnQgJHtleHBvcnROYW1lfSBtdXN0IGJlIENsb3VETlM6REtJTTo8c2VsZWN0b3I+Ojxkb21haW4gbGFiZWxzPmApXG4gICAgfVxuICAgIHJldHVybiB7IHJlc291cmNlVHlwZTogJ0NOQU1FJywgcmVzb3VyY2VOYW1lOiBgJHtzZWxlY3Rvcn0uX2RvbWFpbmtleS4ke2RvbWFpblBhcnRzLmpvaW4oJy4nKX1gIH1cbiAgfVxuICByZXR1cm4geyByZXNvdXJjZVR5cGU6IG5hbWVQYXJ0c1sxXSwgcmVzb3VyY2VOYW1lOiBuYW1lUGFydHMuc2xpY2UoMikuam9pbignLicpIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIC8vIFBhcnNlZCBiZWZvcmUgdGhlIGJhbm5lciBzbyAtLXZlcnNpb24gYW5kIC0taGVscCBwcmludCBvbmx5IHdoYXQgYSBjYWxsZXIgYXNrZWQgZm9yLlxuICBjb25zdCBvcHRpb25zID0gcGFyc2VBcmdzKHByb2Nlc3MuYXJndi5zbGljZSgyKSlcbiAgY29uc29sZS5sb2coJ0Nsb3VETlMgQ2xvdWRGb3JtYXRpb24gU3luYyBieSBLZW5uZXRoIEZhbGNrIDxrZW5udUBjbG91ZGVuLm5ldD4gKEMpIENsb3VkZW4gT3kgMjAyMC0yMDI2JylcblxuICBpZiAoIW9wdGlvbnMudXNlcm5hbWUgfHwgIW9wdGlvbnMucGFzc3dvcmRQYXJhbWV0ZXIpIHtcbiAgICBjb25zb2xlLmVycm9yKFVTQUdFKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG4gIGlmIChvcHRpb25zLmZvcmNlUHJ1bmUgJiYgIW9wdGlvbnMuem9uZU5hbWVzLmxlbmd0aCkge1xuICAgIGNvbnNvbGUuZXJyb3IoJy0tZm9yY2UtcHJ1bmUgbmVlZHMgYXQgbGVhc3Qgb25lIC0tem9uZTogd2l0aCBubyBleHBvcnRzIHRoZXJlIGlzIG5vdGhpbmcgdG8gaW5mZXIgYSB6b25lIGZyb20nKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG5cbiAgY29uc3Qgc3NtID0gbmV3IFNTTUNsaWVudCh7fSlcbiAgY29uc3Qgem9uZUNhY2hlID0ge31cblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHNzbS5zZW5kKFxuICAgIG5ldyBHZXRQYXJhbWV0ZXJDb21tYW5kKHtcbiAgICAgIE5hbWU6IG9wdGlvbnMucGFzc3dvcmRQYXJhbWV0ZXIsXG4gICAgICBXaXRoRGVjcnlwdGlvbjogdHJ1ZSxcbiAgICB9KVxuICApXG4gIGNvbnN0IGNsb3VkbnNQYXNzd29yZCA9IHJlc3BvbnNlLlBhcmFtZXRlcj8uVmFsdWUgfHwgJydcblxuICAvLyBDb2xsZWN0IGV2ZXJ5dGhpbmcgdGhlIGV4cG9ydHMgYXNrIGZvciBiZWZvcmUgd3JpdGluZyBhbnl0aGluZywgc28gcHJ1bmluZyBjYW4gY29tcGFyZSBhZ2FpbnN0XG4gIC8vIHRoZSBjb21wbGV0ZSBwaWN0dXJlIHJhdGhlciB0aGFuIGFnYWluc3Qgd2hhdGV2ZXIgaGFzIGJlZW4gcHJvY2Vzc2VkIHNvIGZhci5cbiAgY29uc3QgZGVzaXJlZDogRGVzaXJlZFJlY29yZFtdID0gW11cbiAgLyoqIEV2ZXJ5IHNwZWxsaW5nIG9mIGEgc3RhY2sgdGhhdCBtYXRjaGVkLCBzbyAtLXN0YWNrIGNhbiBiZSBnaXZlbiBhcyBhIG5hbWUgb3IgYSBmdWxsIEFSTi4gKi9cbiAgY29uc3QgbWF0Y2hlZFN0YWNrcyA9IG5ldyBTZXQ8c3RyaW5nPigpXG4gIC8qKiBTaG9ydCBuYW1lcyBvbmx5LCB3aGljaCBpcyB0aGUgZm9ybSBvd25lcnNoaXAgbm90ZXMgY2FycnksIHNvIHBydW5pbmcgY2FuIGJlIHNjb3BlZCBieSB0aGVtLiAqL1xuICBjb25zdCBtYXRjaGVkU3RhY2tOYW1lcyA9IG5ldyBTZXQ8c3RyaW5nPigpXG4gIGNvbnN0IGNsb3VkRm9ybWF0aW9uID0gbmV3IENsb3VkRm9ybWF0aW9uQ2xpZW50KHt9KVxuICBsZXQgbmV4dFRva2VuXG4gIGRvIHtcbiAgICBjb25zdCByZXNwb25zZTogTGlzdEV4cG9ydHNPdXRwdXQgPSBhd2FpdCBjbG91ZEZvcm1hdGlvbi5zZW5kKG5ldyBMaXN0RXhwb3J0c0NvbW1hbmQoeyBOZXh0VG9rZW46IG5leHRUb2tlbiB9KSlcbiAgICBmb3IgKGNvbnN0IGV4cG9ydE9iaiBvZiByZXNwb25zZS5FeHBvcnRzIHx8IFtdKSB7XG4gICAgICBjb25zdCBzdGFja01hdGNoID0gZXhwb3J0T2JqLkV4cG9ydGluZ1N0YWNrSWQ/Lm1hdGNoKC9eYXJuOlteOl0rOmNsb3VkZm9ybWF0aW9uOlteOl0rOlteOl0rOnN0YWNrXFwvKFteL10rKVxcLy8pXG4gICAgICBjb25zdCBzdGFja05hbWUgPSBzdGFja01hdGNoID8gc3RhY2tNYXRjaFsxXSA6IGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkIHx8ICcnXG4gICAgICBpZiAob3B0aW9ucy5zdGFja05hbWVzLmxlbmd0aCAmJiAhb3B0aW9ucy5zdGFja05hbWVzLmluY2x1ZGVzKGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkIHx8ICcnKSAmJiAhb3B0aW9ucy5zdGFja05hbWVzLmluY2x1ZGVzKHN0YWNrTmFtZSkpIHtcbiAgICAgICAgY29udGludWVcbiAgICAgIH1cbiAgICAgIGlmICghZXhwb3J0T2JqLk5hbWU/Lm1hdGNoKC9eQ2xvdUROUzovKSkgY29udGludWVcblxuICAgICAgY29uc3QgeyByZXNvdXJjZVR5cGUsIHJlc291cmNlTmFtZSB9ID0gcGFyc2VFeHBvcnROYW1lKGV4cG9ydE9iai5OYW1lKVxuICAgICAgY29uc3QgeyB6b25lTmFtZSwgaG9zdE5hbWUgfSA9IGF3YWl0IGF1dG9EZXRlY3RDbG91ZG5zSG9zdEFuZFpvbmUob3B0aW9ucy51c2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCByZXNvdXJjZU5hbWUsIHpvbmVDYWNoZSlcbiAgICAgIG1hdGNoZWRTdGFja3MuYWRkKHN0YWNrTmFtZSlcbiAgICAgIG1hdGNoZWRTdGFja05hbWVzLmFkZChzdGFja05hbWUpXG4gICAgICBpZiAoZXhwb3J0T2JqLkV4cG9ydGluZ1N0YWNrSWQpIG1hdGNoZWRTdGFja3MuYWRkKGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkKVxuICAgICAgZGVzaXJlZC5wdXNoKHtcbiAgICAgICAgem9uZU5hbWUsXG4gICAgICAgIGhvc3ROYW1lLFxuICAgICAgICB0eXBlOiByZXNvdXJjZVR5cGUsXG4gICAgICAgIHZhbHVlOiBleHBvcnRPYmouVmFsdWUhLFxuICAgICAgICBzdGFja05hbWUsXG4gICAgICAgIGV4cG9ydE5hbWU6IGV4cG9ydE9iai5OYW1lLFxuICAgICAgfSlcbiAgICB9XG4gICAgbmV4dFRva2VuID0gcmVzcG9uc2UuTmV4dFRva2VuXG4gIH0gd2hpbGUgKG5leHRUb2tlbilcblxuICAvKipcbiAgICogQSAtLXN0YWNrIHRoYXQgbWF0Y2hlZCBub3RoaW5nIGlzIG5lYXJseSBhbHdheXMgYSB0eXBvIG9yIGEgc3RhY2sgdGhhdCBoYXMgbm90IGRlcGxveWVkIHlldC5cbiAgICogSXQgdXNlZCB0byBwYXNzIHNpbGVudGx5IGFzIGEgbm8tb3A7IHdpdGggLS1wcnVuZSB0aGUgc2FtZSBjb25kaXRpb24gd291bGQgbG9vayBsaWtlIFwiZXZlcnlcbiAgICogcmVjb3JkIGlzIGFuIG9ycGhhblwiLCBzbyBpdCBpcyBmYXRhbCB0aGVyZSBhbmQgYSB3YXJuaW5nIG90aGVyd2lzZS5cbiAgICpcbiAgICogLS1mb3JjZS1wcnVuZSBpcyB0aGUgZXhjZXB0aW9uOiBhIHRvcm4tZG93biBzdGFjayBwcm9kdWNpbmcgbm8gZXhwb3J0cyBpcyBwcmVjaXNlbHkgdGhlIGNhc2UgaXRcbiAgICogZXhpc3RzIGZvciwgYW5kIHRoZSBjYWxsZXIgaGFzIGFscmVhZHkgaGFkIHRvIG5hbWUgdGhlIHpvbmUgZXhwbGljaXRseSB0byBnZXQgdGhpcyBmYXIuXG4gICAqL1xuICBmb3IgKGNvbnN0IHN0YWNrTmFtZSBvZiBvcHRpb25zLnN0YWNrTmFtZXMpIHtcbiAgICBpZiAoIW1hdGNoZWRTdGFja3MuaGFzKHN0YWNrTmFtZSkpIHtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBgU3RhY2sgJHtzdGFja05hbWV9IHByb2R1Y2VkIG5vIENsb3VETlMgZXhwb3J0c2BcbiAgICAgIGlmIChvcHRpb25zLnBydW5lICYmICFvcHRpb25zLmZvcmNlUHJ1bmUpIHRocm93IG5ldyBFcnJvcihgJHttZXNzYWdlfTsgcmVmdXNpbmcgdG8gcHJ1bmUgb24gYW4gdW52ZXJpZmllZCBzdGFjayBuYW1lYClcbiAgICAgIGNvbnNvbGUud2FybignV0FSTicsIG1lc3NhZ2UpXG4gICAgfVxuICB9XG5cbiAgZm9yIChjb25zdCByZWNvcmQgb2YgZGVzaXJlZCkge1xuICAgIGF3YWl0IGNyZWF0ZU9yVXBkYXRlQ2xvdWRuc1Jlc291cmNlKG9wdGlvbnMudXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgcmVjb3JkLCBvcHRpb25zLnR0bCwgb3B0aW9ucy5kcnlSdW4pXG4gIH1cblxuICBpZiAoIW9wdGlvbnMucHJ1bmUpIHJldHVyblxuXG4gIGlmICghZGVzaXJlZC5sZW5ndGggJiYgIW9wdGlvbnMuZm9yY2VQcnVuZSkge1xuICAgIGNvbnNvbGUud2FybignV0FSTiBObyBleHBvcnRzIG1hdGNoZWQsIHNvIG5vdGhpbmcgaXMga25vd24gdG8gYmUgd2FudGVkOyBza2lwcGluZyBwcnVuZS4gVXNlIC0tZm9yY2UtcHJ1bmUgd2l0aCAtLXpvbmUgaWYgdGhpcyBpcyBhIHRlYXJkb3duLicpXG4gICAgcmV0dXJuXG4gIH1cblxuICBjb25zdCB6b25lTmFtZXMgPSBbLi4ubmV3IFNldChbLi4ub3B0aW9ucy56b25lTmFtZXMsIC4uLmRlc2lyZWQubWFwKChyZWNvcmQpID0+IHJlY29yZC56b25lTmFtZSldKV1cbiAgLyoqXG4gICAqIE5vdGVzIHJlY29yZCB0aGUgc2hvcnQgc3RhY2sgbmFtZSwgc28gc2NvcGluZyBvbiB0aGUgcmF3IC0tc3RhY2sgdmFsdWVzIHdvdWxkIHNpbGVudGx5IHBydW5lXG4gICAqIG5vdGhpbmcgd2hlbiBvbmUgd2FzIGdpdmVuIGFzIGFuIEFSTi4gQm90aCBzcGVsbGluZ3MgZ28gaW46IHRoZSByZXNvbHZlZCBuYW1lcyBjb3ZlciB0aGUgQVJOXG4gICAqIGNhc2UsIGFuZCB0aGUgcmF3IHZhbHVlcyBjb3ZlciAtLWZvcmNlLXBydW5lLCB3aGVyZSBhIHRvcm4tZG93biBzdGFjayByZXNvbHZlcyB0byBub3RoaW5nLlxuICAgKi9cbiAgY29uc3Qgc3RhY2tTY29wZSA9IG9wdGlvbnMuc3RhY2tOYW1lcy5sZW5ndGggPyBuZXcgU2V0KFsuLi5tYXRjaGVkU3RhY2tOYW1lcywgLi4ub3B0aW9ucy5zdGFja05hbWVzXSkgOiB1bmRlZmluZWRcbiAgYXdhaXQgcHJ1bmVPcnBoYW5zKG9wdGlvbnMudXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWVzLCBkZXNpcmVkLCBzdGFja1Njb3BlLCBvcHRpb25zKVxufVxuIl19