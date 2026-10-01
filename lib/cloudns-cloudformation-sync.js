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
exports.autoDetectCloudnsHostAndZone = autoDetectCloudnsHostAndZone;
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
/**
 * The ClouDNS zone a record name belongs to, and its host name within that zone.
 *
 * The most specific zone the account holds wins, the way DNS delegation does: with both example.org
 * and a delegated dev.example.org, www.dev.example.org goes into dev.example.org, because a record
 * written into example.org under that name is never served once the subdomain is delegated. Checked
 * from the full name down to two labels, so a name that is itself a zone gets the apex (empty host).
 */
async function autoDetectCloudnsHostAndZone(cloudnsUsername, cloudnsPassword, name, zoneCache) {
    const nameParts = name.split('.');
    for (let zoneLabels = nameParts.length; zoneLabels >= 2; zoneLabels--) {
        const zoneName = nameParts.slice(nameParts.length - zoneLabels).join('.');
        const zoneResponse = zoneCache[zoneName] ||
            (await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/get-zone-info.json', {
                'domain-name': zoneName,
            }));
        zoneCache[zoneName] = zoneResponse;
        if (zoneResponse.status === '1') {
            return {
                hostName: nameParts.slice(0, nameParts.length - zoneLabels).join('.'),
                zoneName: zoneName,
            };
        }
    }
    throw new Error('Zone Not Found: ' + name);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBdUNHO0FBQ0gsb0RBQW9FO0FBQ3BFLDBFQUE0RztBQUM1RyxNQUFZLFdBQVcsd0NBQW1CO0FBRTFDLHFCQUFxQjtBQUNyQixPQUFPLENBQUMsR0FBRyxDQUFDLG1CQUFtQixHQUFHLEdBQUcsQ0FBQTtBQUVyQyxxRkFBcUY7QUFDckYsTUFBTSxXQUFXLEdBQUcsd0NBQXdDLENBQUE7QUFFNUQsMEdBQTBHO0FBQzFHLE1BQU0saUJBQWlCLEdBQUcsRUFBRSxDQUFBO0FBa0M1QixNQUFNLEtBQUssR0FBRzs7Ozs7Ozs7Ozs7OzJFQVk2RCxpQkFBaUI7Ozs7OzhGQUtFLENBQUE7QUFFOUYsbUJBQTBCLElBQWM7SUFDdEMsTUFBTSxPQUFPLEdBQVk7UUFDdkIsUUFBUSxFQUFFLEVBQUU7UUFDWixpQkFBaUIsRUFBRSxFQUFFO1FBQ3JCLEdBQUcsRUFBRSxLQUFLO1FBQ1YsVUFBVSxFQUFFLEVBQUU7UUFDZCxTQUFTLEVBQUUsRUFBRTtRQUNiLEtBQUssRUFBRSxLQUFLO1FBQ1osVUFBVSxFQUFFLEtBQUs7UUFDakIsUUFBUSxFQUFFLGlCQUFpQjtRQUMzQixNQUFNLEVBQUUsS0FBSztLQUNkLENBQUE7SUFFRDs7OztPQUlHO0lBQ0gsSUFBSSxJQUFJLENBQUMsTUFBTSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQzVDLE9BQU8sQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFBO1FBQzFCLE9BQU8sQ0FB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LENBQUMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxDQUFBO1FBQy9CLENBQUM7SUFDSCxDQUFDO0lBRUQsS0FBSyxNQUFNLE1BQU0sSUFBSSxPQUFPLEVBQUUsQ0FBQztRQUM3QixNQUFNLDZCQUE2QixDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUUsZUFBZSxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQTtJQUM3RyxDQUFDO0lBRUQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLO1FBQUUsT0FBTTtJQUUxQixJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVLEVBQUUsQ0FBQztRQUMzQyxPQUFPLENBQUMsSUFBSSxDQUFDLGlJQUFpSSxDQUFDLENBQUE7UUFDL0ksT0FBTTtJQUNSLENBQUM7SUFFRCxNQUFNLFNBQVMsR0FBRyxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxTQUFTLEVBQUUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDbkc7Ozs7T0FJRztJQUNILE1BQU0sVUFBVSxHQUFHLE9BQU8sQ0FBQyxVQUFVLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxDQUFDLEdBQUcsaUJBQWlCLEVBQUUsR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFBO0lBQ2pILE1BQU0sWUFBWSxDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUUsZUFBZSxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsVUFBVSxFQUFFLE9BQU8sQ0FBQyxDQUFBO0FBQ2hHLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJlYWQgQVdTIENsb3VkRm9ybWF0aW9uIEV4cG9ydHMgYW5kIGF1dG9nZW5lcmF0ZSBDbG91RE5TIHJlY29yZHMgYmFzZWQgb24gdGhlaXIgbmFtZXMgYW5kIHZhbHVlcy5cbiAqIEtlbm5ldGggRmFsY2sgPGtlbm51QGNsb3VkZW4ubmV0PiAoQykgQ2xvdWRlbiBPeSAyMDIwLTIwMjZcbiAqXG4gKiBUaGlzIHRvb2wgY2FuIGJlIHVzZWQgdG8gYXV0b2dlbmVyYXRlIENsb3VETlMgcmVjb3JkcyBmb3IgQ2xvdWRGb3JtYXRpb24gcmVzb3VyY2VzIGxpa2VcbiAqIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9ucyBhbmQgQVBJIEdhdGV3YXkgZG9tYWlucy5cbiAqXG4gKiBDbG91ZEZvcm1hdGlvbiBleHBvcnQgbmFtZSBtdXN0IHNwZWNpZnkgdGhlIHJlc291cmNlIHR5cGUgYW5kIHJlY29yZCBob3N0bmFtZSBhcyBmb2xsb3dzOlxuICogQ2xvdUROUzpDTkFNRTpteWhvc3Q6ZXhhbXBsZTpvcmdcbiAqXG4gKiBDbG91ZEZvcm1hdGlvbiBleHBvcnQgdmFsdWUgbXVzdCBzcGVjaWZ5IHRoZSByZWNvcmQgdmFsdWUgYXMtaXMgKGZvciBpbnN0YW5jZSwgYSBkaXN0cmlidXRpb24gZG9tYWluIG5hbWUpOlxuICogeHh4eHh4eHh4eHh4eHguY2xvdWRmcm9udC5uZXRcbiAqXG4gKiBUaGUgYWJvdmUgZXhhbXBsZSB3aWxsIGdlbmVyYXRlIHRoZSBmb2xsb3dpbmcgcmVjb3JkIGluIHRoZSBDbG91RE5TIHpvbmUgZXhhbXBsZS5vcmc6XG4gKiBteWhvc3QuZXhhbXBsZS5vcmcgQ05BTUUgeHh4eHh4eHh4eHh4eHguY2xvdWRmcm9udC5uZXRcbiAqXG4gKiBPdGhlciByZXNvdXJjZSB0eXBlcyBhcmUgYWxzbyBhbGxvd2VkIChBLCBBQUFBLCBBTElBUywgZXRjKS5cbiAqXG4gKiAjIyBPd25lcnNoaXAgYW5kIHBydW5pbmdcbiAqXG4gKiBFdmVyeSByZWNvcmQgdGhpcyB0b29sIHdyaXRlcyBpcyBzdGFtcGVkIHdpdGggYSBDbG91RE5TIHJlY29yZCBub3RlIG5hbWluZyB0aGUgdG9vbCwgdGhlIHN0YWNrXG4gKiB3aG9zZSBleHBvcnQgcHJvZHVjZWQgaXQsIGFuZCB0aGF0IGV4cG9ydC4gVGhlIG5vdGUgaXMgd2hhdCBtYWtlcyBkZWxldGlvbiBzYWZlOiBhIHpvbmUgaG9sZHNcbiAqIHBsZW50eSBvZiByZWNvcmRzIG5vYm9keSBoZXJlIGNyZWF0ZWQsIGFuZCB3aXRob3V0IGEgbWFya2VyIHRoZXJlIGlzIG5vIHdheSB0byB0ZWxsIGFuIG9ycGhhblxuICogbGVmdCBiZWhpbmQgYnkgYSBkZWxldGVkIGV4cG9ydCBmcm9tIHNvbWV0aGluZyBhIGh1bWFuIGFkZGVkIGJ5IGhhbmQuIFJlY29yZHMgd2l0aG91dCB0aGUgbWFya2VyXG4gKiBhcmUgbmV2ZXIgY2FuZGlkYXRlcyBmb3IgZGVsZXRpb24uXG4gKlxuICogU3RhbXBpbmcgaGFwcGVucyBvbiBldmVyeSBzeW5jLCBzbyByZWNvcmRzIGNyZWF0ZWQgYmVmb3JlIHRoaXMgZmVhdHVyZSBhcmUgYWRvcHRlZCB0aGUgbmV4dCB0aW1lXG4gKiB0aGV5IGFyZSBzZWVuLiBUaGF0IGlzIHNhZmUgYmVjYXVzZSBhIHJlY29yZCBpcyBvbmx5IGV2ZXIgc3RhbXBlZCB3aGVuIGFuIGV4cG9ydCBjdXJyZW50bHkgY2xhaW1zXG4gKiBpdCDigJQgdGhlIHRvb2wgaXMgYWxyZWFkeSBvdmVyd3JpdGluZyB0aGF0IHJlY29yZCdzIHZhbHVlLCBzbyBpdCBhbHJlYWR5IG93bnMgaXQuXG4gKlxuICogUHJ1bmluZyBpcyBvcHQtaW4gYW5kIG5ldmVyIGhhcHBlbnMgYnkgYWNjaWRlbnQ6XG4gKlxuICogICAtLXBydW5lICAgICAgICBkZWxldGUgbWFuYWdlZCByZWNvcmRzIHdob3NlIGV4cG9ydCBpcyBnb25lLCBidXQgb25seSB3aGVuIHRoaXMgcnVuIGFjdHVhbGx5XG4gKiAgICAgICAgICAgICAgICAgIGZvdW5kIGV4cG9ydHMuIEFuIGVtcHR5IGV4cG9ydCBzZXQgaXMgZmFyIG1vcmUgbGlrZWx5IGEgd3JvbmcgLS1zdGFjayBvciBhbiBBV1NcbiAqICAgICAgICAgICAgICAgICAgZXJyb3IgdGhhbiBhIGdlbnVpbmUgaW5zdHJ1Y3Rpb24gdG8gZGVsZXRlIGV2ZXJ5IHJlY29yZC5cbiAqICAgLS1mb3JjZS1wcnVuZSAgYWxzbyBwcnVuZSB3aGVuIHRoZSBleHBvcnQgc2V0IGlzIGVtcHR5LCBmb3IgdGhlIHJlYWwgdGVhcmRvd24gY2FzZS4gUmVxdWlyZXMgYW5cbiAqICAgICAgICAgICAgICAgICAgZXhwbGljaXQgLS16b25lLCBiZWNhdXNlIHdpdGggbm8gZXhwb3J0cyB0aGVyZSBpcyBub3RoaW5nIHRvIGluZmVyIGEgem9uZSBmcm9tLlxuICpcbiAqIEEgY2FwIG9uIGhvdyBtYW55IHJlY29yZHMgb25lIHJ1biBtYXkgZGVsZXRlIGFwcGxpZXMgdG8gYm90aC5cbiAqL1xuaW1wb3J0IHsgU1NNQ2xpZW50LCBHZXRQYXJhbWV0ZXJDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNzbSdcbmltcG9ydCB7IENsb3VkRm9ybWF0aW9uQ2xpZW50LCBMaXN0RXhwb3J0c0NvbW1hbmQsIExpc3RFeHBvcnRzT3V0cHV0IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWNsb3VkZm9ybWF0aW9uJ1xuaW1wb3J0ICogYXMgcXVlcnlzdHJpbmcgZnJvbSAncXVlcnlzdHJpbmcnXG5cbi8vIExvYWQgfi8uYXdzL2NvbmZpZ1xucHJvY2Vzcy5lbnYuQVdTX1NES19MT0FEX0NPTkZJRyA9ICcxJ1xuXG4vKiogTWFya3MgYSByZWNvcmQgYXMgb3Vycy4gUHJlc2VudCBpbiB0aGUgbm90ZSBvZiBldmVyeSByZWNvcmQgdGhpcyB0b29sIG1hbmFnZXMuICovXG5jb25zdCBOT1RFX01BUktFUiA9ICdtYW5hZ2VkLWJ5PWNsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYydcblxuLyoqIE1vc3QgcmVjb3JkcyBvbmUgcnVuIHdpbGwgZGVsZXRlIGJlZm9yZSByZWZ1c2luZy4gUmFpc2Ugd2l0aCAtLW1heC1wcnVuZSB3aGVuIGl0IGlzIGdlbnVpbmVseSBtb3JlLiAqL1xuY29uc3QgREVGQVVMVF9NQVhfUFJVTkUgPSAxMFxuXG50eXBlIENsb3VkbnNSZXN0Q2FsbFJlc3BvbnNlID0gYW55XG5cbmludGVyZmFjZSBPcHRpb25zIHtcbiAgdXNlcm5hbWU6IHN0cmluZ1xuICBwYXNzd29yZFBhcmFtZXRlcjogc3RyaW5nXG4gIHR0bDogc3RyaW5nXG4gIHN0YWNrTmFtZXM6IHN0cmluZ1tdXG4gIHpvbmVOYW1lczogc3RyaW5nW11cbiAgcHJ1bmU6IGJvb2xlYW5cbiAgZm9yY2VQcnVuZTogYm9vbGVhblxuICBtYXhQcnVuZTogbnVtYmVyXG4gIGRyeVJ1bjogYm9vbGVhblxufVxuXG5pbnRlcmZhY2UgRGVzaXJlZFJlY29yZCB7XG4gIHpvbmVOYW1lOiBzdHJpbmdcbiAgaG9zdE5hbWU6IHN0cmluZ1xuICB0eXBlOiBzdHJpbmdcbiAgdmFsdWU6IHN0cmluZ1xuICBzdGFja05hbWU6IHN0cmluZ1xuICBleHBvcnROYW1lOiBzdHJpbmdcbn1cblxuaW50ZXJmYWNlIENsb3VkbnNSZWNvcmQge1xuICBpZDogc3RyaW5nXG4gIGhvc3Q6IHN0cmluZ1xuICB0eXBlOiBzdHJpbmdcbiAgdHRsOiBzdHJpbmdcbiAgcmVjb3JkOiBzdHJpbmdcbiAgbm90ZT86IHN0cmluZ1xufVxuXG5jb25zdCBVU0FHRSA9IGBDbG91RE5TIENsb3VkRm9ybWF0aW9uIFN5bmNcblxuVXNhZ2U6IGNsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYyAtdSA8dXNlcm5hbWU+IC1wIDxwYXNzd29yZC1wYXJhbWV0ZXI+IFtvcHRpb25zXVxuICAgICAgIGNsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYyA8dXNlcm5hbWU+IDxwYXNzd29yZC1wYXJhbWV0ZXI+IFt0dGwgW3N0YWNrLi4uXV0gICAobGVnYWN5KVxuXG4gIC11LCAtLXVzZXJuYW1lIDxuYW1lPiAgICAgICAgIENsb3VETlMgQVBJIHN1Yi1hdXRoLXVzZXJcbiAgLXAsIC0tcGFzc3dvcmQtcGFyYW1ldGVyIDxwPiAgU1NNIHBhcmFtZXRlciBob2xkaW5nIHRoZSBlbmNyeXB0ZWQgQ2xvdUROUyBBUEkgcGFzc3dvcmRcbiAgLXQsIC0tdHRsIDxzZWNvbmRzPiAgICAgICAgICAgVFRMIGZvciBnZW5lcmF0ZWQgcmVjb3JkcyAoZGVmYXVsdCAzMDApXG4gIC1zLCAtLXN0YWNrIDxuYW1lfGFybj4gICAgICAgIExpbWl0IHRvIHRoaXMgQ2xvdWRGb3JtYXRpb24gc3RhY2s7IHJlcGVhdGFibGVcbiAgLXosIC0tem9uZSA8bmFtZT4gICAgICAgICAgICAgQWxzbyBzY2FuIHRoaXMgem9uZSB3aGVuIHBydW5pbmc7IHJlcGVhdGFibGVcbiAgICAgIC0tcHJ1bmUgICAgICAgICAgICAgICAgICAgRGVsZXRlIG1hbmFnZWQgcmVjb3JkcyB3aG9zZSBleHBvcnQgaXMgZ29uZVxuICAgICAgLS1mb3JjZS1wcnVuZSAgICAgICAgICAgICBBbHNvIHBydW5lIHdoZW4gbm8gZXhwb3J0cyB3ZXJlIGZvdW5kOyByZXF1aXJlcyAtLXpvbmVcbiAgICAgIC0tbWF4LXBydW5lIDxuPiAgICAgICAgICAgTW9zdCByZWNvcmRzIG9uZSBydW4gbWF5IGRlbGV0ZSAoZGVmYXVsdCAke0RFRkFVTFRfTUFYX1BSVU5FfSlcbiAgLW4sIC0tZHJ5LXJ1biAgICAgICAgICAgICAgICAgUmVwb3J0IHdoYXQgd291bGQgY2hhbmdlIHdpdGhvdXQgY2hhbmdpbmcgaXRcbiAgLWgsIC0taGVscCAgICAgICAgICAgICAgICAgICAgU2hvdyB0aGlzIGhlbHBcbiAgLVYsIC0tdmVyc2lvbiAgICAgICAgICAgICAgICAgU2hvdyB0aGUgdmVyc2lvblxuXG5BV1NfUFJPRklMRSBzZWxlY3RzIHRoZSBBV1MgY3JlZGVudGlhbHMsIGFzIHVzdWFsLiBERUJVRz0xIHByaW50cyBmdWxsIHN0YWNrIHRyYWNlcyBvbiBlcnJvci5gXG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUFyZ3MoYXJndjogc3RyaW5nW10pOiBPcHRpb25zIHtcbiAgY29uc3Qgb3B0aW9uczogT3B0aW9ucyA9IHtcbiAgICB1c2VybmFtZTogJycsXG4gICAgcGFzc3dvcmRQYXJhbWV0ZXI6ICcnLFxuICAgIHR0bDogJzMwMCcsXG4gICAgc3RhY2tOYW1lczogW10sXG4gICAgem9uZU5hbWVzOiBbXSxcbiAgICBwcnVuZTogZmFsc2UsXG4gICAgZm9yY2VQcnVuZTogZmFsc2UsXG4gICAgbWF4UHJ1bmU6IERFRkFVTFRfTUFYX1BSVU5FLFxuICAgIGRyeVJ1bjogZmFsc2UsXG4gIH1cblxuICAvKipcbiAgICogQW55dGhpbmcgbm90IHN0YXJ0aW5nIHdpdGggXCItXCIgaW4gdGhlIGZpcnN0IHBvc2l0aW9uIGlzIHRoZSBvbGQgcG9zaXRpb25hbCBmb3JtOlxuICAgKiA8dXNlcm5hbWU+IDxwYXNzd29yZC1wYXJhbWV0ZXI+IFt0dGwgW3N0YWNrLi4uXV0uIEtlcHQgd29ya2luZyBzbyBleGlzdGluZyBkZXBsb3kgc2NyaXB0cyBhbmRcbiAgICogQ0kgam9icyBkbyBub3QgaGF2ZSB0byBjaGFuZ2UgaW4gdGhlIHNhbWUgcmVsZWFzZSB0aGF0IGFkZHMgcHJ1bmluZy5cbiAgICovXG4gIGlmIChhcmd2Lmxlbmd0aCAmJiAhYXJndlswXS5zdGFydHNXaXRoKCctJykpIHtcbiAgICBvcHRpb25zLnVzZXJuYW1lID0gYXJndlswXVxuICAgIG9wdGlvbnMucGFzc3dvcmRQYXJhbWV0ZXIgPSBhcmd2WzFdIHx8ICcnXG4gICAgLyoqXG4gICAgICogT3B0aW9ucyBhcmUgc3RpbGwgaG9ub3VyZWQgYWZ0ZXIgdGhlIHBvc2l0aW9uYWwgYXJndW1lbnRzLiBUcmVhdGluZyBhIHRyYWlsaW5nIFwiLW5cIiBhcyBhXG4gICAgICogc3RhY2sgbmFtZSBpbnN0ZWFkIGlzIGhvdyBhIHJ1biB0aGUgY2FsbGVyIGJlbGlldmVkIHdhcyBhIHJlaGVhcnNhbCB3cml0ZXMgZm9yIHJlYWwg4oCUIHdoaWNoXG4gICAgICogaXMgZXhhY3RseSB3aGF0IGhhcHBlbmVkIHRoZSBmaXJzdCB0aW1lIHRoaXMgd2FzIHRlc3RlZC5cbiAgICAgKi9cbiAgICBjb25zdCByZXN0ID0gYXJndi5zbGljZSgyKVxuICAgIGNvbnN0IGZsYWdJbmRleCA9IHJlc3QuZmluZEluZGV4KChhcmcpID0+IGFyZy5zdGFydHNXaXRoKCctJykpXG4gICAgY29uc3QgcG9zaXRpb25hbCA9IGZsYWdJbmRleCA9PT0gLTEgPyByZXN0IDogcmVzdC5zbGljZSgwLCBmbGFnSW5kZXgpXG4gICAgaWYgKHBvc2l0aW9uYWxbMF0pIG9wdGlvbnMudHRsID0gcG9zaXRpb25hbFswXVxuICAgIG9wdGlvbnMuc3RhY2tOYW1lcyA9IHBvc2l0aW9uYWwuc2xpY2UoMSlcbiAgICBpZiAoZmxhZ0luZGV4ICE9PSAtMSkgYXBwbHlGbGFncyhyZXN0LnNsaWNlKGZsYWdJbmRleCksIG9wdGlvbnMpXG4gICAgcmV0dXJuIG9wdGlvbnNcbiAgfVxuXG4gIGFwcGx5RmxhZ3MoYXJndiwgb3B0aW9ucylcbiAgcmV0dXJuIG9wdGlvbnNcbn1cblxuZnVuY3Rpb24gYXBwbHlGbGFncyhhcmd2OiBzdHJpbmdbXSwgb3B0aW9uczogT3B0aW9ucyk6IHZvaWQge1xuICBjb25zdCBuZXh0ID0gKGluZGV4OiBudW1iZXIsIGZsYWc6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgdmFsdWUgPSBhcmd2W2luZGV4ICsgMV1cbiAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZS5zdGFydHNXaXRoKCctJykpIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyB2YWx1ZSBmb3IgJHtmbGFnfWApXG4gICAgcmV0dXJuIHZhbHVlXG4gIH1cblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3YubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBhcmcgPSBhcmd2W2ldXG4gICAgc3dpdGNoIChhcmcpIHtcbiAgICAgIGNhc2UgJy11JzpcbiAgICAgIGNhc2UgJy0tdXNlcm5hbWUnOlxuICAgICAgICBvcHRpb25zLnVzZXJuYW1lID0gbmV4dChpLCBhcmcpXG4gICAgICAgIGkrK1xuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLXAnOlxuICAgICAgY2FzZSAnLS1wYXNzd29yZC1wYXJhbWV0ZXInOlxuICAgICAgICBvcHRpb25zLnBhc3N3b3JkUGFyYW1ldGVyID0gbmV4dChpLCBhcmcpXG4gICAgICAgIGkrK1xuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLXQnOlxuICAgICAgY2FzZSAnLS10dGwnOlxuICAgICAgICBvcHRpb25zLnR0bCA9IG5leHQoaSwgYXJnKVxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy1zJzpcbiAgICAgIGNhc2UgJy0tc3RhY2snOlxuICAgICAgICBvcHRpb25zLnN0YWNrTmFtZXMucHVzaChuZXh0KGksIGFyZykpXG4gICAgICAgIGkrK1xuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLXonOlxuICAgICAgY2FzZSAnLS16b25lJzpcbiAgICAgICAgb3B0aW9ucy56b25lTmFtZXMucHVzaChuZXh0KGksIGFyZykpXG4gICAgICAgIGkrK1xuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLS1wcnVuZSc6XG4gICAgICAgIG9wdGlvbnMucHJ1bmUgPSB0cnVlXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctLWZvcmNlLXBydW5lJzpcbiAgICAgICAgb3B0aW9ucy5wcnVuZSA9IHRydWVcbiAgICAgICAgb3B0aW9ucy5mb3JjZVBydW5lID0gdHJ1ZVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLS1tYXgtcHJ1bmUnOiB7XG4gICAgICAgIGNvbnN0IHJhdyA9IG5leHQoaSwgYXJnKVxuICAgICAgICBjb25zdCBwYXJzZWQgPSBOdW1iZXIocmF3KVxuICAgICAgICAvLyBOdW1iZXIoJ2FiYycpIGlzIE5hTiwgYW5kIGBvcnBoYW5zLmxlbmd0aCA+IE5hTmAgaXMgZmFsc2Ug4oCUIGFuIHVudmFsaWRhdGVkIHZhbHVlIGhlcmVcbiAgICAgICAgLy8gd291bGQgcXVpZXRseSByZW1vdmUgdGhlIGNhcCByYXRoZXIgdGhhbiB0aWdodGVuIGl0LlxuICAgICAgICBpZiAoIU51bWJlci5pc0ludGVnZXIocGFyc2VkKSB8fCBwYXJzZWQgPCAwKSB0aHJvdyBuZXcgRXJyb3IoYC0tbWF4LXBydW5lIG5lZWRzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGdvdDogJHtyYXd9YClcbiAgICAgICAgb3B0aW9ucy5tYXhQcnVuZSA9IHBhcnNlZFxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIH1cbiAgICAgIGNhc2UgJy1uJzpcbiAgICAgIGNhc2UgJy0tZHJ5LXJ1bic6XG4gICAgICAgIG9wdGlvbnMuZHJ5UnVuID0gdHJ1ZVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLWgnOlxuICAgICAgY2FzZSAnLS1oZWxwJzpcbiAgICAgICAgY29uc29sZS5sb2coVVNBR0UpXG4gICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLVYnOlxuICAgICAgY2FzZSAnLS12ZXJzaW9uJzpcbiAgICAgICAgY29uc29sZS5sb2cocmVxdWlyZSgnLi4vcGFja2FnZS5qc29uJykudmVyc2lvbilcbiAgICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgICAgIGJyZWFrXG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gb3B0aW9uOiAke2FyZ31gKVxuICAgIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbG91ZG5zUmVzdENhbGwoXG4gIGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLFxuICBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZyxcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHJlbGF0aXZlVXJsOiBzdHJpbmcsXG4gIHF1ZXJ5T3B0aW9uczogYW55XG4pOiBQcm9taXNlPENsb3VkbnNSZXN0Q2FsbFJlc3BvbnNlPiB7XG4gIGNvbnN0IGZ1bGxVcmwgPVxuICAgICdodHRwczovL2FwaS5jbG91ZG5zLm5ldCcgK1xuICAgIHJlbGF0aXZlVXJsICtcbiAgICAnPycgK1xuICAgIHF1ZXJ5c3RyaW5nLnN0cmluZ2lmeShcbiAgICAgIE9iamVjdC5hc3NpZ24oXG4gICAgICAgIHtcbiAgICAgICAgICAnc3ViLWF1dGgtdXNlcic6IGNsb3VkbnNVc2VybmFtZSxcbiAgICAgICAgICAnYXV0aC1wYXNzd29yZCc6IGNsb3VkbnNQYXNzd29yZCxcbiAgICAgICAgfSxcbiAgICAgICAgcXVlcnlPcHRpb25zIHx8IHt9XG4gICAgICApXG4gICAgKVxuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goZnVsbFVybCwge1xuICAgIG1ldGhvZDogbWV0aG9kLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICB9LFxuICB9KVxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpXG4gICAgY29uc29sZS5lcnJvcignSFRUUCBFcnJvcicsIHJlc3BvbnNlLnN0YXR1cywgcmVzcG9uc2Uuc3RhdHVzVGV4dCwgZXJyb3JUZXh0KVxuICAgIHRocm93IG5ldyBFcnJvcihlcnJvclRleHQpXG4gIH1cbiAgcmV0dXJuIChhd2FpdCByZXNwb25zZS5qc29uKCkpIGFzIENsb3VkbnNSZXN0Q2FsbFJlc3BvbnNlXG59XG5cbi8qKlxuICogQ2xvdUROUyByZXBvcnRzIGZhaWx1cmVzIGluIHRoZSBib2R5IHdpdGggSFRUUCAyMDAsIHNvIGEgY2FsbCBpcyBvbmx5IHN1Y2Nlc3NmdWwgaWYgaXQgc2F5cyBzby5cbiAqXG4gKiBUcmVhdGluZyBcIm5vdCB0aGUgc3RyaW5nIEZhaWxlZFwiIGFzIHN1Y2Nlc3MgaXMgaG93IGEgcmVqZWN0ZWQgd3JpdGUgZ2V0cyByZXBvcnRlZCBhcyBkb25lIOKAlFxuICogY2hlY2tlZCBwb3NpdGl2ZWx5IGhlcmUgaW5zdGVhZC5cbiAqL1xuZnVuY3Rpb24gYXNzZXJ0U3VjY2VzcyhyZXN1bHQ6IGFueSwgd2hhdDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHN0YXR1cyA9IHJlc3VsdD8uc3RhdHVzXG4gIGlmIChzdGF0dXMgPT09ICdTdWNjZXNzJyB8fCBzdGF0dXMgPT09IDEgfHwgc3RhdHVzID09PSAnMScpIHJldHVyblxuICB0aHJvdyBuZXcgRXJyb3IoYCR7d2hhdH0gZmFpbGVkOiAke3Jlc3VsdD8uc3RhdHVzRGVzY3JpcHRpb24gfHwgcmVzdWx0Py5zdGF0dXNNZXNzYWdlIHx8IEpTT04uc3RyaW5naWZ5KHJlc3VsdCl9YClcbn1cblxuLyoqXG4gKiBUaGUgQ2xvdUROUyB6b25lIGEgcmVjb3JkIG5hbWUgYmVsb25ncyB0bywgYW5kIGl0cyBob3N0IG5hbWUgd2l0aGluIHRoYXQgem9uZS5cbiAqXG4gKiBUaGUgbW9zdCBzcGVjaWZpYyB6b25lIHRoZSBhY2NvdW50IGhvbGRzIHdpbnMsIHRoZSB3YXkgRE5TIGRlbGVnYXRpb24gZG9lczogd2l0aCBib3RoIGV4YW1wbGUub3JnXG4gKiBhbmQgYSBkZWxlZ2F0ZWQgZGV2LmV4YW1wbGUub3JnLCB3d3cuZGV2LmV4YW1wbGUub3JnIGdvZXMgaW50byBkZXYuZXhhbXBsZS5vcmcsIGJlY2F1c2UgYSByZWNvcmRcbiAqIHdyaXR0ZW4gaW50byBleGFtcGxlLm9yZyB1bmRlciB0aGF0IG5hbWUgaXMgbmV2ZXIgc2VydmVkIG9uY2UgdGhlIHN1YmRvbWFpbiBpcyBkZWxlZ2F0ZWQuIENoZWNrZWRcbiAqIGZyb20gdGhlIGZ1bGwgbmFtZSBkb3duIHRvIHR3byBsYWJlbHMsIHNvIGEgbmFtZSB0aGF0IGlzIGl0c2VsZiBhIHpvbmUgZ2V0cyB0aGUgYXBleCAoZW1wdHkgaG9zdCkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhdXRvRGV0ZWN0Q2xvdWRuc0hvc3RBbmRab25lKGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLCBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZywgbmFtZTogc3RyaW5nLCB6b25lQ2FjaGU6IGFueSkge1xuICBjb25zdCBuYW1lUGFydHMgPSBuYW1lLnNwbGl0KCcuJylcbiAgZm9yIChsZXQgem9uZUxhYmVscyA9IG5hbWVQYXJ0cy5sZW5ndGg7IHpvbmVMYWJlbHMgPj0gMjsgem9uZUxhYmVscy0tKSB7XG4gICAgY29uc3Qgem9uZU5hbWUgPSBuYW1lUGFydHMuc2xpY2UobmFtZVBhcnRzLmxlbmd0aCAtIHpvbmVMYWJlbHMpLmpvaW4oJy4nKVxuICAgIGNvbnN0IHpvbmVSZXNwb25zZSA9XG4gICAgICB6b25lQ2FjaGVbem9uZU5hbWVdIHx8XG4gICAgICAoYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnR0VUJywgJy9kbnMvZ2V0LXpvbmUtaW5mby5qc29uJywge1xuICAgICAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAgIH0pKVxuICAgIHpvbmVDYWNoZVt6b25lTmFtZV0gPSB6b25lUmVzcG9uc2VcbiAgICBpZiAoem9uZVJlc3BvbnNlLnN0YXR1cyA9PT0gJzEnKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBob3N0TmFtZTogbmFtZVBhcnRzLnNsaWNlKDAsIG5hbWVQYXJ0cy5sZW5ndGggLSB6b25lTGFiZWxzKS5qb2luKCcuJyksXG4gICAgICAgIHpvbmVOYW1lOiB6b25lTmFtZSxcbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKCdab25lIE5vdCBGb3VuZDogJyArIG5hbWUpXG59XG5cbi8qKlxuICogRXZlcnkgcmVjb3JkIGluIGEgem9uZSwgbm90ZXMgaW5jbHVkZWQuIEFsc28gdGhlIGJhc2lzIGZvciBmaW5kaW5nIG9ycGhhbnMuXG4gKlxuICogQ2FjaGVkIHBlciBydW46IGxvb2tpbmcgYSByZWNvcmQgdXAgYW5kIHRoZW4gdmVyaWZ5aW5nIGl0IHVzZWQgdG8gY29zdCB0d28gd2hvbGUtem9uZSBjYWxscyBlYWNoLFxuICogc28gdHdlbnR5IGV4cG9ydHMgbWVhbnQgZm9ydHkgbGlzdGluZ3MgYWdhaW5zdCBhbiBBUEkgdGhhdCByYXRlIGxpbWl0cy4gQW55IHdyaXRlIGludmFsaWRhdGVzIHRoZVxuICogem9uZSwgYW5kIHZlcmlmaWNhdGlvbiBhbHdheXMgcmVhZHMgZnJlc2gsIHNvIGEgY2FjaGVkIGxpc3RpbmcgaXMgbmV2ZXIgdXNlZCB0byBqdWRnZSBzb21ldGhpbmdcbiAqIHRoYXQgaGFzIGp1c3QgY2hhbmdlZC5cbiAqL1xuY29uc3Qgem9uZVJlY29yZHNDYWNoZSA9IG5ldyBNYXA8c3RyaW5nLCBDbG91ZG5zUmVjb3JkW10+KClcblxuYXN5bmMgZnVuY3Rpb24gbGlzdFpvbmVSZWNvcmRzKGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLCBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZywgem9uZU5hbWU6IHN0cmluZywgZnJlc2ggPSBmYWxzZSk6IFByb21pc2U8Q2xvdWRuc1JlY29yZFtdPiB7XG4gIGlmICghZnJlc2gpIHtcbiAgICBjb25zdCBjYWNoZWQgPSB6b25lUmVjb3Jkc0NhY2hlLmdldCh6b25lTmFtZSlcbiAgICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkXG4gIH1cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdHRVQnLCAnL2Rucy9yZWNvcmRzLmpzb24nLCB7XG4gICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgJ2luY2x1ZGUtbm90ZXMnOiAnMScsXG4gIH0pXG4gIC8vIEFuIGVtcHR5IHpvbmUgY29tZXMgYmFjayBhcyBhbiBlbXB0eSBhcnJheSByYXRoZXIgdGhhbiBhbiBlbXB0eSBvYmplY3QuXG4gIGNvbnN0IHJlY29yZHMgPSAhcmVzcG9uc2UgfHwgQXJyYXkuaXNBcnJheShyZXNwb25zZSkgPyBbXSA6IChPYmplY3QudmFsdWVzKHJlc3BvbnNlKSBhcyBDbG91ZG5zUmVjb3JkW10pXG4gIHpvbmVSZWNvcmRzQ2FjaGUuc2V0KHpvbmVOYW1lLCByZWNvcmRzKVxuICByZXR1cm4gcmVjb3Jkc1xufVxuXG5mdW5jdGlvbiBvd25lcnNoaXBOb3RlKHN0YWNrTmFtZTogc3RyaW5nLCBleHBvcnROYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7Tk9URV9NQVJLRVJ9IHN0YWNrPSR7c3RhY2tOYW1lfSBleHBvcnQ9JHtleHBvcnROYW1lfWBcbn1cblxuLyoqIFRoZSBzdGFjayBuYW1lZCBpbiBhIHJlY29yZCdzIG5vdGUsIG9yIHVuZGVmaW5lZCB3aGVuIHRoZSByZWNvcmQgaXMgbm90IG91cnMuICovXG5mdW5jdGlvbiBub3RlU3RhY2tOYW1lKHJlY29yZDogQ2xvdWRuc1JlY29yZCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmICghcmVjb3JkLm5vdGUgfHwgcmVjb3JkLm5vdGUuaW5kZXhPZihOT1RFX01BUktFUikgPT09IC0xKSByZXR1cm4gdW5kZWZpbmVkXG4gIGNvbnN0IG1hdGNoID0gL3N0YWNrPShcXFMrKS8uZXhlYyhyZWNvcmQubm90ZSlcbiAgcmV0dXJuIG1hdGNoID8gbWF0Y2hbMV0gOiAnJ1xufVxuXG5hc3luYyBmdW5jdGlvbiBzZXRSZWNvcmROb3RlKFxuICBjbG91ZG5zVXNlcm5hbWU6IHN0cmluZyxcbiAgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsXG4gIHpvbmVOYW1lOiBzdHJpbmcsXG4gIHJlY29yZElkOiBzdHJpbmcsXG4gIG5vdGU6IHN0cmluZyxcbiAgZHJ5UnVuOiBib29sZWFuXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKGRyeVJ1bikgcmV0dXJuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ1BPU1QnLCAnL2Rucy9zZXQtcmVjb3JkLW5vdGUuanNvbicsIHtcbiAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAncmVjb3JkLWlkJzogcmVjb3JkSWQsXG4gICAgbm90ZTogbm90ZSxcbiAgfSlcbiAgYXNzZXJ0U3VjY2VzcyhyZXN1bHQsICdTZXQgcmVjb3JkIG5vdGUnKVxuICB6b25lUmVjb3Jkc0NhY2hlLmRlbGV0ZSh6b25lTmFtZSlcbn1cblxuYXN5bmMgZnVuY3Rpb24gY3JlYXRlT3JVcGRhdGVDbG91ZG5zUmVzb3VyY2UoXG4gIGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLFxuICBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZyxcbiAgZGVzaXJlZDogRGVzaXJlZFJlY29yZCxcbiAgdHRsVmFsdWU6IHN0cmluZyxcbiAgZHJ5UnVuOiBib29sZWFuXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyB6b25lTmFtZSwgaG9zdE5hbWUsIHR5cGUsIHZhbHVlIH0gPSBkZXNpcmVkXG4gIGNvbnN0IG5hbWUgPSBob3N0TmFtZSA/IGAke2hvc3ROYW1lfS4ke3pvbmVOYW1lfWAgOiB6b25lTmFtZVxuXG4gIGNvbnN0IHJlY29yZHMgPSBhd2FpdCBsaXN0Wm9uZVJlY29yZHMoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHpvbmVOYW1lKVxuICAvKipcbiAgICogTWF0Y2ggb24gaG9zdCBhbmQgdHlwZSBhY3Jvc3MgdGhlIHdob2xlIHpvbmUgcmF0aGVyIHRoYW4gdHJ1c3RpbmcgYSBmaWx0ZXJlZCBxdWVyeSdzIGZpcnN0XG4gICAqIGVudHJ5LiBUYWtpbmcgd2hpY2hldmVyIHJlY29yZCBoYXBwZW5lZCB0byBjb21lIGJhY2sgZmlyc3QgbWVhbnQgdGhhdCBhIGhvc3Qgd2l0aCBtb3JlIHRoYW4gb25lXG4gICAqIHJlY29yZCBvZiBhIHR5cGUgaGFkIG9uZSBvZiB0aGVtIHVwZGF0ZWQgYXQgcmFuZG9tIHdoaWxlIHRoZSBvdGhlciBrZXB0IHNlcnZpbmcgdHJhZmZpYy5cbiAgICovXG4gIGNvbnN0IG1hdGNoaW5nID0gcmVjb3Jkcy5maWx0ZXIoKHJlY29yZCkgPT4gcmVjb3JkLmhvc3QgPT09IGhvc3ROYW1lICYmIHJlY29yZC50eXBlID09PSB0eXBlKVxuICBpZiAobWF0Y2hpbmcubGVuZ3RoID4gMSkge1xuICAgIGNvbnNvbGUud2FybignV0FSTicsIG5hbWUsIHR5cGUsICdoYXMnLCBtYXRjaGluZy5sZW5ndGgsICdyZWNvcmRzOyB1cGRhdGluZyB0aGUgZmlyc3QgYW5kIGxlYXZpbmcgdGhlIHJlc3QnKVxuICB9XG4gIGNvbnN0IGV4aXN0aW5nUmVjb3JkID0gbWF0Y2hpbmdbMF1cbiAgY29uc3Qgbm90ZSA9IG93bmVyc2hpcE5vdGUoZGVzaXJlZC5zdGFja05hbWUsIGRlc2lyZWQuZXhwb3J0TmFtZSlcblxuICBpZiAoZXhpc3RpbmdSZWNvcmQgJiYgZXhpc3RpbmdSZWNvcmQucmVjb3JkID09PSB2YWx1ZSAmJiBTdHJpbmcoZXhpc3RpbmdSZWNvcmQudHRsKSA9PT0gU3RyaW5nKHR0bFZhbHVlKSkge1xuICAgIGlmIChleGlzdGluZ1JlY29yZC5ub3RlID09PSBub3RlKSB7XG4gICAgICBjb25zb2xlLmxvZygnT0snLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEFkb3B0cyByZWNvcmRzIGNyZWF0ZWQgYmVmb3JlIG93bmVyc2hpcCBub3RlcyBleGlzdGVkLCBhbmQgcmVwYWlycyBhIG5vdGUgdGhhdCBkcmlmdGVkLlxuICAgICAgY29uc29sZS5sb2coJ0FET1BUJywgbmFtZSwgdHlwZSwgdHRsVmFsdWUsIHZhbHVlLCAnWk9ORScsIHpvbmVOYW1lLCAnSE9TVCcsIGhvc3ROYW1lKVxuICAgICAgYXdhaXQgc2V0UmVjb3JkTm90ZShjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWUsIGV4aXN0aW5nUmVjb3JkLmlkLCBub3RlLCBkcnlSdW4pXG4gICAgfVxuICAgIHJldHVyblxuICB9XG5cbiAgaWYgKGV4aXN0aW5nUmVjb3JkKSB7XG4gICAgY29uc29sZS5sb2coJ1VQREFURScsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgICBpZiAoIWRyeVJ1bikge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnUE9TVCcsICcvZG5zL21vZC1yZWNvcmQuanNvbicsIHtcbiAgICAgICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgICAgICdyZWNvcmQtaWQnOiBleGlzdGluZ1JlY29yZC5pZCxcbiAgICAgICAgaG9zdDogaG9zdE5hbWUsXG4gICAgICAgICdyZWNvcmQtdHlwZSc6IHR5cGUsXG4gICAgICAgIHJlY29yZDogdmFsdWUsXG4gICAgICAgIHR0bDogdHRsVmFsdWUsXG4gICAgICB9KVxuICAgICAgYXNzZXJ0U3VjY2VzcyhyZXN1bHQsICdNb2RpZnkgcmVjb3JkJylcbiAgICAgIGF3YWl0IHNldFJlY29yZE5vdGUoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHpvbmVOYW1lLCBleGlzdGluZ1JlY29yZC5pZCwgbm90ZSwgZHJ5UnVuKVxuICAgICAgYXdhaXQgdmVyaWZ5UmVjb3JkKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCBkZXNpcmVkLCB0dGxWYWx1ZSlcbiAgICB9XG4gICAgcmV0dXJuXG4gIH1cblxuICBjb25zb2xlLmxvZygnQ1JFQVRFJywgbmFtZSwgdHlwZSwgdHRsVmFsdWUsIHZhbHVlLCAnWk9ORScsIHpvbmVOYW1lLCAnSE9TVCcsIGhvc3ROYW1lKVxuICBpZiAoZHJ5UnVuKSByZXR1cm5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnUE9TVCcsICcvZG5zL2FkZC1yZWNvcmQuanNvbicsIHtcbiAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICBob3N0OiBob3N0TmFtZSxcbiAgICAncmVjb3JkLXR5cGUnOiB0eXBlLFxuICAgIHJlY29yZDogdmFsdWUsXG4gICAgdHRsOiB0dGxWYWx1ZSxcbiAgfSlcbiAgYXNzZXJ0U3VjY2VzcyhyZXN1bHQsICdBZGQgcmVjb3JkJylcbiAgY29uc3QgY3JlYXRlZElkID0gcmVzdWx0Py5kYXRhPy5pZFxuICBpZiAoY3JlYXRlZElkKSBhd2FpdCBzZXRSZWNvcmROb3RlKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCB6b25lTmFtZSwgU3RyaW5nKGNyZWF0ZWRJZCksIG5vdGUsIGRyeVJ1bilcbiAgYXdhaXQgdmVyaWZ5UmVjb3JkKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCBkZXNpcmVkLCB0dGxWYWx1ZSlcbn1cblxuLyoqXG4gKiBSZWFkcyB0aGUgcmVjb3JkIGJhY2sgYW5kIGNvbXBsYWlucyBpZiBpdCBpcyBub3Qgd2hhdCB3YXMganVzdCB3cml0dGVuLlxuICpcbiAqIFdpdGhvdXQgdGhpcyB0aGUgbG9nIHJlcG9ydHMgaW50ZW50IHJhdGhlciB0aGFuIG91dGNvbWUsIHdoaWNoIGlzIGhvdyBhIGN1dG92ZXIgdGhhdCBuZXZlclxuICogaGFwcGVuZWQgY2FuIGxvb2sgbGlrZSBhIGNsZWFuIHJ1bi4gTm90ZSB0aGlzIGNvbmZpcm1zIHRoZSBzdG9yZWQgcmVjb3JkIG9ubHkg4oCUIENsb3VETlMgcmVzb2x2ZXNcbiAqIEFMSUFTIHRhcmdldHMgb24gaXRzIG93biBzY2hlZHVsZSwgc28gd2hhdCB0aGUgem9uZSAqc2VydmVzKiBjYW4gbGFnIHRoZSByZWNvcmQgYnkgYSBsb25nIHdheS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gdmVyaWZ5UmVjb3JkKGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLCBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZywgZGVzaXJlZDogRGVzaXJlZFJlY29yZCwgdHRsVmFsdWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByZWNvcmRzID0gYXdhaXQgbGlzdFpvbmVSZWNvcmRzKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCBkZXNpcmVkLnpvbmVOYW1lLCB0cnVlKVxuICBjb25zdCBzdG9yZWQgPSByZWNvcmRzLmZpbmQoKHJlY29yZCkgPT4gcmVjb3JkLmhvc3QgPT09IGRlc2lyZWQuaG9zdE5hbWUgJiYgcmVjb3JkLnR5cGUgPT09IGRlc2lyZWQudHlwZSlcbiAgaWYgKCFzdG9yZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFZlcmlmaWNhdGlvbiBmYWlsZWQ6ICR7ZGVzaXJlZC5ob3N0TmFtZX0uJHtkZXNpcmVkLnpvbmVOYW1lfSAke2Rlc2lyZWQudHlwZX0gaXMgbWlzc2luZyBhZnRlciB3cml0ZWApXG4gIH1cbiAgaWYgKHN0b3JlZC5yZWNvcmQgIT09IGRlc2lyZWQudmFsdWUgfHwgU3RyaW5nKHN0b3JlZC50dGwpICE9PSBTdHJpbmcodHRsVmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFZlcmlmaWNhdGlvbiBmYWlsZWQ6ICR7ZGVzaXJlZC5ob3N0TmFtZX0uJHtkZXNpcmVkLnpvbmVOYW1lfSAke2Rlc2lyZWQudHlwZX0gaXMgJHtzdG9yZWQucmVjb3JkfSAodHRsICR7c3RvcmVkLnR0bH0pLCBleHBlY3RlZCAke2Rlc2lyZWQudmFsdWV9ICh0dGwgJHt0dGxWYWx1ZX0pYFxuICAgIClcbiAgfVxufVxuXG4vKipcbiAqIERlbGV0ZXMgbWFuYWdlZCByZWNvcmRzIHdob3NlIGV4cG9ydCBubyBsb25nZXIgZXhpc3RzLlxuICpcbiAqIE9ubHkgcmVjb3JkcyBjYXJyeWluZyB0aGlzIHRvb2wncyBub3RlIGFyZSBjb25zaWRlcmVkLCBhbmQgd2hlbiAtLXN0YWNrIHdhcyBnaXZlbiBvbmx5IHRob3NlXG4gKiB3aG9zZSBub3RlIG5hbWVzIG9uZSBvZiB0aG9zZSBzdGFja3Mg4oCUIG90aGVyd2lzZSBzeW5jaW5nIG9uZSBzdGFjayB3b3VsZCBkZWxldGUgdGhlIHJlY29yZHMgb2ZcbiAqIGFub3RoZXIuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHBydW5lT3JwaGFucyhcbiAgY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsXG4gIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLFxuICB6b25lTmFtZXM6IHN0cmluZ1tdLFxuICBkZXNpcmVkOiBEZXNpcmVkUmVjb3JkW10sXG4gIHN0YWNrU2NvcGU6IFNldDxzdHJpbmc+IHwgdW5kZWZpbmVkLFxuICBvcHRpb25zOiBPcHRpb25zXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZGVzaXJlZEtleXMgPSBuZXcgU2V0KGRlc2lyZWQubWFwKChyZWNvcmQpID0+IGAke3JlY29yZC56b25lTmFtZX18JHtyZWNvcmQuaG9zdE5hbWV9fCR7cmVjb3JkLnR5cGV9YCkpXG4gIGNvbnN0IG9ycGhhbnM6IHsgem9uZU5hbWU6IHN0cmluZzsgcmVjb3JkOiBDbG91ZG5zUmVjb3JkIH1bXSA9IFtdXG5cbiAgZm9yIChjb25zdCB6b25lTmFtZSBvZiB6b25lTmFtZXMpIHtcbiAgICBmb3IgKGNvbnN0IHJlY29yZCBvZiBhd2FpdCBsaXN0Wm9uZVJlY29yZHMoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHpvbmVOYW1lLCB0cnVlKSkge1xuICAgICAgY29uc3Qgc3RhY2sgPSBub3RlU3RhY2tOYW1lKHJlY29yZClcbiAgICAgIGlmIChzdGFjayA9PT0gdW5kZWZpbmVkKSBjb250aW51ZSAvLyBub3Qgb3Vyc1xuICAgICAgaWYgKHN0YWNrU2NvcGUgJiYgIXN0YWNrU2NvcGUuaGFzKHN0YWNrKSkgY29udGludWUgLy8gYW5vdGhlciBzdGFjaydzXG4gICAgICBpZiAoZGVzaXJlZEtleXMuaGFzKGAke3pvbmVOYW1lfXwke3JlY29yZC5ob3N0fXwke3JlY29yZC50eXBlfWApKSBjb250aW51ZSAvLyBzdGlsbCB3YW50ZWRcbiAgICAgIG9ycGhhbnMucHVzaCh7IHpvbmVOYW1lLCByZWNvcmQgfSlcbiAgICB9XG4gIH1cblxuICBpZiAoIW9ycGhhbnMubGVuZ3RoKSB7XG4gICAgY29uc29sZS5sb2coJ1BSVU5FIG5vbmUnKVxuICAgIHJldHVyblxuICB9XG5cbiAgZm9yIChjb25zdCB7IHpvbmVOYW1lLCByZWNvcmQgfSBvZiBvcnBoYW5zKSB7XG4gICAgY29uc3QgbmFtZSA9IHJlY29yZC5ob3N0ID8gYCR7cmVjb3JkLmhvc3R9LiR7em9uZU5hbWV9YCA6IHpvbmVOYW1lXG4gICAgY29uc29sZS5sb2cob3B0aW9ucy5kcnlSdW4gPyAnV09VTEQgUFJVTkUnIDogJ1BSVU5FJywgbmFtZSwgcmVjb3JkLnR5cGUsIHJlY29yZC5yZWNvcmQsICdaT05FJywgem9uZU5hbWUpXG4gIH1cblxuICBjb25zdCBvdmVyQ2FwID0gb3JwaGFucy5sZW5ndGggPiBvcHRpb25zLm1heFBydW5lXG4gIGlmIChvcHRpb25zLmRyeVJ1bikge1xuICAgIGlmIChvdmVyQ2FwKSBjb25zb2xlLndhcm4oJ1dBUk4nLCBgQSByZWFsIHJ1biB3b3VsZCByZWZ1c2U6ICR7b3JwaGFucy5sZW5ndGh9IHJlY29yZHMgZXhjZWVkcyAtLW1heC1wcnVuZSAke29wdGlvbnMubWF4UHJ1bmV9YClcbiAgICByZXR1cm5cbiAgfVxuICBpZiAob3ZlckNhcCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgUmVmdXNpbmcgdG8gZGVsZXRlICR7b3JwaGFucy5sZW5ndGh9IHJlY29yZHMgaW4gb25lIHJ1biAobGltaXQgJHtvcHRpb25zLm1heFBydW5lfSk7IHJhaXNlIC0tbWF4LXBydW5lIGlmIHRoaXMgaXMgaW50ZW5kZWRgKVxuICB9XG5cbiAgZm9yIChjb25zdCB7IHpvbmVOYW1lLCByZWNvcmQgfSBvZiBvcnBoYW5zKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnUE9TVCcsICcvZG5zL2RlbGV0ZS1yZWNvcmQuanNvbicsIHtcbiAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICAgJ3JlY29yZC1pZCc6IHJlY29yZC5pZCxcbiAgICB9KVxuICAgIGFzc2VydFN1Y2Nlc3MocmVzdWx0LCAnRGVsZXRlIHJlY29yZCcpXG4gIH1cbn1cblxuLyoqXG4gKiBUdXJucyBhbiBleHBvcnQgbmFtZSBpbnRvIHRoZSByZWNvcmQgaXQgZGVzY3JpYmVzOiBDbG91RE5TOjx0eXBlPjo8aG9zdCBsYWJlbHMuLi4+LlxuICpcbiAqIERLSU0gaXMgdGhlIG9uZSBmb3JtIHRoYXQgaXMgbm90IGEgcmVjb3JkIHR5cGUuIEFuIGV4cG9ydCBuYW1lIG1heSBvbmx5IGhvbGQgbGV0dGVycywgZGlnaXRzLFxuICogY29sb25zIGFuZCBoeXBoZW5zLCBhbmQgYSBES0lNIHJlY29yZCBsaXZlcyB1bmRlciBgX2RvbWFpbmtleWAsIHdoaWNoIG5vIGV4cG9ydCBuYW1lIGNhbiBzcGVsbC5cbiAqIFNvIENsb3VETlM6REtJTTo8c2VsZWN0b3I+OmV4YW1wbGU6b3JnIHN0YW5kcyBmb3IgdGhlIENOQU1FIDxzZWxlY3Rvcj4uX2RvbWFpbmtleS5leGFtcGxlLm9yZyAtXG4gKiB0aGUgc2hhcGUgU0VTIEVhc3kgREtJTSBhc2tzIGZvciwgdGhyZWUgb2YgdGhlbSBwZXIgZG9tYWluLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VFeHBvcnROYW1lKGV4cG9ydE5hbWU6IHN0cmluZyk6IHsgcmVzb3VyY2VUeXBlOiBzdHJpbmc7IHJlc291cmNlTmFtZTogc3RyaW5nIH0ge1xuICBjb25zdCBuYW1lUGFydHMgPSBleHBvcnROYW1lLnNwbGl0KCc6JylcbiAgaWYgKG5hbWVQYXJ0c1sxXSA9PT0gJ0RLSU0nKSB7XG4gICAgY29uc3QgW3NlbGVjdG9yLCAuLi5kb21haW5QYXJ0c10gPSBuYW1lUGFydHMuc2xpY2UoMilcbiAgICBpZiAoIXNlbGVjdG9yIHx8IGRvbWFpblBhcnRzLmxlbmd0aCA8IDIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgRXhwb3J0ICR7ZXhwb3J0TmFtZX0gbXVzdCBiZSBDbG91RE5TOkRLSU06PHNlbGVjdG9yPjo8ZG9tYWluIGxhYmVscz5gKVxuICAgIH1cbiAgICByZXR1cm4geyByZXNvdXJjZVR5cGU6ICdDTkFNRScsIHJlc291cmNlTmFtZTogYCR7c2VsZWN0b3J9Ll9kb21haW5rZXkuJHtkb21haW5QYXJ0cy5qb2luKCcuJyl9YCB9XG4gIH1cbiAgcmV0dXJuIHsgcmVzb3VyY2VUeXBlOiBuYW1lUGFydHNbMV0sIHJlc291cmNlTmFtZTogbmFtZVBhcnRzLnNsaWNlKDIpLmpvaW4oJy4nKSB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICAvLyBQYXJzZWQgYmVmb3JlIHRoZSBiYW5uZXIgc28gLS12ZXJzaW9uIGFuZCAtLWhlbHAgcHJpbnQgb25seSB3aGF0IGEgY2FsbGVyIGFza2VkIGZvci5cbiAgY29uc3Qgb3B0aW9ucyA9IHBhcnNlQXJncyhwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpXG4gIGNvbnNvbGUubG9nKCdDbG91RE5TIENsb3VkRm9ybWF0aW9uIFN5bmMgYnkgS2VubmV0aCBGYWxjayA8a2VubnVAY2xvdWRlbi5uZXQ+IChDKSBDbG91ZGVuIE95IDIwMjAtMjAyNicpXG5cbiAgaWYgKCFvcHRpb25zLnVzZXJuYW1lIHx8ICFvcHRpb25zLnBhc3N3b3JkUGFyYW1ldGVyKSB7XG4gICAgY29uc29sZS5lcnJvcihVU0FHRSlcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuICBpZiAob3B0aW9ucy5mb3JjZVBydW5lICYmICFvcHRpb25zLnpvbmVOYW1lcy5sZW5ndGgpIHtcbiAgICBjb25zb2xlLmVycm9yKCctLWZvcmNlLXBydW5lIG5lZWRzIGF0IGxlYXN0IG9uZSAtLXpvbmU6IHdpdGggbm8gZXhwb3J0cyB0aGVyZSBpcyBub3RoaW5nIHRvIGluZmVyIGEgem9uZSBmcm9tJylcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIGNvbnN0IHNzbSA9IG5ldyBTU01DbGllbnQoe30pXG4gIGNvbnN0IHpvbmVDYWNoZSA9IHt9XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBzc20uc2VuZChcbiAgICBuZXcgR2V0UGFyYW1ldGVyQ29tbWFuZCh7XG4gICAgICBOYW1lOiBvcHRpb25zLnBhc3N3b3JkUGFyYW1ldGVyLFxuICAgICAgV2l0aERlY3J5cHRpb246IHRydWUsXG4gICAgfSlcbiAgKVxuICBjb25zdCBjbG91ZG5zUGFzc3dvcmQgPSByZXNwb25zZS5QYXJhbWV0ZXI/LlZhbHVlIHx8ICcnXG5cbiAgLy8gQ29sbGVjdCBldmVyeXRoaW5nIHRoZSBleHBvcnRzIGFzayBmb3IgYmVmb3JlIHdyaXRpbmcgYW55dGhpbmcsIHNvIHBydW5pbmcgY2FuIGNvbXBhcmUgYWdhaW5zdFxuICAvLyB0aGUgY29tcGxldGUgcGljdHVyZSByYXRoZXIgdGhhbiBhZ2FpbnN0IHdoYXRldmVyIGhhcyBiZWVuIHByb2Nlc3NlZCBzbyBmYXIuXG4gIGNvbnN0IGRlc2lyZWQ6IERlc2lyZWRSZWNvcmRbXSA9IFtdXG4gIC8qKiBFdmVyeSBzcGVsbGluZyBvZiBhIHN0YWNrIHRoYXQgbWF0Y2hlZCwgc28gLS1zdGFjayBjYW4gYmUgZ2l2ZW4gYXMgYSBuYW1lIG9yIGEgZnVsbCBBUk4uICovXG4gIGNvbnN0IG1hdGNoZWRTdGFja3MgPSBuZXcgU2V0PHN0cmluZz4oKVxuICAvKiogU2hvcnQgbmFtZXMgb25seSwgd2hpY2ggaXMgdGhlIGZvcm0gb3duZXJzaGlwIG5vdGVzIGNhcnJ5LCBzbyBwcnVuaW5nIGNhbiBiZSBzY29wZWQgYnkgdGhlbS4gKi9cbiAgY29uc3QgbWF0Y2hlZFN0YWNrTmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKVxuICBjb25zdCBjbG91ZEZvcm1hdGlvbiA9IG5ldyBDbG91ZEZvcm1hdGlvbkNsaWVudCh7fSlcbiAgbGV0IG5leHRUb2tlblxuICBkbyB7XG4gICAgY29uc3QgcmVzcG9uc2U6IExpc3RFeHBvcnRzT3V0cHV0ID0gYXdhaXQgY2xvdWRGb3JtYXRpb24uc2VuZChuZXcgTGlzdEV4cG9ydHNDb21tYW5kKHsgTmV4dFRva2VuOiBuZXh0VG9rZW4gfSkpXG4gICAgZm9yIChjb25zdCBleHBvcnRPYmogb2YgcmVzcG9uc2UuRXhwb3J0cyB8fCBbXSkge1xuICAgICAgY29uc3Qgc3RhY2tNYXRjaCA9IGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkPy5tYXRjaCgvXmFybjpbXjpdKzpjbG91ZGZvcm1hdGlvbjpbXjpdKzpbXjpdKzpzdGFja1xcLyhbXi9dKylcXC8vKVxuICAgICAgY29uc3Qgc3RhY2tOYW1lID0gc3RhY2tNYXRjaCA/IHN0YWNrTWF0Y2hbMV0gOiBleHBvcnRPYmouRXhwb3J0aW5nU3RhY2tJZCB8fCAnJ1xuICAgICAgaWYgKG9wdGlvbnMuc3RhY2tOYW1lcy5sZW5ndGggJiYgIW9wdGlvbnMuc3RhY2tOYW1lcy5pbmNsdWRlcyhleHBvcnRPYmouRXhwb3J0aW5nU3RhY2tJZCB8fCAnJykgJiYgIW9wdGlvbnMuc3RhY2tOYW1lcy5pbmNsdWRlcyhzdGFja05hbWUpKSB7XG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG4gICAgICBpZiAoIWV4cG9ydE9iai5OYW1lPy5tYXRjaCgvXkNsb3VETlM6LykpIGNvbnRpbnVlXG5cbiAgICAgIGNvbnN0IHsgcmVzb3VyY2VUeXBlLCByZXNvdXJjZU5hbWUgfSA9IHBhcnNlRXhwb3J0TmFtZShleHBvcnRPYmouTmFtZSlcbiAgICAgIGNvbnN0IHsgem9uZU5hbWUsIGhvc3ROYW1lIH0gPSBhd2FpdCBhdXRvRGV0ZWN0Q2xvdWRuc0hvc3RBbmRab25lKG9wdGlvbnMudXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgcmVzb3VyY2VOYW1lLCB6b25lQ2FjaGUpXG4gICAgICBtYXRjaGVkU3RhY2tzLmFkZChzdGFja05hbWUpXG4gICAgICBtYXRjaGVkU3RhY2tOYW1lcy5hZGQoc3RhY2tOYW1lKVxuICAgICAgaWYgKGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkKSBtYXRjaGVkU3RhY2tzLmFkZChleHBvcnRPYmouRXhwb3J0aW5nU3RhY2tJZClcbiAgICAgIGRlc2lyZWQucHVzaCh7XG4gICAgICAgIHpvbmVOYW1lLFxuICAgICAgICBob3N0TmFtZSxcbiAgICAgICAgdHlwZTogcmVzb3VyY2VUeXBlLFxuICAgICAgICB2YWx1ZTogZXhwb3J0T2JqLlZhbHVlISxcbiAgICAgICAgc3RhY2tOYW1lLFxuICAgICAgICBleHBvcnROYW1lOiBleHBvcnRPYmouTmFtZSxcbiAgICAgIH0pXG4gICAgfVxuICAgIG5leHRUb2tlbiA9IHJlc3BvbnNlLk5leHRUb2tlblxuICB9IHdoaWxlIChuZXh0VG9rZW4pXG5cbiAgLyoqXG4gICAqIEEgLS1zdGFjayB0aGF0IG1hdGNoZWQgbm90aGluZyBpcyBuZWFybHkgYWx3YXlzIGEgdHlwbyBvciBhIHN0YWNrIHRoYXQgaGFzIG5vdCBkZXBsb3llZCB5ZXQuXG4gICAqIEl0IHVzZWQgdG8gcGFzcyBzaWxlbnRseSBhcyBhIG5vLW9wOyB3aXRoIC0tcHJ1bmUgdGhlIHNhbWUgY29uZGl0aW9uIHdvdWxkIGxvb2sgbGlrZSBcImV2ZXJ5XG4gICAqIHJlY29yZCBpcyBhbiBvcnBoYW5cIiwgc28gaXQgaXMgZmF0YWwgdGhlcmUgYW5kIGEgd2FybmluZyBvdGhlcndpc2UuXG4gICAqXG4gICAqIC0tZm9yY2UtcHJ1bmUgaXMgdGhlIGV4Y2VwdGlvbjogYSB0b3JuLWRvd24gc3RhY2sgcHJvZHVjaW5nIG5vIGV4cG9ydHMgaXMgcHJlY2lzZWx5IHRoZSBjYXNlIGl0XG4gICAqIGV4aXN0cyBmb3IsIGFuZCB0aGUgY2FsbGVyIGhhcyBhbHJlYWR5IGhhZCB0byBuYW1lIHRoZSB6b25lIGV4cGxpY2l0bHkgdG8gZ2V0IHRoaXMgZmFyLlxuICAgKi9cbiAgZm9yIChjb25zdCBzdGFja05hbWUgb2Ygb3B0aW9ucy5zdGFja05hbWVzKSB7XG4gICAgaWYgKCFtYXRjaGVkU3RhY2tzLmhhcyhzdGFja05hbWUpKSB7XG4gICAgICBjb25zdCBtZXNzYWdlID0gYFN0YWNrICR7c3RhY2tOYW1lfSBwcm9kdWNlZCBubyBDbG91RE5TIGV4cG9ydHNgXG4gICAgICBpZiAob3B0aW9ucy5wcnVuZSAmJiAhb3B0aW9ucy5mb3JjZVBydW5lKSB0aHJvdyBuZXcgRXJyb3IoYCR7bWVzc2FnZX07IHJlZnVzaW5nIHRvIHBydW5lIG9uIGFuIHVudmVyaWZpZWQgc3RhY2sgbmFtZWApXG4gICAgICBjb25zb2xlLndhcm4oJ1dBUk4nLCBtZXNzYWdlKVxuICAgIH1cbiAgfVxuXG4gIGZvciAoY29uc3QgcmVjb3JkIG9mIGRlc2lyZWQpIHtcbiAgICBhd2FpdCBjcmVhdGVPclVwZGF0ZUNsb3VkbnNSZXNvdXJjZShvcHRpb25zLnVzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHJlY29yZCwgb3B0aW9ucy50dGwsIG9wdGlvbnMuZHJ5UnVuKVxuICB9XG5cbiAgaWYgKCFvcHRpb25zLnBydW5lKSByZXR1cm5cblxuICBpZiAoIWRlc2lyZWQubGVuZ3RoICYmICFvcHRpb25zLmZvcmNlUHJ1bmUpIHtcbiAgICBjb25zb2xlLndhcm4oJ1dBUk4gTm8gZXhwb3J0cyBtYXRjaGVkLCBzbyBub3RoaW5nIGlzIGtub3duIHRvIGJlIHdhbnRlZDsgc2tpcHBpbmcgcHJ1bmUuIFVzZSAtLWZvcmNlLXBydW5lIHdpdGggLS16b25lIGlmIHRoaXMgaXMgYSB0ZWFyZG93bi4nKVxuICAgIHJldHVyblxuICB9XG5cbiAgY29uc3Qgem9uZU5hbWVzID0gWy4uLm5ldyBTZXQoWy4uLm9wdGlvbnMuem9uZU5hbWVzLCAuLi5kZXNpcmVkLm1hcCgocmVjb3JkKSA9PiByZWNvcmQuem9uZU5hbWUpXSldXG4gIC8qKlxuICAgKiBOb3RlcyByZWNvcmQgdGhlIHNob3J0IHN0YWNrIG5hbWUsIHNvIHNjb3Bpbmcgb24gdGhlIHJhdyAtLXN0YWNrIHZhbHVlcyB3b3VsZCBzaWxlbnRseSBwcnVuZVxuICAgKiBub3RoaW5nIHdoZW4gb25lIHdhcyBnaXZlbiBhcyBhbiBBUk4uIEJvdGggc3BlbGxpbmdzIGdvIGluOiB0aGUgcmVzb2x2ZWQgbmFtZXMgY292ZXIgdGhlIEFSTlxuICAgKiBjYXNlLCBhbmQgdGhlIHJhdyB2YWx1ZXMgY292ZXIgLS1mb3JjZS1wcnVuZSwgd2hlcmUgYSB0b3JuLWRvd24gc3RhY2sgcmVzb2x2ZXMgdG8gbm90aGluZy5cbiAgICovXG4gIGNvbnN0IHN0YWNrU2NvcGUgPSBvcHRpb25zLnN0YWNrTmFtZXMubGVuZ3RoID8gbmV3IFNldChbLi4ubWF0Y2hlZFN0YWNrTmFtZXMsIC4uLm9wdGlvbnMuc3RhY2tOYW1lc10pIDogdW5kZWZpbmVkXG4gIGF3YWl0IHBydW5lT3JwaGFucyhvcHRpb25zLnVzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHpvbmVOYW1lcywgZGVzaXJlZCwgc3RhY2tTY29wZSwgb3B0aW9ucylcbn1cbiJdfQ==