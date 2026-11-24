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
exports.parseExportValue = parseExportValue;
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
    if (existingRecord && existingRecord.record === value && String(existingRecord.ttl) === String(ttlValue) && samePriority(existingRecord, desired)) {
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
                ...(desired.priority !== undefined ? { priority: desired.priority } : {}),
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
        ...(desired.priority !== undefined ? { priority: desired.priority } : {}),
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
    var _a, _b;
    const records = await listZoneRecords(cloudnsUsername, cloudnsPassword, desired.zoneName, true);
    const stored = records.find((record) => record.host === desired.hostName && record.type === desired.type);
    if (!stored) {
        throw new Error(`Verification failed: ${desired.hostName}.${desired.zoneName} ${desired.type} is missing after write`);
    }
    if (stored.record !== desired.value || String(stored.ttl) !== String(ttlValue) || !samePriority(stored, desired)) {
        throw new Error(`Verification failed: ${desired.hostName}.${desired.zoneName} ${desired.type} is ${stored.record} (ttl ${stored.ttl}, priority ${(_a = stored.priority) !== null && _a !== void 0 ? _a : '-'}), expected ${desired.value} (ttl ${ttlValue}, priority ${(_b = desired.priority) !== null && _b !== void 0 ? _b : '-'})`);
    }
}
/** Whether a stored record has the preference the export asks for; only MX exports ask for one. */
function samePriority(stored, desired) {
    return desired.priority === undefined || String(stored.priority) === desired.priority;
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
 *
 * DMARC is the same kind of form for `_dmarc`: ClouDNS:DMARC:example:org stands for the TXT record
 * _dmarc.example.org, whose text is the export value, such as `v=DMARC1; p=none`.
 */
function parseExportName(exportName) {
    const nameParts = exportName.split(':');
    if (nameParts[1] === 'DMARC') {
        const domainParts = nameParts.slice(2);
        if (domainParts.length < 2 || domainParts.some((part) => !part)) {
            throw new Error(`Export ${exportName} must be ClouDNS:DMARC:<domain labels>`);
        }
        return { resourceType: 'TXT', resourceName: `_dmarc.${domainParts.join('.')}` };
    }
    if (nameParts[1] === 'DKIM') {
        const [selector, ...domainParts] = nameParts.slice(2);
        if (!selector || domainParts.length < 2) {
            throw new Error(`Export ${exportName} must be ClouDNS:DKIM:<selector>:<domain labels>`);
        }
        return { resourceType: 'CNAME', resourceName: `${selector}._domainkey.${domainParts.join('.')}` };
    }
    return { resourceType: nameParts[1], resourceName: nameParts.slice(2).join('.') };
}
/**
 * Splits an export value into the record and, for MX, its preference: an MX export's value is
 * `<priority> <mail server>`, such as `1 mail.example.org`, as the record is written in a zone file.
 * Every other type's value is the record as-is.
 */
function parseExportValue(exportName, resourceType, value) {
    if (resourceType !== 'MX')
        return { value };
    const match = value.trim().match(/^(\d+)\s+(\S+)$/);
    if (!match)
        throw new Error(`Export ${exportName} must have the value "<priority> <mail server>", such as "1 mail.example.org"`);
    return { value: match[2], priority: String(Number(match[1])) };
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
            const { value, priority } = parseExportValue(exportObj.Name, resourceType, exportObj.Value);
            const { zoneName, hostName } = await autoDetectCloudnsHostAndZone(options.username, cloudnsPassword, resourceName, zoneCache);
            matchedStacks.add(stackName);
            matchedStackNames.add(stackName);
            if (exportObj.ExportingStackId)
                matchedStacks.add(exportObj.ExportingStackId);
            desired.push({
                zoneName,
                hostName,
                type: resourceType,
                value,
                ...(priority !== undefined ? { priority } : {}),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXVDRztBQUNILG9EQUFvRTtBQUNwRSwwRUFBNEc7QUFDNUcsTUFBWSxXQUFXLHdDQUFtQjtBQUUxQyxxQkFBcUI7QUFDckIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsR0FBRyxHQUFHLENBQUE7QUFFckMscUZBQXFGO0FBQ3JGLE1BQU0sV0FBVyxHQUFHLHdDQUF3QyxDQUFBO0FBRTVELDBHQUEwRztBQUMxRyxNQUFNLGlCQUFpQixHQUFHLEVBQUUsQ0FBQTtBQXFDNUIsTUFBTSxLQUFLLEdBQUc7Ozs7Ozs7Ozs7OzsyRUFZNkQsaUJBQWlCOzs7Ozs4RkFLRSxDQUFBO0FBRTlGLG1CQUEwQixJQUFjO0lBQ3RDLE1BQU0sT0FBTyxHQUFZO1FBQ3ZCLFFBQVEsRUFBRSxFQUFFO1FBQ1osaUJBQWlCLEVBQUUsRUFBRTtRQUNyQixHQUFHLEVBQUUsS0FBSztRQUNWLFVBQVUsRUFBRSxFQUFFO1FBQ2QsU0FBUyxFQUFFLEVBQUU7UUFDYixLQUFLLEVBQUUsS0FBSztRQUNaLFVBQVUsRUFBRSxLQUFLO1FBQ2pCLFFBQVEsRUFBRSxpQkFBaUI7UUFDM0IsTUFBTSxFQUFFLEtBQUs7S0FDZCxDQUFBO0lBRUQ7Ozs7T0FJRztJQUNILElBQUksSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUM1QyxPQUFPLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQTtRQUMxQixPQUFPLENB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LENBQUM7UUFDM0MsT0FBTyxDQUFDLElBQUksQ0FBQyxpSUFBaUksQ0FBQyxDQUFBO1FBQy9JLE9BQU07SUFDUixDQUFDO0lBRUQsTUFBTSxTQUFTLEdBQUcsQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLENBQUMsR0FBRyxPQUFPLENBQUMsU0FBUyxFQUFFLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFBO0lBQ25HOzs7O09BSUc7SUFDSCxNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUMsVUFBVSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUFHLGlCQUFpQixFQUFFLEdBQUcsT0FBTyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQTtJQUNqSCxNQUFNLFlBQVksQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFFLGVBQWUsRUFBRSxTQUFTLEVBQUUsT0FBTyxFQUFFLFVBQVUsRUFBRSxPQUFPLENBQUMsQ0FBQTtBQUNoRyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZWFkIEFXUyBDbG91ZEZvcm1hdGlvbiBFeHBvcnRzIGFuZCBhdXRvZ2VuZXJhdGUgQ2xvdUROUyByZWNvcmRzIGJhc2VkIG9uIHRoZWlyIG5hbWVzIGFuZCB2YWx1ZXMuXG4gKiBLZW5uZXRoIEZhbGNrIDxrZW5udUBjbG91ZGVuLm5ldD4gKEMpIENsb3VkZW4gT3kgMjAyMC0yMDI2XG4gKlxuICogVGhpcyB0b29sIGNhbiBiZSB1c2VkIHRvIGF1dG9nZW5lcmF0ZSBDbG91RE5TIHJlY29yZHMgZm9yIENsb3VkRm9ybWF0aW9uIHJlc291cmNlcyBsaWtlXG4gKiBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbnMgYW5kIEFQSSBHYXRld2F5IGRvbWFpbnMuXG4gKlxuICogQ2xvdWRGb3JtYXRpb24gZXhwb3J0IG5hbWUgbXVzdCBzcGVjaWZ5IHRoZSByZXNvdXJjZSB0eXBlIGFuZCByZWNvcmQgaG9zdG5hbWUgYXMgZm9sbG93czpcbiAqIENsb3VETlM6Q05BTUU6bXlob3N0OmV4YW1wbGU6b3JnXG4gKlxuICogQ2xvdWRGb3JtYXRpb24gZXhwb3J0IHZhbHVlIG11c3Qgc3BlY2lmeSB0aGUgcmVjb3JkIHZhbHVlIGFzLWlzIChmb3IgaW5zdGFuY2UsIGEgZGlzdHJpYnV0aW9uIGRvbWFpbiBuYW1lKTpcbiAqIHh4eHh4eHh4eHh4eHh4LmNsb3VkZnJvbnQubmV0XG4gKlxuICogVGhlIGFib3ZlIGV4YW1wbGUgd2lsbCBnZW5lcmF0ZSB0aGUgZm9sbG93aW5nIHJlY29yZCBpbiB0aGUgQ2xvdUROUyB6b25lIGV4YW1wbGUub3JnOlxuICogbXlob3N0LmV4YW1wbGUub3JnIENOQU1FIHh4eHh4eHh4eHh4eHh4LmNsb3VkZnJvbnQubmV0XG4gKlxuICogT3RoZXIgcmVzb3VyY2UgdHlwZXMgYXJlIGFsc28gYWxsb3dlZCAoQSwgQUFBQSwgQUxJQVMsIGV0YykuXG4gKlxuICogIyMgT3duZXJzaGlwIGFuZCBwcnVuaW5nXG4gKlxuICogRXZlcnkgcmVjb3JkIHRoaXMgdG9vbCB3cml0ZXMgaXMgc3RhbXBlZCB3aXRoIGEgQ2xvdUROUyByZWNvcmQgbm90ZSBuYW1pbmcgdGhlIHRvb2wsIHRoZSBzdGFja1xuICogd2hvc2UgZXhwb3J0IHByb2R1Y2VkIGl0LCBhbmQgdGhhdCBleHBvcnQuIFRoZSBub3RlIGlzIHdoYXQgbWFrZXMgZGVsZXRpb24gc2FmZTogYSB6b25lIGhvbGRzXG4gKiBwbGVudHkgb2YgcmVjb3JkcyBub2JvZHkgaGVyZSBjcmVhdGVkLCBhbmQgd2l0aG91dCBhIG1hcmtlciB0aGVyZSBpcyBubyB3YXkgdG8gdGVsbCBhbiBvcnBoYW5cbiAqIGxlZnQgYmVoaW5kIGJ5IGEgZGVsZXRlZCBleHBvcnQgZnJvbSBzb21ldGhpbmcgYSBodW1hbiBhZGRlZCBieSBoYW5kLiBSZWNvcmRzIHdpdGhvdXQgdGhlIG1hcmtlclxuICogYXJlIG5ldmVyIGNhbmRpZGF0ZXMgZm9yIGRlbGV0aW9uLlxuICpcbiAqIFN0YW1waW5nIGhhcHBlbnMgb24gZXZlcnkgc3luYywgc28gcmVjb3JkcyBjcmVhdGVkIGJlZm9yZSB0aGlzIGZlYXR1cmUgYXJlIGFkb3B0ZWQgdGhlIG5leHQgdGltZVxuICogdGhleSBhcmUgc2Vlbi4gVGhhdCBpcyBzYWZlIGJlY2F1c2UgYSByZWNvcmQgaXMgb25seSBldmVyIHN0YW1wZWQgd2hlbiBhbiBleHBvcnQgY3VycmVudGx5IGNsYWltc1xuICogaXQg4oCUIHRoZSB0b29sIGlzIGFscmVhZHkgb3ZlcndyaXRpbmcgdGhhdCByZWNvcmQncyB2YWx1ZSwgc28gaXQgYWxyZWFkeSBvd25zIGl0LlxuICpcbiAqIFBydW5pbmcgaXMgb3B0LWluIGFuZCBuZXZlciBoYXBwZW5zIGJ5IGFjY2lkZW50OlxuICpcbiAqICAgLS1wcnVuZSAgICAgICAgZGVsZXRlIG1hbmFnZWQgcmVjb3JkcyB3aG9zZSBleHBvcnQgaXMgZ29uZSwgYnV0IG9ubHkgd2hlbiB0aGlzIHJ1biBhY3R1YWxseVxuICogICAgICAgICAgICAgICAgICBmb3VuZCBleHBvcnRzLiBBbiBlbXB0eSBleHBvcnQgc2V0IGlzIGZhciBtb3JlIGxpa2VseSBhIHdyb25nIC0tc3RhY2sgb3IgYW4gQVdTXG4gKiAgICAgICAgICAgICAgICAgIGVycm9yIHRoYW4gYSBnZW51aW5lIGluc3RydWN0aW9uIHRvIGRlbGV0ZSBldmVyeSByZWNvcmQuXG4gKiAgIC0tZm9yY2UtcHJ1bmUgIGFsc28gcHJ1bmUgd2hlbiB0aGUgZXhwb3J0IHNldCBpcyBlbXB0eSwgZm9yIHRoZSByZWFsIHRlYXJkb3duIGNhc2UuIFJlcXVpcmVzIGFuXG4gKiAgICAgICAgICAgICAgICAgIGV4cGxpY2l0IC0tem9uZSwgYmVjYXVzZSB3aXRoIG5vIGV4cG9ydHMgdGhlcmUgaXMgbm90aGluZyB0byBpbmZlciBhIHpvbmUgZnJvbS5cbiAqXG4gKiBBIGNhcCBvbiBob3cgbWFueSByZWNvcmRzIG9uZSBydW4gbWF5IGRlbGV0ZSBhcHBsaWVzIHRvIGJvdGguXG4gKi9cbmltcG9ydCB7IFNTTUNsaWVudCwgR2V0UGFyYW1ldGVyQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zc20nXG5pbXBvcnQgeyBDbG91ZEZvcm1hdGlvbkNsaWVudCwgTGlzdEV4cG9ydHNDb21tYW5kLCBMaXN0RXhwb3J0c091dHB1dCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1jbG91ZGZvcm1hdGlvbidcbmltcG9ydCAqIGFzIHF1ZXJ5c3RyaW5nIGZyb20gJ3F1ZXJ5c3RyaW5nJ1xuXG4vLyBMb2FkIH4vLmF3cy9jb25maWdcbnByb2Nlc3MuZW52LkFXU19TREtfTE9BRF9DT05GSUcgPSAnMSdcblxuLyoqIE1hcmtzIGEgcmVjb3JkIGFzIG91cnMuIFByZXNlbnQgaW4gdGhlIG5vdGUgb2YgZXZlcnkgcmVjb3JkIHRoaXMgdG9vbCBtYW5hZ2VzLiAqL1xuY29uc3QgTk9URV9NQVJLRVIgPSAnbWFuYWdlZC1ieT1jbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMnXG5cbi8qKiBNb3N0IHJlY29yZHMgb25lIHJ1biB3aWxsIGRlbGV0ZSBiZWZvcmUgcmVmdXNpbmcuIFJhaXNlIHdpdGggLS1tYXgtcHJ1bmUgd2hlbiBpdCBpcyBnZW51aW5lbHkgbW9yZS4gKi9cbmNvbnN0IERFRkFVTFRfTUFYX1BSVU5FID0gMTBcblxudHlwZSBDbG91ZG5zUmVzdENhbGxSZXNwb25zZSA9IGFueVxuXG5pbnRlcmZhY2UgT3B0aW9ucyB7XG4gIHVzZXJuYW1lOiBzdHJpbmdcbiAgcGFzc3dvcmRQYXJhbWV0ZXI6IHN0cmluZ1xuICB0dGw6IHN0cmluZ1xuICBzdGFja05hbWVzOiBzdHJpbmdbXVxuICB6b25lTmFtZXM6IHN0cmluZ1tdXG4gIHBydW5lOiBib29sZWFuXG4gIGZvcmNlUHJ1bmU6IGJvb2xlYW5cbiAgbWF4UHJ1bmU6IG51bWJlclxuICBkcnlSdW46IGJvb2xlYW5cbn1cblxuaW50ZXJmYWNlIERlc2lyZWRSZWNvcmQge1xuICB6b25lTmFtZTogc3RyaW5nXG4gIGhvc3ROYW1lOiBzdHJpbmdcbiAgdHlwZTogc3RyaW5nXG4gIHZhbHVlOiBzdHJpbmdcbiAgLyoqIE1YIG9ubHk6IHRoZSBwcmVmZXJlbmNlLCBmcm9tIHRoZSBleHBvcnQgdmFsdWUncyBmaXJzdCB3b3JkICovXG4gIHByaW9yaXR5Pzogc3RyaW5nXG4gIHN0YWNrTmFtZTogc3RyaW5nXG4gIGV4cG9ydE5hbWU6IHN0cmluZ1xufVxuXG5pbnRlcmZhY2UgQ2xvdWRuc1JlY29yZCB7XG4gIGlkOiBzdHJpbmdcbiAgaG9zdDogc3RyaW5nXG4gIHR5cGU6IHN0cmluZ1xuICB0dGw6IHN0cmluZ1xuICByZWNvcmQ6IHN0cmluZ1xuICBwcmlvcml0eT86IHN0cmluZyB8IG51bWJlclxuICBub3RlPzogc3RyaW5nXG59XG5cbmNvbnN0IFVTQUdFID0gYENsb3VETlMgQ2xvdWRGb3JtYXRpb24gU3luY1xuXG5Vc2FnZTogY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jIC11IDx1c2VybmFtZT4gLXAgPHBhc3N3b3JkLXBhcmFtZXRlcj4gW29wdGlvbnNdXG4gICAgICAgY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jIDx1c2VybmFtZT4gPHBhc3N3b3JkLXBhcmFtZXRlcj4gW3R0bCBbc3RhY2suLi5dXSAgIChsZWdhY3kpXG5cbiAgLXUsIC0tdXNlcm5hbWUgPG5hbWU+ICAgICAgICAgQ2xvdUROUyBBUEkgc3ViLWF1dGgtdXNlclxuICAtcCwgLS1wYXNzd29yZC1wYXJhbWV0ZXIgPHA+ICBTU00gcGFyYW1ldGVyIGhvbGRpbmcgdGhlIGVuY3J5cHRlZCBDbG91RE5TIEFQSSBwYXNzd29yZFxuICAtdCwgLS10dGwgPHNlY29uZHM+ICAgICAgICAgICBUVEwgZm9yIGdlbmVyYXRlZCByZWNvcmRzIChkZWZhdWx0IDMwMClcbiAgLXMsIC0tc3RhY2sgPG5hbWV8YXJuPiAgICAgICAgTGltaXQgdG8gdGhpcyBDbG91ZEZvcm1hdGlvbiBzdGFjazsgcmVwZWF0YWJsZVxuICAteiwgLS16b25lIDxuYW1lPiAgICAgICAgICAgICBBbHNvIHNjYW4gdGhpcyB6b25lIHdoZW4gcHJ1bmluZzsgcmVwZWF0YWJsZVxuICAgICAgLS1wcnVuZSAgICAgICAgICAgICAgICAgICBEZWxldGUgbWFuYWdlZCByZWNvcmRzIHdob3NlIGV4cG9ydCBpcyBnb25lXG4gICAgICAtLWZvcmNlLXBydW5lICAgICAgICAgICAgIEFsc28gcHJ1bmUgd2hlbiBubyBleHBvcnRzIHdlcmUgZm91bmQ7IHJlcXVpcmVzIC0tem9uZVxuICAgICAgLS1tYXgtcHJ1bmUgPG4+ICAgICAgICAgICBNb3N0IHJlY29yZHMgb25lIHJ1biBtYXkgZGVsZXRlIChkZWZhdWx0ICR7REVGQVVMVF9NQVhfUFJVTkV9KVxuICAtbiwgLS1kcnktcnVuICAgICAgICAgICAgICAgICBSZXBvcnQgd2hhdCB3b3VsZCBjaGFuZ2Ugd2l0aG91dCBjaGFuZ2luZyBpdFxuICAtaCwgLS1oZWxwICAgICAgICAgICAgICAgICAgICBTaG93IHRoaXMgaGVscFxuICAtViwgLS12ZXJzaW9uICAgICAgICAgICAgICAgICBTaG93IHRoZSB2ZXJzaW9uXG5cbkFXU19QUk9GSUxFIHNlbGVjdHMgdGhlIEFXUyBjcmVkZW50aWFscywgYXMgdXN1YWwuIERFQlVHPTEgcHJpbnRzIGZ1bGwgc3RhY2sgdHJhY2VzIG9uIGVycm9yLmBcblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhhcmd2OiBzdHJpbmdbXSk6IE9wdGlvbnMge1xuICBjb25zdCBvcHRpb25zOiBPcHRpb25zID0ge1xuICAgIHVzZXJuYW1lOiAnJyxcbiAgICBwYXNzd29yZFBhcmFtZXRlcjogJycsXG4gICAgdHRsOiAnMzAwJyxcbiAgICBzdGFja05hbWVzOiBbXSxcbiAgICB6b25lTmFtZXM6IFtdLFxuICAgIHBydW5lOiBmYWxzZSxcbiAgICBmb3JjZVBydW5lOiBmYWxzZSxcbiAgICBtYXhQcnVuZTogREVGQVVMVF9NQVhfUFJVTkUsXG4gICAgZHJ5UnVuOiBmYWxzZSxcbiAgfVxuXG4gIC8qKlxuICAgKiBBbnl0aGluZyBub3Qgc3RhcnRpbmcgd2l0aCBcIi1cIiBpbiB0aGUgZmlyc3QgcG9zaXRpb24gaXMgdGhlIG9sZCBwb3NpdGlvbmFsIGZvcm06XG4gICAqIDx1c2VybmFtZT4gPHBhc3N3b3JkLXBhcmFtZXRlcj4gW3R0bCBbc3RhY2suLi5dXS4gS2VwdCB3b3JraW5nIHNvIGV4aXN0aW5nIGRlcGxveSBzY3JpcHRzIGFuZFxuICAgKiBDSSBqb2JzIGRvIG5vdCBoYXZlIHRvIGNoYW5nZSBpbiB0aGUgc2FtZSByZWxlYXNlIHRoYXQgYWRkcyBwcnVuaW5nLlxuICAgKi9cbiAgaWYgKGFyZ3YubGVuZ3RoICYmICFhcmd2WzBdLnN0YXJ0c1dpdGgoJy0nKSkge1xuICAgIG9wdGlvbnMudXNlcm5hbWUgPSBhcmd2WzBdXG4gICAgb3B0aW9ucy5wYXNzd29yZFBhcmFtZXRlciA9IGFyZ3ZbMV0gfHwgJydcbiAgICAvKipcbiAgICAgKiBPcHRpb25zIGFyZSBzdGlsbCBob25vdXJlZCBhZnRlciB0aGUgcG9zaXRpb25hbCBhcmd1bWVudHMuIFRyZWF0aW5nIGEgdHJhaWxpbmcgXCItblwiIGFzIGFcbiAgICAgKiBzdGFjayBuYW1lIGluc3RlYWQgaXMgaG93IGEgcnVuIHRoZSBjYWxsZXIgYmVsaWV2ZWQgd2FzIGEgcmVoZWFyc2FsIHdyaXRlcyBmb3IgcmVhbCDigJQgd2hpY2hcbiAgICAgKiBpcyBleGFjdGx5IHdoYXQgaGFwcGVuZWQgdGhlIGZpcnN0IHRpbWUgdGhpcyB3YXMgdGVzdGVkLlxuICAgICAqL1xuICAgIGNvbnN0IHJlc3QgPSBhcmd2LnNsaWNlKDIpXG4gICAgY29uc3QgZmxhZ0luZGV4ID0gcmVzdC5maW5kSW5kZXgoKGFyZykgPT4gYXJnLnN0YXJ0c1dpdGgoJy0nKSlcbiAgICBjb25zdCBwb3NpdGlvbmFsID0gZmxhZ0luZGV4ID09PSAtMSA/IHJlc3QgOiByZXN0LnNsaWNlKDAsIGZsYWdJbmRleClcbiAgICBpZiAocG9zaXRpb25hbFswXSkgb3B0aW9ucy50dGwgPSBwb3NpdGlvbmFsWzBdXG4gICAgb3B0aW9ucy5zdGFja05hbWVzID0gcG9zaXRpb25hbC5zbGljZSgxKVxuICAgIGlmIChmbGFnSW5kZXggIT09IC0xKSBhcHBseUZsYWdzKHJlc3Quc2xpY2UoZmxhZ0luZGV4KSwgb3B0aW9ucylcbiAgICByZXR1cm4gb3B0aW9uc1xuICB9XG5cbiAgYXBwbHlGbGFncyhhcmd2LCBvcHRpb25zKVxuICByZXR1cm4gb3B0aW9uc1xufVxuXG5mdW5jdGlvbiBhcHBseUZsYWdzKGFyZ3Y6IHN0cmluZ1tdLCBvcHRpb25zOiBPcHRpb25zKTogdm9pZCB7XG4gIGNvbnN0IG5leHQgPSAoaW5kZXg6IG51bWJlciwgZmxhZzogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCB2YWx1ZSA9IGFyZ3ZbaW5kZXggKyAxXVxuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlLnN0YXJ0c1dpdGgoJy0nKSkgdGhyb3cgbmV3IEVycm9yKGBNaXNzaW5nIHZhbHVlIGZvciAke2ZsYWd9YClcbiAgICByZXR1cm4gdmFsdWVcbiAgfVxuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJndi5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGFyZyA9IGFyZ3ZbaV1cbiAgICBzd2l0Y2ggKGFyZykge1xuICAgICAgY2FzZSAnLXUnOlxuICAgICAgY2FzZSAnLS11c2VybmFtZSc6XG4gICAgICAgIG9wdGlvbnMudXNlcm5hbWUgPSBuZXh0KGksIGFyZylcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctcCc6XG4gICAgICBjYXNlICctLXBhc3N3b3JkLXBhcmFtZXRlcic6XG4gICAgICAgIG9wdGlvbnMucGFzc3dvcmRQYXJhbWV0ZXIgPSBuZXh0KGksIGFyZylcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctdCc6XG4gICAgICBjYXNlICctLXR0bCc6XG4gICAgICAgIG9wdGlvbnMudHRsID0gbmV4dChpLCBhcmcpXG4gICAgICAgIGkrK1xuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLXMnOlxuICAgICAgY2FzZSAnLS1zdGFjayc6XG4gICAgICAgIG9wdGlvbnMuc3RhY2tOYW1lcy5wdXNoKG5leHQoaSwgYXJnKSlcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICcteic6XG4gICAgICBjYXNlICctLXpvbmUnOlxuICAgICAgICBvcHRpb25zLnpvbmVOYW1lcy5wdXNoKG5leHQoaSwgYXJnKSlcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctLXBydW5lJzpcbiAgICAgICAgb3B0aW9ucy5wcnVuZSA9IHRydWVcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy0tZm9yY2UtcHJ1bmUnOlxuICAgICAgICBvcHRpb25zLnBydW5lID0gdHJ1ZVxuICAgICAgICBvcHRpb25zLmZvcmNlUHJ1bmUgPSB0cnVlXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctLW1heC1wcnVuZSc6IHtcbiAgICAgICAgY29uc3QgcmF3ID0gbmV4dChpLCBhcmcpXG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IE51bWJlcihyYXcpXG4gICAgICAgIC8vIE51bWJlcignYWJjJykgaXMgTmFOLCBhbmQgYG9ycGhhbnMubGVuZ3RoID4gTmFOYCBpcyBmYWxzZSDigJQgYW4gdW52YWxpZGF0ZWQgdmFsdWUgaGVyZVxuICAgICAgICAvLyB3b3VsZCBxdWlldGx5IHJlbW92ZSB0aGUgY2FwIHJhdGhlciB0aGFuIHRpZ2h0ZW4gaXQuXG4gICAgICAgIGlmICghTnVtYmVyLmlzSW50ZWdlcihwYXJzZWQpIHx8IHBhcnNlZCA8IDApIHRocm93IG5ldyBFcnJvcihgLS1tYXgtcHJ1bmUgbmVlZHMgYSBub24tbmVnYXRpdmUgaW50ZWdlciwgZ290OiAke3Jhd31gKVxuICAgICAgICBvcHRpb25zLm1heFBydW5lID0gcGFyc2VkXG4gICAgICAgIGkrK1xuICAgICAgICBicmVha1xuICAgICAgfVxuICAgICAgY2FzZSAnLW4nOlxuICAgICAgY2FzZSAnLS1kcnktcnVuJzpcbiAgICAgICAgb3B0aW9ucy5kcnlSdW4gPSB0cnVlXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctaCc6XG4gICAgICBjYXNlICctLWhlbHAnOlxuICAgICAgICBjb25zb2xlLmxvZyhVU0FHRSlcbiAgICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctVic6XG4gICAgICBjYXNlICctLXZlcnNpb24nOlxuICAgICAgICBjb25zb2xlLmxvZyhyZXF1aXJlKCcuLi9wYWNrYWdlLmpzb24nKS52ZXJzaW9uKVxuICAgICAgICBwcm9jZXNzLmV4aXQoMClcbiAgICAgICAgYnJlYWtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBvcHRpb246ICR7YXJnfWApXG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNsb3VkbnNSZXN0Q2FsbChcbiAgY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsXG4gIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcmVsYXRpdmVVcmw6IHN0cmluZyxcbiAgcXVlcnlPcHRpb25zOiBhbnlcbik6IFByb21pc2U8Q2xvdWRuc1Jlc3RDYWxsUmVzcG9uc2U+IHtcbiAgY29uc3QgZnVsbFVybCA9XG4gICAgJ2h0dHBzOi8vYXBpLmNsb3VkbnMubmV0JyArXG4gICAgcmVsYXRpdmVVcmwgK1xuICAgICc/JyArXG4gICAgcXVlcnlzdHJpbmcuc3RyaW5naWZ5KFxuICAgICAgT2JqZWN0LmFzc2lnbihcbiAgICAgICAge1xuICAgICAgICAgICdzdWItYXV0aC11c2VyJzogY2xvdWRuc1VzZXJuYW1lLFxuICAgICAgICAgICdhdXRoLXBhc3N3b3JkJzogY2xvdWRuc1Bhc3N3b3JkLFxuICAgICAgICB9LFxuICAgICAgICBxdWVyeU9wdGlvbnMgfHwge31cbiAgICAgIClcbiAgICApXG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChmdWxsVXJsLCB7XG4gICAgbWV0aG9kOiBtZXRob2QsXG4gICAgaGVhZGVyczoge1xuICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgIEFjY2VwdDogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgIH0sXG4gIH0pXG4gIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICBjb25zdCBlcnJvclRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KClcbiAgICBjb25zb2xlLmVycm9yKCdIVFRQIEVycm9yJywgcmVzcG9uc2Uuc3RhdHVzLCByZXNwb25zZS5zdGF0dXNUZXh0LCBlcnJvclRleHQpXG4gICAgdGhyb3cgbmV3IEVycm9yKGVycm9yVGV4dClcbiAgfVxuICByZXR1cm4gKGF3YWl0IHJlc3BvbnNlLmpzb24oKSkgYXMgQ2xvdWRuc1Jlc3RDYWxsUmVzcG9uc2Vcbn1cblxuLyoqXG4gKiBDbG91RE5TIHJlcG9ydHMgZmFpbHVyZXMgaW4gdGhlIGJvZHkgd2l0aCBIVFRQIDIwMCwgc28gYSBjYWxsIGlzIG9ubHkgc3VjY2Vzc2Z1bCBpZiBpdCBzYXlzIHNvLlxuICpcbiAqIFRyZWF0aW5nIFwibm90IHRoZSBzdHJpbmcgRmFpbGVkXCIgYXMgc3VjY2VzcyBpcyBob3cgYSByZWplY3RlZCB3cml0ZSBnZXRzIHJlcG9ydGVkIGFzIGRvbmUg4oCUXG4gKiBjaGVja2VkIHBvc2l0aXZlbHkgaGVyZSBpbnN0ZWFkLlxuICovXG5mdW5jdGlvbiBhc3NlcnRTdWNjZXNzKHJlc3VsdDogYW55LCB3aGF0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgc3RhdHVzID0gcmVzdWx0Py5zdGF0dXNcbiAgaWYgKHN0YXR1cyA9PT0gJ1N1Y2Nlc3MnIHx8IHN0YXR1cyA9PT0gMSB8fCBzdGF0dXMgPT09ICcxJykgcmV0dXJuXG4gIHRocm93IG5ldyBFcnJvcihgJHt3aGF0fSBmYWlsZWQ6ICR7cmVzdWx0Py5zdGF0dXNEZXNjcmlwdGlvbiB8fCByZXN1bHQ/LnN0YXR1c01lc3NhZ2UgfHwgSlNPTi5zdHJpbmdpZnkocmVzdWx0KX1gKVxufVxuXG4vKipcbiAqIFRoZSBDbG91RE5TIHpvbmUgYSByZWNvcmQgbmFtZSBiZWxvbmdzIHRvLCBhbmQgaXRzIGhvc3QgbmFtZSB3aXRoaW4gdGhhdCB6b25lLlxuICpcbiAqIFRoZSBtb3N0IHNwZWNpZmljIHpvbmUgdGhlIGFjY291bnQgaG9sZHMgd2lucywgdGhlIHdheSBETlMgZGVsZWdhdGlvbiBkb2VzOiB3aXRoIGJvdGggZXhhbXBsZS5vcmdcbiAqIGFuZCBhIGRlbGVnYXRlZCBkZXYuZXhhbXBsZS5vcmcsIHd3dy5kZXYuZXhhbXBsZS5vcmcgZ29lcyBpbnRvIGRldi5leGFtcGxlLm9yZywgYmVjYXVzZSBhIHJlY29yZFxuICogd3JpdHRlbiBpbnRvIGV4YW1wbGUub3JnIHVuZGVyIHRoYXQgbmFtZSBpcyBuZXZlciBzZXJ2ZWQgb25jZSB0aGUgc3ViZG9tYWluIGlzIGRlbGVnYXRlZC4gQ2hlY2tlZFxuICogZnJvbSB0aGUgZnVsbCBuYW1lIGRvd24gdG8gdHdvIGxhYmVscywgc28gYSBuYW1lIHRoYXQgaXMgaXRzZWxmIGEgem9uZSBnZXRzIHRoZSBhcGV4IChlbXB0eSBob3N0KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGF1dG9EZXRlY3RDbG91ZG5zSG9zdEFuZFpvbmUoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHpvbmVDYWNoZTogYW55KSB7XG4gIGNvbnN0IG5hbWVQYXJ0cyA9IG5hbWUuc3BsaXQoJy4nKVxuICBmb3IgKGxldCB6b25lTGFiZWxzID0gbmFtZVBhcnRzLmxlbmd0aDsgem9uZUxhYmVscyA+PSAyOyB6b25lTGFiZWxzLS0pIHtcbiAgICBjb25zdCB6b25lTmFtZSA9IG5hbWVQYXJ0cy5zbGljZShuYW1lUGFydHMubGVuZ3RoIC0gem9uZUxhYmVscykuam9pbignLicpXG4gICAgY29uc3Qgem9uZVJlc3BvbnNlID1cbiAgICAgIHpvbmVDYWNoZVt6b25lTmFtZV0gfHxcbiAgICAgIChhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdHRVQnLCAnL2Rucy9nZXQtem9uZS1pbmZvLmpzb24nLCB7XG4gICAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICAgfSkpXG4gICAgem9uZUNhY2hlW3pvbmVOYW1lXSA9IHpvbmVSZXNwb25zZVxuICAgIGlmICh6b25lUmVzcG9uc2Uuc3RhdHVzID09PSAnMScpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGhvc3ROYW1lOiBuYW1lUGFydHMuc2xpY2UoMCwgbmFtZVBhcnRzLmxlbmd0aCAtIHpvbmVMYWJlbHMpLmpvaW4oJy4nKSxcbiAgICAgICAgem9uZU5hbWU6IHpvbmVOYW1lLFxuICAgICAgfVxuICAgIH1cbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoJ1pvbmUgTm90IEZvdW5kOiAnICsgbmFtZSlcbn1cblxuLyoqXG4gKiBFdmVyeSByZWNvcmQgaW4gYSB6b25lLCBub3RlcyBpbmNsdWRlZC4gQWxzbyB0aGUgYmFzaXMgZm9yIGZpbmRpbmcgb3JwaGFucy5cbiAqXG4gKiBDYWNoZWQgcGVyIHJ1bjogbG9va2luZyBhIHJlY29yZCB1cCBhbmQgdGhlbiB2ZXJpZnlpbmcgaXQgdXNlZCB0byBjb3N0IHR3byB3aG9sZS16b25lIGNhbGxzIGVhY2gsXG4gKiBzbyB0d2VudHkgZXhwb3J0cyBtZWFudCBmb3J0eSBsaXN0aW5ncyBhZ2FpbnN0IGFuIEFQSSB0aGF0IHJhdGUgbGltaXRzLiBBbnkgd3JpdGUgaW52YWxpZGF0ZXMgdGhlXG4gKiB6b25lLCBhbmQgdmVyaWZpY2F0aW9uIGFsd2F5cyByZWFkcyBmcmVzaCwgc28gYSBjYWNoZWQgbGlzdGluZyBpcyBuZXZlciB1c2VkIHRvIGp1ZGdlIHNvbWV0aGluZ1xuICogdGhhdCBoYXMganVzdCBjaGFuZ2VkLlxuICovXG5jb25zdCB6b25lUmVjb3Jkc0NhY2hlID0gbmV3IE1hcDxzdHJpbmcsIENsb3VkbnNSZWNvcmRbXT4oKVxuXG5hc3luYyBmdW5jdGlvbiBsaXN0Wm9uZVJlY29yZHMoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCB6b25lTmFtZTogc3RyaW5nLCBmcmVzaCA9IGZhbHNlKTogUHJvbWlzZTxDbG91ZG5zUmVjb3JkW10+IHtcbiAgaWYgKCFmcmVzaCkge1xuICAgIGNvbnN0IGNhY2hlZCA9IHpvbmVSZWNvcmRzQ2FjaGUuZ2V0KHpvbmVOYW1lKVxuICAgIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWRcbiAgfVxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ0dFVCcsICcvZG5zL3JlY29yZHMuanNvbicsIHtcbiAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAnaW5jbHVkZS1ub3Rlcyc6ICcxJyxcbiAgfSlcbiAgLy8gQW4gZW1wdHkgem9uZSBjb21lcyBiYWNrIGFzIGFuIGVtcHR5IGFycmF5IHJhdGhlciB0aGFuIGFuIGVtcHR5IG9iamVjdC5cbiAgY29uc3QgcmVjb3JkcyA9ICFyZXNwb25zZSB8fCBBcnJheS5pc0FycmF5KHJlc3BvbnNlKSA/IFtdIDogKE9iamVjdC52YWx1ZXMocmVzcG9uc2UpIGFzIENsb3VkbnNSZWNvcmRbXSlcbiAgem9uZVJlY29yZHNDYWNoZS5zZXQoem9uZU5hbWUsIHJlY29yZHMpXG4gIHJldHVybiByZWNvcmRzXG59XG5cbmZ1bmN0aW9uIG93bmVyc2hpcE5vdGUoc3RhY2tOYW1lOiBzdHJpbmcsIGV4cG9ydE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtOT1RFX01BUktFUn0gc3RhY2s9JHtzdGFja05hbWV9IGV4cG9ydD0ke2V4cG9ydE5hbWV9YFxufVxuXG4vKiogVGhlIHN0YWNrIG5hbWVkIGluIGEgcmVjb3JkJ3Mgbm90ZSwgb3IgdW5kZWZpbmVkIHdoZW4gdGhlIHJlY29yZCBpcyBub3Qgb3Vycy4gKi9cbmZ1bmN0aW9uIG5vdGVTdGFja05hbWUocmVjb3JkOiBDbG91ZG5zUmVjb3JkKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFyZWNvcmQubm90ZSB8fCByZWNvcmQubm90ZS5pbmRleE9mKE5PVEVfTUFSS0VSKSA9PT0gLTEpIHJldHVybiB1bmRlZmluZWRcbiAgY29uc3QgbWF0Y2ggPSAvc3RhY2s9KFxcUyspLy5leGVjKHJlY29yZC5ub3RlKVxuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFsxXSA6ICcnXG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNldFJlY29yZE5vdGUoXG4gIGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLFxuICBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZyxcbiAgem9uZU5hbWU6IHN0cmluZyxcbiAgcmVjb3JkSWQ6IHN0cmluZyxcbiAgbm90ZTogc3RyaW5nLFxuICBkcnlSdW46IGJvb2xlYW5cbik6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoZHJ5UnVuKSByZXR1cm5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnUE9TVCcsICcvZG5zL3NldC1yZWNvcmQtbm90ZS5qc29uJywge1xuICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICdyZWNvcmQtaWQnOiByZWNvcmRJZCxcbiAgICBub3RlOiBub3RlLFxuICB9KVxuICBhc3NlcnRTdWNjZXNzKHJlc3VsdCwgJ1NldCByZWNvcmQgbm90ZScpXG4gIHpvbmVSZWNvcmRzQ2FjaGUuZGVsZXRlKHpvbmVOYW1lKVxufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVPclVwZGF0ZUNsb3VkbnNSZXNvdXJjZShcbiAgY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsXG4gIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLFxuICBkZXNpcmVkOiBEZXNpcmVkUmVjb3JkLFxuICB0dGxWYWx1ZTogc3RyaW5nLFxuICBkcnlSdW46IGJvb2xlYW5cbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IHpvbmVOYW1lLCBob3N0TmFtZSwgdHlwZSwgdmFsdWUgfSA9IGRlc2lyZWRcbiAgY29uc3QgbmFtZSA9IGhvc3ROYW1lID8gYCR7aG9zdE5hbWV9LiR7em9uZU5hbWV9YCA6IHpvbmVOYW1lXG5cbiAgY29uc3QgcmVjb3JkcyA9IGF3YWl0IGxpc3Rab25lUmVjb3JkcyhjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWUpXG4gIC8qKlxuICAgKiBNYXRjaCBvbiBob3N0IGFuZCB0eXBlIGFjcm9zcyB0aGUgd2hvbGUgem9uZSByYXRoZXIgdGhhbiB0cnVzdGluZyBhIGZpbHRlcmVkIHF1ZXJ5J3MgZmlyc3RcbiAgICogZW50cnkuIFRha2luZyB3aGljaGV2ZXIgcmVjb3JkIGhhcHBlbmVkIHRvIGNvbWUgYmFjayBmaXJzdCBtZWFudCB0aGF0IGEgaG9zdCB3aXRoIG1vcmUgdGhhbiBvbmVcbiAgICogcmVjb3JkIG9mIGEgdHlwZSBoYWQgb25lIG9mIHRoZW0gdXBkYXRlZCBhdCByYW5kb20gd2hpbGUgdGhlIG90aGVyIGtlcHQgc2VydmluZyB0cmFmZmljLlxuICAgKi9cbiAgY29uc3QgbWF0Y2hpbmcgPSByZWNvcmRzLmZpbHRlcigocmVjb3JkKSA9PiByZWNvcmQuaG9zdCA9PT0gaG9zdE5hbWUgJiYgcmVjb3JkLnR5cGUgPT09IHR5cGUpXG4gIGlmIChtYXRjaGluZy5sZW5ndGggPiAxKSB7XG4gICAgY29uc29sZS53YXJuKCdXQVJOJywgbmFtZSwgdHlwZSwgJ2hhcycsIG1hdGNoaW5nLmxlbmd0aCwgJ3JlY29yZHM7IHVwZGF0aW5nIHRoZSBmaXJzdCBhbmQgbGVhdmluZyB0aGUgcmVzdCcpXG4gIH1cbiAgY29uc3QgZXhpc3RpbmdSZWNvcmQgPSBtYXRjaGluZ1swXVxuICBjb25zdCBub3RlID0gb3duZXJzaGlwTm90ZShkZXNpcmVkLnN0YWNrTmFtZSwgZGVzaXJlZC5leHBvcnROYW1lKVxuXG4gIGlmIChleGlzdGluZ1JlY29yZCAmJiBleGlzdGluZ1JlY29yZC5yZWNvcmQgPT09IHZhbHVlICYmIFN0cmluZyhleGlzdGluZ1JlY29yZC50dGwpID09PSBTdHJpbmcodHRsVmFsdWUpICYmIHNhbWVQcmlvcml0eShleGlzdGluZ1JlY29yZCwgZGVzaXJlZCkpIHtcbiAgICBpZiAoZXhpc3RpbmdSZWNvcmQubm90ZSA9PT0gbm90ZSkge1xuICAgICAgY29uc29sZS5sb2coJ09LJywgbmFtZSwgdHlwZSwgdHRsVmFsdWUsIHZhbHVlLCAnWk9ORScsIHpvbmVOYW1lLCAnSE9TVCcsIGhvc3ROYW1lKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBBZG9wdHMgcmVjb3JkcyBjcmVhdGVkIGJlZm9yZSBvd25lcnNoaXAgbm90ZXMgZXhpc3RlZCwgYW5kIHJlcGFpcnMgYSBub3RlIHRoYXQgZHJpZnRlZC5cbiAgICAgIGNvbnNvbGUubG9nKCdBRE9QVCcsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgICAgIGF3YWl0IHNldFJlY29yZE5vdGUoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHpvbmVOYW1lLCBleGlzdGluZ1JlY29yZC5pZCwgbm90ZSwgZHJ5UnVuKVxuICAgIH1cbiAgICByZXR1cm5cbiAgfVxuXG4gIGlmIChleGlzdGluZ1JlY29yZCkge1xuICAgIGNvbnNvbGUubG9nKCdVUERBVEUnLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gICAgaWYgKCFkcnlSdW4pIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ1BPU1QnLCAnL2Rucy9tb2QtcmVjb3JkLmpzb24nLCB7XG4gICAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICAgICAncmVjb3JkLWlkJzogZXhpc3RpbmdSZWNvcmQuaWQsXG4gICAgICAgIGhvc3Q6IGhvc3ROYW1lLFxuICAgICAgICAncmVjb3JkLXR5cGUnOiB0eXBlLFxuICAgICAgICByZWNvcmQ6IHZhbHVlLFxuICAgICAgICB0dGw6IHR0bFZhbHVlLFxuICAgICAgICAuLi4oZGVzaXJlZC5wcmlvcml0eSAhPT0gdW5kZWZpbmVkID8geyBwcmlvcml0eTogZGVzaXJlZC5wcmlvcml0eSB9IDoge30pLFxuICAgICAgfSlcbiAgICAgIGFzc2VydFN1Y2Nlc3MocmVzdWx0LCAnTW9kaWZ5IHJlY29yZCcpXG4gICAgICBhd2FpdCBzZXRSZWNvcmROb3RlKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCB6b25lTmFtZSwgZXhpc3RpbmdSZWNvcmQuaWQsIG5vdGUsIGRyeVJ1bilcbiAgICAgIGF3YWl0IHZlcmlmeVJlY29yZChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgZGVzaXJlZCwgdHRsVmFsdWUpXG4gICAgfVxuICAgIHJldHVyblxuICB9XG5cbiAgY29uc29sZS5sb2coJ0NSRUFURScsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgaWYgKGRyeVJ1bikgcmV0dXJuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ1BPU1QnLCAnL2Rucy9hZGQtcmVjb3JkLmpzb24nLCB7XG4gICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgaG9zdDogaG9zdE5hbWUsXG4gICAgJ3JlY29yZC10eXBlJzogdHlwZSxcbiAgICByZWNvcmQ6IHZhbHVlLFxuICAgIHR0bDogdHRsVmFsdWUsXG4gICAgLi4uKGRlc2lyZWQucHJpb3JpdHkgIT09IHVuZGVmaW5lZCA/IHsgcHJpb3JpdHk6IGRlc2lyZWQucHJpb3JpdHkgfSA6IHt9KSxcbiAgfSlcbiAgYXNzZXJ0U3VjY2VzcyhyZXN1bHQsICdBZGQgcmVjb3JkJylcbiAgY29uc3QgY3JlYXRlZElkID0gcmVzdWx0Py5kYXRhPy5pZFxuICBpZiAoY3JlYXRlZElkKSBhd2FpdCBzZXRSZWNvcmROb3RlKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCB6b25lTmFtZSwgU3RyaW5nKGNyZWF0ZWRJZCksIG5vdGUsIGRyeVJ1bilcbiAgYXdhaXQgdmVyaWZ5UmVjb3JkKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCBkZXNpcmVkLCB0dGxWYWx1ZSlcbn1cblxuLyoqXG4gKiBSZWFkcyB0aGUgcmVjb3JkIGJhY2sgYW5kIGNvbXBsYWlucyBpZiBpdCBpcyBub3Qgd2hhdCB3YXMganVzdCB3cml0dGVuLlxuICpcbiAqIFdpdGhvdXQgdGhpcyB0aGUgbG9nIHJlcG9ydHMgaW50ZW50IHJhdGhlciB0aGFuIG91dGNvbWUsIHdoaWNoIGlzIGhvdyBhIGN1dG92ZXIgdGhhdCBuZXZlclxuICogaGFwcGVuZWQgY2FuIGxvb2sgbGlrZSBhIGNsZWFuIHJ1bi4gTm90ZSB0aGlzIGNvbmZpcm1zIHRoZSBzdG9yZWQgcmVjb3JkIG9ubHkg4oCUIENsb3VETlMgcmVzb2x2ZXNcbiAqIEFMSUFTIHRhcmdldHMgb24gaXRzIG93biBzY2hlZHVsZSwgc28gd2hhdCB0aGUgem9uZSAqc2VydmVzKiBjYW4gbGFnIHRoZSByZWNvcmQgYnkgYSBsb25nIHdheS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gdmVyaWZ5UmVjb3JkKGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLCBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZywgZGVzaXJlZDogRGVzaXJlZFJlY29yZCwgdHRsVmFsdWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByZWNvcmRzID0gYXdhaXQgbGlzdFpvbmVSZWNvcmRzKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCBkZXNpcmVkLnpvbmVOYW1lLCB0cnVlKVxuICBjb25zdCBzdG9yZWQgPSByZWNvcmRzLmZpbmQoKHJlY29yZCkgPT4gcmVjb3JkLmhvc3QgPT09IGRlc2lyZWQuaG9zdE5hbWUgJiYgcmVjb3JkLnR5cGUgPT09IGRlc2lyZWQudHlwZSlcbiAgaWYgKCFzdG9yZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFZlcmlmaWNhdGlvbiBmYWlsZWQ6ICR7ZGVzaXJlZC5ob3N0TmFtZX0uJHtkZXNpcmVkLnpvbmVOYW1lfSAke2Rlc2lyZWQudHlwZX0gaXMgbWlzc2luZyBhZnRlciB3cml0ZWApXG4gIH1cbiAgaWYgKHN0b3JlZC5yZWNvcmQgIT09IGRlc2lyZWQudmFsdWUgfHwgU3RyaW5nKHN0b3JlZC50dGwpICE9PSBTdHJpbmcodHRsVmFsdWUpIHx8ICFzYW1lUHJpb3JpdHkoc3RvcmVkLCBkZXNpcmVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBWZXJpZmljYXRpb24gZmFpbGVkOiAke2Rlc2lyZWQuaG9zdE5hbWV9LiR7ZGVzaXJlZC56b25lTmFtZX0gJHtkZXNpcmVkLnR5cGV9IGlzICR7c3RvcmVkLnJlY29yZH0gKHR0bCAke3N0b3JlZC50dGx9LCBwcmlvcml0eSAke3N0b3JlZC5wcmlvcml0eSA/PyAnLSd9KSwgZXhwZWN0ZWQgJHtkZXNpcmVkLnZhbHVlfSAodHRsICR7dHRsVmFsdWV9LCBwcmlvcml0eSAke2Rlc2lyZWQucHJpb3JpdHkgPz8gJy0nfSlgXG4gICAgKVxuICB9XG59XG5cbi8qKiBXaGV0aGVyIGEgc3RvcmVkIHJlY29yZCBoYXMgdGhlIHByZWZlcmVuY2UgdGhlIGV4cG9ydCBhc2tzIGZvcjsgb25seSBNWCBleHBvcnRzIGFzayBmb3Igb25lLiAqL1xuZnVuY3Rpb24gc2FtZVByaW9yaXR5KHN0b3JlZDogQ2xvdWRuc1JlY29yZCwgZGVzaXJlZDogRGVzaXJlZFJlY29yZCk6IGJvb2xlYW4ge1xuICByZXR1cm4gZGVzaXJlZC5wcmlvcml0eSA9PT0gdW5kZWZpbmVkIHx8IFN0cmluZyhzdG9yZWQucHJpb3JpdHkpID09PSBkZXNpcmVkLnByaW9yaXR5XG59XG5cbi8qKlxuICogRGVsZXRlcyBtYW5hZ2VkIHJlY29yZHMgd2hvc2UgZXhwb3J0IG5vIGxvbmdlciBleGlzdHMuXG4gKlxuICogT25seSByZWNvcmRzIGNhcnJ5aW5nIHRoaXMgdG9vbCdzIG5vdGUgYXJlIGNvbnNpZGVyZWQsIGFuZCB3aGVuIC0tc3RhY2sgd2FzIGdpdmVuIG9ubHkgdGhvc2VcbiAqIHdob3NlIG5vdGUgbmFtZXMgb25lIG9mIHRob3NlIHN0YWNrcyDigJQgb3RoZXJ3aXNlIHN5bmNpbmcgb25lIHN0YWNrIHdvdWxkIGRlbGV0ZSB0aGUgcmVjb3JkcyBvZlxuICogYW5vdGhlci5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcHJ1bmVPcnBoYW5zKFxuICBjbG91ZG5zVXNlcm5hbWU6IHN0cmluZyxcbiAgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsXG4gIHpvbmVOYW1lczogc3RyaW5nW10sXG4gIGRlc2lyZWQ6IERlc2lyZWRSZWNvcmRbXSxcbiAgc3RhY2tTY29wZTogU2V0PHN0cmluZz4gfCB1bmRlZmluZWQsXG4gIG9wdGlvbnM6IE9wdGlvbnNcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBkZXNpcmVkS2V5cyA9IG5ldyBTZXQoZGVzaXJlZC5tYXAoKHJlY29yZCkgPT4gYCR7cmVjb3JkLnpvbmVOYW1lfXwke3JlY29yZC5ob3N0TmFtZX18JHtyZWNvcmQudHlwZX1gKSlcbiAgY29uc3Qgb3JwaGFuczogeyB6b25lTmFtZTogc3RyaW5nOyByZWNvcmQ6IENsb3VkbnNSZWNvcmQgfVtdID0gW11cblxuICBmb3IgKGNvbnN0IHpvbmVOYW1lIG9mIHpvbmVOYW1lcykge1xuICAgIGZvciAoY29uc3QgcmVjb3JkIG9mIGF3YWl0IGxpc3Rab25lUmVjb3JkcyhjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWUsIHRydWUpKSB7XG4gICAgICBjb25zdCBzdGFjayA9IG5vdGVTdGFja05hbWUocmVjb3JkKVxuICAgICAgaWYgKHN0YWNrID09PSB1bmRlZmluZWQpIGNvbnRpbnVlIC8vIG5vdCBvdXJzXG4gICAgICBpZiAoc3RhY2tTY29wZSAmJiAhc3RhY2tTY29wZS5oYXMoc3RhY2spKSBjb250aW51ZSAvLyBhbm90aGVyIHN0YWNrJ3NcbiAgICAgIGlmIChkZXNpcmVkS2V5cy5oYXMoYCR7em9uZU5hbWV9fCR7cmVjb3JkLmhvc3R9fCR7cmVjb3JkLnR5cGV9YCkpIGNvbnRpbnVlIC8vIHN0aWxsIHdhbnRlZFxuICAgICAgb3JwaGFucy5wdXNoKHsgem9uZU5hbWUsIHJlY29yZCB9KVxuICAgIH1cbiAgfVxuXG4gIGlmICghb3JwaGFucy5sZW5ndGgpIHtcbiAgICBjb25zb2xlLmxvZygnUFJVTkUgbm9uZScpXG4gICAgcmV0dXJuXG4gIH1cblxuICBmb3IgKGNvbnN0IHsgem9uZU5hbWUsIHJlY29yZCB9IG9mIG9ycGhhbnMpIHtcbiAgICBjb25zdCBuYW1lID0gcmVjb3JkLmhvc3QgPyBgJHtyZWNvcmQuaG9zdH0uJHt6b25lTmFtZX1gIDogem9uZU5hbWVcbiAgICBjb25zb2xlLmxvZyhvcHRpb25zLmRyeVJ1biA/ICdXT1VMRCBQUlVORScgOiAnUFJVTkUnLCBuYW1lLCByZWNvcmQudHlwZSwgcmVjb3JkLnJlY29yZCwgJ1pPTkUnLCB6b25lTmFtZSlcbiAgfVxuXG4gIGNvbnN0IG92ZXJDYXAgPSBvcnBoYW5zLmxlbmd0aCA+IG9wdGlvbnMubWF4UHJ1bmVcbiAgaWYgKG9wdGlvbnMuZHJ5UnVuKSB7XG4gICAgaWYgKG92ZXJDYXApIGNvbnNvbGUud2FybignV0FSTicsIGBBIHJlYWwgcnVuIHdvdWxkIHJlZnVzZTogJHtvcnBoYW5zLmxlbmd0aH0gcmVjb3JkcyBleGNlZWRzIC0tbWF4LXBydW5lICR7b3B0aW9ucy5tYXhQcnVuZX1gKVxuICAgIHJldHVyblxuICB9XG4gIGlmIChvdmVyQ2FwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBSZWZ1c2luZyB0byBkZWxldGUgJHtvcnBoYW5zLmxlbmd0aH0gcmVjb3JkcyBpbiBvbmUgcnVuIChsaW1pdCAke29wdGlvbnMubWF4UHJ1bmV9KTsgcmFpc2UgLS1tYXgtcHJ1bmUgaWYgdGhpcyBpcyBpbnRlbmRlZGApXG4gIH1cblxuICBmb3IgKGNvbnN0IHsgem9uZU5hbWUsIHJlY29yZCB9IG9mIG9ycGhhbnMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdQT1NUJywgJy9kbnMvZGVsZXRlLXJlY29yZC5qc29uJywge1xuICAgICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgICAncmVjb3JkLWlkJzogcmVjb3JkLmlkLFxuICAgIH0pXG4gICAgYXNzZXJ0U3VjY2VzcyhyZXN1bHQsICdEZWxldGUgcmVjb3JkJylcbiAgfVxufVxuXG4vKipcbiAqIFR1cm5zIGFuIGV4cG9ydCBuYW1lIGludG8gdGhlIHJlY29yZCBpdCBkZXNjcmliZXM6IENsb3VETlM6PHR5cGU+Ojxob3N0IGxhYmVscy4uLj4uXG4gKlxuICogREtJTSBpcyB0aGUgb25lIGZvcm0gdGhhdCBpcyBub3QgYSByZWNvcmQgdHlwZS4gQW4gZXhwb3J0IG5hbWUgbWF5IG9ubHkgaG9sZCBsZXR0ZXJzLCBkaWdpdHMsXG4gKiBjb2xvbnMgYW5kIGh5cGhlbnMsIGFuZCBhIERLSU0gcmVjb3JkIGxpdmVzIHVuZGVyIGBfZG9tYWlua2V5YCwgd2hpY2ggbm8gZXhwb3J0IG5hbWUgY2FuIHNwZWxsLlxuICogU28gQ2xvdUROUzpES0lNOjxzZWxlY3Rvcj46ZXhhbXBsZTpvcmcgc3RhbmRzIGZvciB0aGUgQ05BTUUgPHNlbGVjdG9yPi5fZG9tYWlua2V5LmV4YW1wbGUub3JnIC1cbiAqIHRoZSBzaGFwZSBTRVMgRWFzeSBES0lNIGFza3MgZm9yLCB0aHJlZSBvZiB0aGVtIHBlciBkb21haW4uXG4gKlxuICogRE1BUkMgaXMgdGhlIHNhbWUga2luZCBvZiBmb3JtIGZvciBgX2RtYXJjYDogQ2xvdUROUzpETUFSQzpleGFtcGxlOm9yZyBzdGFuZHMgZm9yIHRoZSBUWFQgcmVjb3JkXG4gKiBfZG1hcmMuZXhhbXBsZS5vcmcsIHdob3NlIHRleHQgaXMgdGhlIGV4cG9ydCB2YWx1ZSwgc3VjaCBhcyBgdj1ETUFSQzE7IHA9bm9uZWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUV4cG9ydE5hbWUoZXhwb3J0TmFtZTogc3RyaW5nKTogeyByZXNvdXJjZVR5cGU6IHN0cmluZzsgcmVzb3VyY2VOYW1lOiBzdHJpbmcgfSB7XG4gIGNvbnN0IG5hbWVQYXJ0cyA9IGV4cG9ydE5hbWUuc3BsaXQoJzonKVxuICBpZiAobmFtZVBhcnRzWzFdID09PSAnRE1BUkMnKSB7XG4gICAgY29uc3QgZG9tYWluUGFydHMgPSBuYW1lUGFydHMuc2xpY2UoMilcbiAgICBpZiAoZG9tYWluUGFydHMubGVuZ3RoIDwgMiB8fCBkb21haW5QYXJ0cy5zb21lKChwYXJ0KSA9PiAhcGFydCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgRXhwb3J0ICR7ZXhwb3J0TmFtZX0gbXVzdCBiZSBDbG91RE5TOkRNQVJDOjxkb21haW4gbGFiZWxzPmApXG4gICAgfVxuICAgIHJldHVybiB7IHJlc291cmNlVHlwZTogJ1RYVCcsIHJlc291cmNlTmFtZTogYF9kbWFyYy4ke2RvbWFpblBhcnRzLmpvaW4oJy4nKX1gIH1cbiAgfVxuICBpZiAobmFtZVBhcnRzWzFdID09PSAnREtJTScpIHtcbiAgICBjb25zdCBbc2VsZWN0b3IsIC4uLmRvbWFpblBhcnRzXSA9IG5hbWVQYXJ0cy5zbGljZSgyKVxuICAgIGlmICghc2VsZWN0b3IgfHwgZG9tYWluUGFydHMubGVuZ3RoIDwgMikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBFeHBvcnQgJHtleHBvcnROYW1lfSBtdXN0IGJlIENsb3VETlM6REtJTTo8c2VsZWN0b3I+Ojxkb21haW4gbGFiZWxzPmApXG4gICAgfVxuICAgIHJldHVybiB7IHJlc291cmNlVHlwZTogJ0NOQU1FJywgcmVzb3VyY2VOYW1lOiBgJHtzZWxlY3Rvcn0uX2RvbWFpbmtleS4ke2RvbWFpblBhcnRzLmpvaW4oJy4nKX1gIH1cbiAgfVxuICByZXR1cm4geyByZXNvdXJjZVR5cGU6IG5hbWVQYXJ0c1sxXSwgcmVzb3VyY2VOYW1lOiBuYW1lUGFydHMuc2xpY2UoMikuam9pbignLicpIH1cbn1cblxuLyoqXG4gKiBTcGxpdHMgYW4gZXhwb3J0IHZhbHVlIGludG8gdGhlIHJlY29yZCBhbmQsIGZvciBNWCwgaXRzIHByZWZlcmVuY2U6IGFuIE1YIGV4cG9ydCdzIHZhbHVlIGlzXG4gKiBgPHByaW9yaXR5PiA8bWFpbCBzZXJ2ZXI+YCwgc3VjaCBhcyBgMSBtYWlsLmV4YW1wbGUub3JnYCwgYXMgdGhlIHJlY29yZCBpcyB3cml0dGVuIGluIGEgem9uZSBmaWxlLlxuICogRXZlcnkgb3RoZXIgdHlwZSdzIHZhbHVlIGlzIHRoZSByZWNvcmQgYXMtaXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUV4cG9ydFZhbHVlKGV4cG9ydE5hbWU6IHN0cmluZywgcmVzb3VyY2VUeXBlOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB7IHZhbHVlOiBzdHJpbmc7IHByaW9yaXR5Pzogc3RyaW5nIH0ge1xuICBpZiAocmVzb3VyY2VUeXBlICE9PSAnTVgnKSByZXR1cm4geyB2YWx1ZSB9XG4gIGNvbnN0IG1hdGNoID0gdmFsdWUudHJpbSgpLm1hdGNoKC9eKFxcZCspXFxzKyhcXFMrKSQvKVxuICBpZiAoIW1hdGNoKSB0aHJvdyBuZXcgRXJyb3IoYEV4cG9ydCAke2V4cG9ydE5hbWV9IG11c3QgaGF2ZSB0aGUgdmFsdWUgXCI8cHJpb3JpdHk+IDxtYWlsIHNlcnZlcj5cIiwgc3VjaCBhcyBcIjEgbWFpbC5leGFtcGxlLm9yZ1wiYClcbiAgcmV0dXJuIHsgdmFsdWU6IG1hdGNoWzJdLCBwcmlvcml0eTogU3RyaW5nKE51bWJlcihtYXRjaFsxXSkpIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIC8vIFBhcnNlZCBiZWZvcmUgdGhlIGJhbm5lciBzbyAtLXZlcnNpb24gYW5kIC0taGVscCBwcmludCBvbmx5IHdoYXQgYSBjYWxsZXIgYXNrZWQgZm9yLlxuICBjb25zdCBvcHRpb25zID0gcGFyc2VBcmdzKHByb2Nlc3MuYXJndi5zbGljZSgyKSlcbiAgY29uc29sZS5sb2coJ0Nsb3VETlMgQ2xvdWRGb3JtYXRpb24gU3luYyBieSBLZW5uZXRoIEZhbGNrIDxrZW5udUBjbG91ZGVuLm5ldD4gKEMpIENsb3VkZW4gT3kgMjAyMC0yMDI2JylcblxuICBpZiAoIW9wdGlvbnMudXNlcm5hbWUgfHwgIW9wdGlvbnMucGFzc3dvcmRQYXJhbWV0ZXIpIHtcbiAgICBjb25zb2xlLmVycm9yKFVTQUdFKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG4gIGlmIChvcHRpb25zLmZvcmNlUHJ1bmUgJiYgIW9wdGlvbnMuem9uZU5hbWVzLmxlbmd0aCkge1xuICAgIGNvbnNvbGUuZXJyb3IoJy0tZm9yY2UtcHJ1bmUgbmVlZHMgYXQgbGVhc3Qgb25lIC0tem9uZTogd2l0aCBubyBleHBvcnRzIHRoZXJlIGlzIG5vdGhpbmcgdG8gaW5mZXIgYSB6b25lIGZyb20nKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG5cbiAgY29uc3Qgc3NtID0gbmV3IFNTTUNsaWVudCh7fSlcbiAgY29uc3Qgem9uZUNhY2hlID0ge31cblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHNzbS5zZW5kKFxuICAgIG5ldyBHZXRQYXJhbWV0ZXJDb21tYW5kKHtcbiAgICAgIE5hbWU6IG9wdGlvbnMucGFzc3dvcmRQYXJhbWV0ZXIsXG4gICAgICBXaXRoRGVjcnlwdGlvbjogdHJ1ZSxcbiAgICB9KVxuICApXG4gIGNvbnN0IGNsb3VkbnNQYXNzd29yZCA9IHJlc3BvbnNlLlBhcmFtZXRlcj8uVmFsdWUgfHwgJydcblxuICAvLyBDb2xsZWN0IGV2ZXJ5dGhpbmcgdGhlIGV4cG9ydHMgYXNrIGZvciBiZWZvcmUgd3JpdGluZyBhbnl0aGluZywgc28gcHJ1bmluZyBjYW4gY29tcGFyZSBhZ2FpbnN0XG4gIC8vIHRoZSBjb21wbGV0ZSBwaWN0dXJlIHJhdGhlciB0aGFuIGFnYWluc3Qgd2hhdGV2ZXIgaGFzIGJlZW4gcHJvY2Vzc2VkIHNvIGZhci5cbiAgY29uc3QgZGVzaXJlZDogRGVzaXJlZFJlY29yZFtdID0gW11cbiAgLyoqIEV2ZXJ5IHNwZWxsaW5nIG9mIGEgc3RhY2sgdGhhdCBtYXRjaGVkLCBzbyAtLXN0YWNrIGNhbiBiZSBnaXZlbiBhcyBhIG5hbWUgb3IgYSBmdWxsIEFSTi4gKi9cbiAgY29uc3QgbWF0Y2hlZFN0YWNrcyA9IG5ldyBTZXQ8c3RyaW5nPigpXG4gIC8qKiBTaG9ydCBuYW1lcyBvbmx5LCB3aGljaCBpcyB0aGUgZm9ybSBvd25lcnNoaXAgbm90ZXMgY2FycnksIHNvIHBydW5pbmcgY2FuIGJlIHNjb3BlZCBieSB0aGVtLiAqL1xuICBjb25zdCBtYXRjaGVkU3RhY2tOYW1lcyA9IG5ldyBTZXQ8c3RyaW5nPigpXG4gIGNvbnN0IGNsb3VkRm9ybWF0aW9uID0gbmV3IENsb3VkRm9ybWF0aW9uQ2xpZW50KHt9KVxuICBsZXQgbmV4dFRva2VuXG4gIGRvIHtcbiAgICBjb25zdCByZXNwb25zZTogTGlzdEV4cG9ydHNPdXRwdXQgPSBhd2FpdCBjbG91ZEZvcm1hdGlvbi5zZW5kKG5ldyBMaXN0RXhwb3J0c0NvbW1hbmQoeyBOZXh0VG9rZW46IG5leHRUb2tlbiB9KSlcbiAgICBmb3IgKGNvbnN0IGV4cG9ydE9iaiBvZiByZXNwb25zZS5FeHBvcnRzIHx8IFtdKSB7XG4gICAgICBjb25zdCBzdGFja01hdGNoID0gZXhwb3J0T2JqLkV4cG9ydGluZ1N0YWNrSWQ/Lm1hdGNoKC9eYXJuOlteOl0rOmNsb3VkZm9ybWF0aW9uOlteOl0rOlteOl0rOnN0YWNrXFwvKFteL10rKVxcLy8pXG4gICAgICBjb25zdCBzdGFja05hbWUgPSBzdGFja01hdGNoID8gc3RhY2tNYXRjaFsxXSA6IGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkIHx8ICcnXG4gICAgICBpZiAob3B0aW9ucy5zdGFja05hbWVzLmxlbmd0aCAmJiAhb3B0aW9ucy5zdGFja05hbWVzLmluY2x1ZGVzKGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkIHx8ICcnKSAmJiAhb3B0aW9ucy5zdGFja05hbWVzLmluY2x1ZGVzKHN0YWNrTmFtZSkpIHtcbiAgICAgICAgY29udGludWVcbiAgICAgIH1cbiAgICAgIGlmICghZXhwb3J0T2JqLk5hbWU/Lm1hdGNoKC9eQ2xvdUROUzovKSkgY29udGludWVcblxuICAgICAgY29uc3QgeyByZXNvdXJjZVR5cGUsIHJlc291cmNlTmFtZSB9ID0gcGFyc2VFeHBvcnROYW1lKGV4cG9ydE9iai5OYW1lKVxuICAgICAgY29uc3QgeyB2YWx1ZSwgcHJpb3JpdHkgfSA9IHBhcnNlRXhwb3J0VmFsdWUoZXhwb3J0T2JqLk5hbWUsIHJlc291cmNlVHlwZSwgZXhwb3J0T2JqLlZhbHVlISlcbiAgICAgIGNvbnN0IHsgem9uZU5hbWUsIGhvc3ROYW1lIH0gPSBhd2FpdCBhdXRvRGV0ZWN0Q2xvdWRuc0hvc3RBbmRab25lKG9wdGlvbnMudXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgcmVzb3VyY2VOYW1lLCB6b25lQ2FjaGUpXG4gICAgICBtYXRjaGVkU3RhY2tzLmFkZChzdGFja05hbWUpXG4gICAgICBtYXRjaGVkU3RhY2tOYW1lcy5hZGQoc3RhY2tOYW1lKVxuICAgICAgaWYgKGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkKSBtYXRjaGVkU3RhY2tzLmFkZChleHBvcnRPYmouRXhwb3J0aW5nU3RhY2tJZClcbiAgICAgIGRlc2lyZWQucHVzaCh7XG4gICAgICAgIHpvbmVOYW1lLFxuICAgICAgICBob3N0TmFtZSxcbiAgICAgICAgdHlwZTogcmVzb3VyY2VUeXBlLFxuICAgICAgICB2YWx1ZSxcbiAgICAgICAgLi4uKHByaW9yaXR5ICE9PSB1bmRlZmluZWQgPyB7IHByaW9yaXR5IH0gOiB7fSksXG4gICAgICAgIHN0YWNrTmFtZSxcbiAgICAgICAgZXhwb3J0TmFtZTogZXhwb3J0T2JqLk5hbWUsXG4gICAgICB9KVxuICAgIH1cbiAgICBuZXh0VG9rZW4gPSByZXNwb25zZS5OZXh0VG9rZW5cbiAgfSB3aGlsZSAobmV4dFRva2VuKVxuXG4gIC8qKlxuICAgKiBBIC0tc3RhY2sgdGhhdCBtYXRjaGVkIG5vdGhpbmcgaXMgbmVhcmx5IGFsd2F5cyBhIHR5cG8gb3IgYSBzdGFjayB0aGF0IGhhcyBub3QgZGVwbG95ZWQgeWV0LlxuICAgKiBJdCB1c2VkIHRvIHBhc3Mgc2lsZW50bHkgYXMgYSBuby1vcDsgd2l0aCAtLXBydW5lIHRoZSBzYW1lIGNvbmRpdGlvbiB3b3VsZCBsb29rIGxpa2UgXCJldmVyeVxuICAgKiByZWNvcmQgaXMgYW4gb3JwaGFuXCIsIHNvIGl0IGlzIGZhdGFsIHRoZXJlIGFuZCBhIHdhcm5pbmcgb3RoZXJ3aXNlLlxuICAgKlxuICAgKiAtLWZvcmNlLXBydW5lIGlzIHRoZSBleGNlcHRpb246IGEgdG9ybi1kb3duIHN0YWNrIHByb2R1Y2luZyBubyBleHBvcnRzIGlzIHByZWNpc2VseSB0aGUgY2FzZSBpdFxuICAgKiBleGlzdHMgZm9yLCBhbmQgdGhlIGNhbGxlciBoYXMgYWxyZWFkeSBoYWQgdG8gbmFtZSB0aGUgem9uZSBleHBsaWNpdGx5IHRvIGdldCB0aGlzIGZhci5cbiAgICovXG4gIGZvciAoY29uc3Qgc3RhY2tOYW1lIG9mIG9wdGlvbnMuc3RhY2tOYW1lcykge1xuICAgIGlmICghbWF0Y2hlZFN0YWNrcy5oYXMoc3RhY2tOYW1lKSkge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGBTdGFjayAke3N0YWNrTmFtZX0gcHJvZHVjZWQgbm8gQ2xvdUROUyBleHBvcnRzYFxuICAgICAgaWYgKG9wdGlvbnMucHJ1bmUgJiYgIW9wdGlvbnMuZm9yY2VQcnVuZSkgdGhyb3cgbmV3IEVycm9yKGAke21lc3NhZ2V9OyByZWZ1c2luZyB0byBwcnVuZSBvbiBhbiB1bnZlcmlmaWVkIHN0YWNrIG5hbWVgKVxuICAgICAgY29uc29sZS53YXJuKCdXQVJOJywgbWVzc2FnZSlcbiAgICB9XG4gIH1cblxuICBmb3IgKGNvbnN0IHJlY29yZCBvZiBkZXNpcmVkKSB7XG4gICAgYXdhaXQgY3JlYXRlT3JVcGRhdGVDbG91ZG5zUmVzb3VyY2Uob3B0aW9ucy51c2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCByZWNvcmQsIG9wdGlvbnMudHRsLCBvcHRpb25zLmRyeVJ1bilcbiAgfVxuXG4gIGlmICghb3B0aW9ucy5wcnVuZSkgcmV0dXJuXG5cbiAgaWYgKCFkZXNpcmVkLmxlbmd0aCAmJiAhb3B0aW9ucy5mb3JjZVBydW5lKSB7XG4gICAgY29uc29sZS53YXJuKCdXQVJOIE5vIGV4cG9ydHMgbWF0Y2hlZCwgc28gbm90aGluZyBpcyBrbm93biB0byBiZSB3YW50ZWQ7IHNraXBwaW5nIHBydW5lLiBVc2UgLS1mb3JjZS1wcnVuZSB3aXRoIC0tem9uZSBpZiB0aGlzIGlzIGEgdGVhcmRvd24uJylcbiAgICByZXR1cm5cbiAgfVxuXG4gIGNvbnN0IHpvbmVOYW1lcyA9IFsuLi5uZXcgU2V0KFsuLi5vcHRpb25zLnpvbmVOYW1lcywgLi4uZGVzaXJlZC5tYXAoKHJlY29yZCkgPT4gcmVjb3JkLnpvbmVOYW1lKV0pXVxuICAvKipcbiAgICogTm90ZXMgcmVjb3JkIHRoZSBzaG9ydCBzdGFjayBuYW1lLCBzbyBzY29waW5nIG9uIHRoZSByYXcgLS1zdGFjayB2YWx1ZXMgd291bGQgc2lsZW50bHkgcHJ1bmVcbiAgICogbm90aGluZyB3aGVuIG9uZSB3YXMgZ2l2ZW4gYXMgYW4gQVJOLiBCb3RoIHNwZWxsaW5ncyBnbyBpbjogdGhlIHJlc29sdmVkIG5hbWVzIGNvdmVyIHRoZSBBUk5cbiAgICogY2FzZSwgYW5kIHRoZSByYXcgdmFsdWVzIGNvdmVyIC0tZm9yY2UtcHJ1bmUsIHdoZXJlIGEgdG9ybi1kb3duIHN0YWNrIHJlc29sdmVzIHRvIG5vdGhpbmcuXG4gICAqL1xuICBjb25zdCBzdGFja1Njb3BlID0gb3B0aW9ucy5zdGFja05hbWVzLmxlbmd0aCA/IG5ldyBTZXQoWy4uLm1hdGNoZWRTdGFja05hbWVzLCAuLi5vcHRpb25zLnN0YWNrTmFtZXNdKSA6IHVuZGVmaW5lZFxuICBhd2FpdCBwcnVuZU9ycGhhbnMob3B0aW9ucy51c2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCB6b25lTmFtZXMsIGRlc2lyZWQsIHN0YWNrU2NvcGUsIG9wdGlvbnMpXG59XG4iXX0=