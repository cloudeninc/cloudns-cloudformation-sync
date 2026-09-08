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
  -p, --password-parameter <ssm>  SSM parameter holding the encrypted ClouDNS API password
  -t, --ttl <seconds>           TTL for generated records (default 300)
  -s, --stack <name>            Limit to this CloudFormation stack; repeatable
  -z, --zone <name>             Also scan this zone when pruning; repeatable
      --prune                   Delete managed records whose export is gone
      --force-prune             Also prune when no exports were found; requires --zone
      --max-prune <n>           Most records one run may delete (default ${DEFAULT_MAX_PRUNE})
  -n, --dry-run                 Report what would change without changing it
  -h, --help                    Show this help
  -V, --version                 Show the version

AWS_PROFILE selects the AWS credentials, as usual.`;
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
            case '--max-prune':
                options.maxPrune = parseInt(next(i, arg), 10);
                i++;
                break;
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
/** Every record in a zone, notes included. Also the basis for finding orphans. */
async function listZoneRecords(cloudnsUsername, cloudnsPassword, zoneName) {
    const response = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/records.json', {
        'domain-name': zoneName,
        'include-notes': '1',
    });
    // An empty zone comes back as an empty array rather than an empty object.
    if (!response || Array.isArray(response))
        return [];
    return Object.values(response);
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
    const records = await listZoneRecords(cloudnsUsername, cloudnsPassword, desired.zoneName);
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
async function pruneOrphans(cloudnsUsername, cloudnsPassword, zoneNames, desired, options) {
    const desiredKeys = new Set(desired.map((record) => `${record.zoneName}|${record.hostName}|${record.type}`));
    const orphans = [];
    for (const zoneName of zoneNames) {
        for (const record of await listZoneRecords(cloudnsUsername, cloudnsPassword, zoneName)) {
            const stack = noteStackName(record);
            if (stack === undefined)
                continue; // not ours
            if (options.stackNames.length && !options.stackNames.includes(stack))
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
    if (orphans.length > options.maxPrune) {
        throw new Error(`Refusing to delete ${orphans.length} records in one run (limit ${options.maxPrune}); raise --max-prune if this is intended`);
    }
    if (options.dryRun)
        return;
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
    console.log('ClouDNS CloudFormation Sync by Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020-2026');
    const options = parseArgs(process.argv.slice(2));
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
    const matchedStacks = new Set();
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
     * It used to pass silently as a no-op; with pruning enabled the same condition would look like
     * "every record is an orphan", so it is fatal there and a warning otherwise.
     */
    for (const stackName of options.stackNames) {
        if (!matchedStacks.has(stackName)) {
            const message = `Stack ${stackName} produced no ClouDNS exports`;
            if (options.prune)
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
    await pruneOrphans(options.username, cloudnsPassword, zoneNames, desired, options);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXVDRztBQUNILG9EQUFvRTtBQUNwRSwwRUFBNEc7QUFDNUcsTUFBWSxXQUFXLHdDQUFtQjtBQUUxQyxxQkFBcUI7QUFDckIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsR0FBRyxHQUFHLENBQUE7QUFFckMscUZBQXFGO0FBQ3JGLE1BQU0sV0FBVyxHQUFHLHdDQUF3QyxDQUFBO0FBRTVELDBHQUEwRztBQUMxRyxNQUFNLGlCQUFpQixHQUFHLEVBQUUsQ0FBQTtBQWtDNUIsTUFBTSxLQUFLLEdBQUc7Ozs7Ozs7Ozs7OzsyRUFZNkQsaUJBQWlCOzs7OzttREFLekMsQ0FBQTtBQUVuRCxtQkFBMEIsSUFBYztJQUN0QyxNQUFNLE9BQU8sR0FBWTtRQUN2QixRQUFRLEVBQUUsRUFBRTtRQUNaLGlCQUFpQixFQUFFLEVBQUU7UUFDckIsR0FBRyxFQUFFLEtBQUs7UUFDVixVQUFVLEVBQUUsRUFBRTtRQUNkLFNBQVMsRUFBRSxFQUFFO1FBQ2IsS0FBSyxFQUFFLEtBQUs7UUFDWixVQUFVLEVBQUUsS0FBSztRQUNqQixRQUFRLEVBQUUsaUJBQWlCO1FBQzNCLE1BQU0sRUFBRSxLQUFLO0tBQ2QsQ0FBQTtJQUVEOzs7O09BSUc7SUFDSCxJQUFJLElBQUksQ0FBQyxNQUFNLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDNUMsT0FBTyxDQUFDLFFBQVEsR0FBRyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUE7UUFDMUIsT0FBTyxDQUFD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QUFNLE9BQU8sR0FBRyxTQUFTLFNBQVMsOEJBQThCLENBQUE7WUFDaEUsSUFBSSxPQUFPLENBQUMsS0FBSztnQkFBRSxNQUFNLElBQUksS0FBSyxDQUFDLEdBQUcsT0FBTyxpREFBaUQsQ0FBQyxDQUFBO1lBQy9GLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxDQUFBO1FBQy9CLENBQUM7SUFDSCxDQUFDO0lBRUQsS0FBSyxNQUFNLE1BQU0sSUFBSSxPQUFPLEVBQUUsQ0FBQztRQUM3QixNQUFNLDZCQUE2QixDQUFDLE9BQU8sQ0FBQyxRQUFRLEVBQUUsZUFBZSxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxFQUFFLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQTtJQUM3RyxDQUFDO0lBRUQsSUFBSSxDQUFDLE9BQU8sQ0FBQyxLQUFLO1FBQUUsT0FBTTtJQUUxQixJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sSUFBSSxDQUFDLE9BQU8sQ0FBQyxVQUFVLEVBQUUsQ0FBQztRQUMzQyxPQUFPLENBQUMsSUFBSSxDQUFDLGlJQUFpSSxDQUFDLENBQUE7UUFDL0ksT0FBTTtJQUNSLENBQUM7SUFFRCxNQUFNLFNBQVMsR0FBRyxDQUFDLEdBQUcsSUFBSSxHQUFHLENBQUMsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxTQUFTLEVBQUUsR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxFQUFFLEVBQUUsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUE7SUFDbkcsTUFBTSxZQUFZLENBQUMsT0FBTyxDQUFDLFFBQVEsRUFBRSxlQUFlLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQTtBQUNwRixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZWFkIEFXUyBDbG91ZEZvcm1hdGlvbiBFeHBvcnRzIGFuZCBhdXRvZ2VuZXJhdGUgQ2xvdUROUyByZWNvcmRzIGJhc2VkIG9uIHRoZWlyIG5hbWVzIGFuZCB2YWx1ZXMuXG4gKiBLZW5uZXRoIEZhbGNrIDxrZW5udUBjbG91ZGVuLm5ldD4gKEMpIENsb3VkZW4gT3kgMjAyMC0yMDI2XG4gKlxuICogVGhpcyB0b29sIGNhbiBiZSB1c2VkIHRvIGF1dG9nZW5lcmF0ZSBDbG91RE5TIHJlY29yZHMgZm9yIENsb3VkRm9ybWF0aW9uIHJlc291cmNlcyBsaWtlXG4gKiBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbnMgYW5kIEFQSSBHYXRld2F5IGRvbWFpbnMuXG4gKlxuICogQ2xvdWRGb3JtYXRpb24gZXhwb3J0IG5hbWUgbXVzdCBzcGVjaWZ5IHRoZSByZXNvdXJjZSB0eXBlIGFuZCByZWNvcmQgaG9zdG5hbWUgYXMgZm9sbG93czpcbiAqIENsb3VETlM6Q05BTUU6bXlob3N0OmV4YW1wbGU6b3JnXG4gKlxuICogQ2xvdWRGb3JtYXRpb24gZXhwb3J0IHZhbHVlIG11c3Qgc3BlY2lmeSB0aGUgcmVjb3JkIHZhbHVlIGFzLWlzIChmb3IgaW5zdGFuY2UsIGEgZGlzdHJpYnV0aW9uIGRvbWFpbiBuYW1lKTpcbiAqIHh4eHh4eHh4eHh4eHh4LmNsb3VkZnJvbnQubmV0XG4gKlxuICogVGhlIGFib3ZlIGV4YW1wbGUgd2lsbCBnZW5lcmF0ZSB0aGUgZm9sbG93aW5nIHJlY29yZCBpbiB0aGUgQ2xvdUROUyB6b25lIGV4YW1wbGUub3JnOlxuICogbXlob3N0LmV4YW1wbGUub3JnIENOQU1FIHh4eHh4eHh4eHh4eHh4LmNsb3VkZnJvbnQubmV0XG4gKlxuICogT3RoZXIgcmVzb3VyY2UgdHlwZXMgYXJlIGFsc28gYWxsb3dlZCAoQSwgQUFBQSwgQUxJQVMsIGV0YykuXG4gKlxuICogIyMgT3duZXJzaGlwIGFuZCBwcnVuaW5nXG4gKlxuICogRXZlcnkgcmVjb3JkIHRoaXMgdG9vbCB3cml0ZXMgaXMgc3RhbXBlZCB3aXRoIGEgQ2xvdUROUyByZWNvcmQgbm90ZSBuYW1pbmcgdGhlIHRvb2wsIHRoZSBzdGFja1xuICogd2hvc2UgZXhwb3J0IHByb2R1Y2VkIGl0LCBhbmQgdGhhdCBleHBvcnQuIFRoZSBub3RlIGlzIHdoYXQgbWFrZXMgZGVsZXRpb24gc2FmZTogYSB6b25lIGhvbGRzXG4gKiBwbGVudHkgb2YgcmVjb3JkcyBub2JvZHkgaGVyZSBjcmVhdGVkLCBhbmQgd2l0aG91dCBhIG1hcmtlciB0aGVyZSBpcyBubyB3YXkgdG8gdGVsbCBhbiBvcnBoYW5cbiAqIGxlZnQgYmVoaW5kIGJ5IGEgZGVsZXRlZCBleHBvcnQgZnJvbSBzb21ldGhpbmcgYSBodW1hbiBhZGRlZCBieSBoYW5kLiBSZWNvcmRzIHdpdGhvdXQgdGhlIG1hcmtlclxuICogYXJlIG5ldmVyIGNhbmRpZGF0ZXMgZm9yIGRlbGV0aW9uLlxuICpcbiAqIFN0YW1waW5nIGhhcHBlbnMgb24gZXZlcnkgc3luYywgc28gcmVjb3JkcyBjcmVhdGVkIGJlZm9yZSB0aGlzIGZlYXR1cmUgYXJlIGFkb3B0ZWQgdGhlIG5leHQgdGltZVxuICogdGhleSBhcmUgc2Vlbi4gVGhhdCBpcyBzYWZlIGJlY2F1c2UgYSByZWNvcmQgaXMgb25seSBldmVyIHN0YW1wZWQgd2hlbiBhbiBleHBvcnQgY3VycmVudGx5IGNsYWltc1xuICogaXQg4oCUIHRoZSB0b29sIGlzIGFscmVhZHkgb3ZlcndyaXRpbmcgdGhhdCByZWNvcmQncyB2YWx1ZSwgc28gaXQgYWxyZWFkeSBvd25zIGl0LlxuICpcbiAqIFBydW5pbmcgaXMgb3B0LWluIGFuZCBuZXZlciBoYXBwZW5zIGJ5IGFjY2lkZW50OlxuICpcbiAqICAgLS1wcnVuZSAgICAgICAgZGVsZXRlIG1hbmFnZWQgcmVjb3JkcyB3aG9zZSBleHBvcnQgaXMgZ29uZSwgYnV0IG9ubHkgd2hlbiB0aGlzIHJ1biBhY3R1YWxseVxuICogICAgICAgICAgICAgICAgICBmb3VuZCBleHBvcnRzLiBBbiBlbXB0eSBleHBvcnQgc2V0IGlzIGZhciBtb3JlIGxpa2VseSBhIHdyb25nIC0tc3RhY2sgb3IgYW4gQVdTXG4gKiAgICAgICAgICAgICAgICAgIGVycm9yIHRoYW4gYSBnZW51aW5lIGluc3RydWN0aW9uIHRvIGRlbGV0ZSBldmVyeSByZWNvcmQuXG4gKiAgIC0tZm9yY2UtcHJ1bmUgIGFsc28gcHJ1bmUgd2hlbiB0aGUgZXhwb3J0IHNldCBpcyBlbXB0eSwgZm9yIHRoZSByZWFsIHRlYXJkb3duIGNhc2UuIFJlcXVpcmVzIGFuXG4gKiAgICAgICAgICAgICAgICAgIGV4cGxpY2l0IC0tem9uZSwgYmVjYXVzZSB3aXRoIG5vIGV4cG9ydHMgdGhlcmUgaXMgbm90aGluZyB0byBpbmZlciBhIHpvbmUgZnJvbS5cbiAqXG4gKiBBIGNhcCBvbiBob3cgbWFueSByZWNvcmRzIG9uZSBydW4gbWF5IGRlbGV0ZSBhcHBsaWVzIHRvIGJvdGguXG4gKi9cbmltcG9ydCB7IFNTTUNsaWVudCwgR2V0UGFyYW1ldGVyQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zc20nXG5pbXBvcnQgeyBDbG91ZEZvcm1hdGlvbkNsaWVudCwgTGlzdEV4cG9ydHNDb21tYW5kLCBMaXN0RXhwb3J0c091dHB1dCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1jbG91ZGZvcm1hdGlvbidcbmltcG9ydCAqIGFzIHF1ZXJ5c3RyaW5nIGZyb20gJ3F1ZXJ5c3RyaW5nJ1xuXG4vLyBMb2FkIH4vLmF3cy9jb25maWdcbnByb2Nlc3MuZW52LkFXU19TREtfTE9BRF9DT05GSUcgPSAnMSdcblxuLyoqIE1hcmtzIGEgcmVjb3JkIGFzIG91cnMuIFByZXNlbnQgaW4gdGhlIG5vdGUgb2YgZXZlcnkgcmVjb3JkIHRoaXMgdG9vbCBtYW5hZ2VzLiAqL1xuY29uc3QgTk9URV9NQVJLRVIgPSAnbWFuYWdlZC1ieT1jbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMnXG5cbi8qKiBNb3N0IHJlY29yZHMgb25lIHJ1biB3aWxsIGRlbGV0ZSBiZWZvcmUgcmVmdXNpbmcuIFJhaXNlIHdpdGggLS1tYXgtcHJ1bmUgd2hlbiBpdCBpcyBnZW51aW5lbHkgbW9yZS4gKi9cbmNvbnN0IERFRkFVTFRfTUFYX1BSVU5FID0gMTBcblxudHlwZSBDbG91ZG5zUmVzdENhbGxSZXNwb25zZSA9IGFueVxuXG5pbnRlcmZhY2UgT3B0aW9ucyB7XG4gIHVzZXJuYW1lOiBzdHJpbmdcbiAgcGFzc3dvcmRQYXJhbWV0ZXI6IHN0cmluZ1xuICB0dGw6IHN0cmluZ1xuICBzdGFja05hbWVzOiBzdHJpbmdbXVxuICB6b25lTmFtZXM6IHN0cmluZ1tdXG4gIHBydW5lOiBib29sZWFuXG4gIGZvcmNlUHJ1bmU6IGJvb2xlYW5cbiAgbWF4UHJ1bmU6IG51bWJlclxuICBkcnlSdW46IGJvb2xlYW5cbn1cblxuaW50ZXJmYWNlIERlc2lyZWRSZWNvcmQge1xuICB6b25lTmFtZTogc3RyaW5nXG4gIGhvc3ROYW1lOiBzdHJpbmdcbiAgdHlwZTogc3RyaW5nXG4gIHZhbHVlOiBzdHJpbmdcbiAgc3RhY2tOYW1lOiBzdHJpbmdcbiAgZXhwb3J0TmFtZTogc3RyaW5nXG59XG5cbmludGVyZmFjZSBDbG91ZG5zUmVjb3JkIHtcbiAgaWQ6IHN0cmluZ1xuICBob3N0OiBzdHJpbmdcbiAgdHlwZTogc3RyaW5nXG4gIHR0bDogc3RyaW5nXG4gIHJlY29yZDogc3RyaW5nXG4gIG5vdGU/OiBzdHJpbmdcbn1cblxuY29uc3QgVVNBR0UgPSBgQ2xvdUROUyBDbG91ZEZvcm1hdGlvbiBTeW5jXG5cblVzYWdlOiBjbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMgLXUgPHVzZXJuYW1lPiAtcCA8cGFzc3dvcmQtcGFyYW1ldGVyPiBbb3B0aW9uc11cbiAgICAgICBjbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMgPHVzZXJuYW1lPiA8cGFzc3dvcmQtcGFyYW1ldGVyPiBbdHRsIFtzdGFjay4uLl1dICAgKGxlZ2FjeSlcblxuICAtdSwgLS11c2VybmFtZSA8bmFtZT4gICAgICAgICBDbG91RE5TIEFQSSBzdWItYXV0aC11c2VyXG4gIC1wLCAtLXBhc3N3b3JkLXBhcmFtZXRlciA8c3NtPiAgU1NNIHBhcmFtZXRlciBob2xkaW5nIHRoZSBlbmNyeXB0ZWQgQ2xvdUROUyBBUEkgcGFzc3dvcmRcbiAgLXQsIC0tdHRsIDxzZWNvbmRzPiAgICAgICAgICAgVFRMIGZvciBnZW5lcmF0ZWQgcmVjb3JkcyAoZGVmYXVsdCAzMDApXG4gIC1zLCAtLXN0YWNrIDxuYW1lPiAgICAgICAgICAgIExpbWl0IHRvIHRoaXMgQ2xvdWRGb3JtYXRpb24gc3RhY2s7IHJlcGVhdGFibGVcbiAgLXosIC0tem9uZSA8bmFtZT4gICAgICAgICAgICAgQWxzbyBzY2FuIHRoaXMgem9uZSB3aGVuIHBydW5pbmc7IHJlcGVhdGFibGVcbiAgICAgIC0tcHJ1bmUgICAgICAgICAgICAgICAgICAgRGVsZXRlIG1hbmFnZWQgcmVjb3JkcyB3aG9zZSBleHBvcnQgaXMgZ29uZVxuICAgICAgLS1mb3JjZS1wcnVuZSAgICAgICAgICAgICBBbHNvIHBydW5lIHdoZW4gbm8gZXhwb3J0cyB3ZXJlIGZvdW5kOyByZXF1aXJlcyAtLXpvbmVcbiAgICAgIC0tbWF4LXBydW5lIDxuPiAgICAgICAgICAgTW9zdCByZWNvcmRzIG9uZSBydW4gbWF5IGRlbGV0ZSAoZGVmYXVsdCAke0RFRkFVTFRfTUFYX1BSVU5FfSlcbiAgLW4sIC0tZHJ5LXJ1biAgICAgICAgICAgICAgICAgUmVwb3J0IHdoYXQgd291bGQgY2hhbmdlIHdpdGhvdXQgY2hhbmdpbmcgaXRcbiAgLWgsIC0taGVscCAgICAgICAgICAgICAgICAgICAgU2hvdyB0aGlzIGhlbHBcbiAgLVYsIC0tdmVyc2lvbiAgICAgICAgICAgICAgICAgU2hvdyB0aGUgdmVyc2lvblxuXG5BV1NfUFJPRklMRSBzZWxlY3RzIHRoZSBBV1MgY3JlZGVudGlhbHMsIGFzIHVzdWFsLmBcblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhhcmd2OiBzdHJpbmdbXSk6IE9wdGlvbnMge1xuICBjb25zdCBvcHRpb25zOiBPcHRpb25zID0ge1xuICAgIHVzZXJuYW1lOiAnJyxcbiAgICBwYXNzd29yZFBhcmFtZXRlcjogJycsXG4gICAgdHRsOiAnMzAwJyxcbiAgICBzdGFja05hbWVzOiBbXSxcbiAgICB6b25lTmFtZXM6IFtdLFxuICAgIHBydW5lOiBmYWxzZSxcbiAgICBmb3JjZVBydW5lOiBmYWxzZSxcbiAgICBtYXhQcnVuZTogREVGQVVMVF9NQVhfUFJVTkUsXG4gICAgZHJ5UnVuOiBmYWxzZSxcbiAgfVxuXG4gIC8qKlxuICAgKiBBbnl0aGluZyBub3Qgc3RhcnRpbmcgd2l0aCBcIi1cIiBpbiB0aGUgZmlyc3QgcG9zaXRpb24gaXMgdGhlIG9sZCBwb3NpdGlvbmFsIGZvcm06XG4gICAqIDx1c2VybmFtZT4gPHBhc3N3b3JkLXBhcmFtZXRlcj4gW3R0bCBbc3RhY2suLi5dXS4gS2VwdCB3b3JraW5nIHNvIGV4aXN0aW5nIGRlcGxveSBzY3JpcHRzIGFuZFxuICAgKiBDSSBqb2JzIGRvIG5vdCBoYXZlIHRvIGNoYW5nZSBpbiB0aGUgc2FtZSByZWxlYXNlIHRoYXQgYWRkcyBwcnVuaW5nLlxuICAgKi9cbiAgaWYgKGFyZ3YubGVuZ3RoICYmICFhcmd2WzBdLnN0YXJ0c1dpdGgoJy0nKSkge1xuICAgIG9wdGlvbnMudXNlcm5hbWUgPSBhcmd2WzBdXG4gICAgb3B0aW9ucy5wYXNzd29yZFBhcmFtZXRlciA9IGFyZ3ZbMV0gfHwgJydcbiAgICAvKipcbiAgICAgKiBPcHRpb25zIGFyZSBzdGlsbCBob25vdXJlZCBhZnRlciB0aGUgcG9zaXRpb25hbCBhcmd1bWVudHMuIFRyZWF0aW5nIGEgdHJhaWxpbmcgXCItblwiIGFzIGFcbiAgICAgKiBzdGFjayBuYW1lIGluc3RlYWQgaXMgaG93IGEgcnVuIHRoZSBjYWxsZXIgYmVsaWV2ZWQgd2FzIGEgcmVoZWFyc2FsIHdyaXRlcyBmb3IgcmVhbCDigJQgd2hpY2hcbiAgICAgKiBpcyBleGFjdGx5IHdoYXQgaGFwcGVuZWQgdGhlIGZpcnN0IHRpbWUgdGhpcyB3YXMgdGVzdGVkLlxuICAgICAqL1xuICAgIGNvbnN0IHJlc3QgPSBhcmd2LnNsaWNlKDIpXG4gICAgY29uc3QgZmxhZ0luZGV4ID0gcmVzdC5maW5kSW5kZXgoKGFyZykgPT4gYXJnLnN0YXJ0c1dpdGgoJy0nKSlcbiAgICBjb25zdCBwb3NpdGlvbmFsID0gZmxhZ0luZGV4ID09PSAtMSA/IHJlc3QgOiByZXN0LnNsaWNlKDAsIGZsYWdJbmRleClcbiAgICBpZiAocG9zaXRpb25hbFswXSkgb3B0aW9ucy50dGwgPSBwb3NpdGlvbmFsWzBdXG4gICAgb3B0aW9ucy5zdGFja05hbWVzID0gcG9zaXRpb25hbC5zbGljZSgxKVxuICAgIGlmIChmbGFnSW5kZXggIT09IC0xKSBhcHBseUZsYWdzKHJlc3Quc2xpY2UoZmxhZ0luZGV4KSwgb3B0aW9ucylcbiAgICByZXR1cm4gb3B0aW9uc1xuICB9XG5cbiAgYXBwbHlGbGFncyhhcmd2LCBvcHRpb25zKVxuICByZXR1cm4gb3B0aW9uc1xufVxuXG5mdW5jdGlvbiBhcHBseUZsYWdzKGFyZ3Y6IHN0cmluZ1tdLCBvcHRpb25zOiBPcHRpb25zKTogdm9pZCB7XG4gIGNvbnN0IG5leHQgPSAoaW5kZXg6IG51bWJlciwgZmxhZzogc3RyaW5nKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCB2YWx1ZSA9IGFyZ3ZbaW5kZXggKyAxXVxuICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlLnN0YXJ0c1dpdGgoJy0nKSkgdGhyb3cgbmV3IEVycm9yKGBNaXNzaW5nIHZhbHVlIGZvciAke2ZsYWd9YClcbiAgICByZXR1cm4gdmFsdWVcbiAgfVxuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJndi5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGFyZyA9IGFyZ3ZbaV1cbiAgICBzd2l0Y2ggKGFyZykge1xuICAgICAgY2FzZSAnLXUnOlxuICAgICAgY2FzZSAnLS11c2VybmFtZSc6XG4gICAgICAgIG9wdGlvbnMudXNlcm5hbWUgPSBuZXh0KGksIGFyZylcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctcCc6XG4gICAgICBjYXNlICctLXBhc3N3b3JkLXBhcmFtZXRlcic6XG4gICAgICAgIG9wdGlvbnMucGFzc3dvcmRQYXJhbWV0ZXIgPSBuZXh0KGksIGFyZylcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctdCc6XG4gICAgICBjYXNlICctLXR0bCc6XG4gICAgICAgIG9wdGlvbnMudHRsID0gbmV4dChpLCBhcmcpXG4gICAgICAgIGkrK1xuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLXMnOlxuICAgICAgY2FzZSAnLS1zdGFjayc6XG4gICAgICAgIG9wdGlvbnMuc3RhY2tOYW1lcy5wdXNoKG5leHQoaSwgYXJnKSlcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICcteic6XG4gICAgICBjYXNlICctLXpvbmUnOlxuICAgICAgICBvcHRpb25zLnpvbmVOYW1lcy5wdXNoKG5leHQoaSwgYXJnKSlcbiAgICAgICAgaSsrXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctLXBydW5lJzpcbiAgICAgICAgb3B0aW9ucy5wcnVuZSA9IHRydWVcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy0tZm9yY2UtcHJ1bmUnOlxuICAgICAgICBvcHRpb25zLnBydW5lID0gdHJ1ZVxuICAgICAgICBvcHRpb25zLmZvcmNlUHJ1bmUgPSB0cnVlXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICctLW1heC1wcnVuZSc6XG4gICAgICAgIG9wdGlvbnMubWF4UHJ1bmUgPSBwYXJzZUludChuZXh0KGksIGFyZyksIDEwKVxuICAgICAgICBpKytcbiAgICAgICAgYnJlYWtcbiAgICAgIGNhc2UgJy1uJzpcbiAgICAgIGNhc2UgJy0tZHJ5LXJ1bic6XG4gICAgICAgIG9wdGlvbnMuZHJ5UnVuID0gdHJ1ZVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLWgnOlxuICAgICAgY2FzZSAnLS1oZWxwJzpcbiAgICAgICAgY29uc29sZS5sb2coVVNBR0UpXG4gICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICBicmVha1xuICAgICAgY2FzZSAnLVYnOlxuICAgICAgY2FzZSAnLS12ZXJzaW9uJzpcbiAgICAgICAgY29uc29sZS5sb2cocmVxdWlyZSgnLi4vcGFja2FnZS5qc29uJykudmVyc2lvbilcbiAgICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgICAgIGJyZWFrXG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gb3B0aW9uOiAke2FyZ31gKVxuICAgIH1cbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbG91ZG5zUmVzdENhbGwoXG4gIGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLFxuICBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZyxcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHJlbGF0aXZlVXJsOiBzdHJpbmcsXG4gIHF1ZXJ5T3B0aW9uczogYW55XG4pOiBQcm9taXNlPENsb3VkbnNSZXN0Q2FsbFJlc3BvbnNlPiB7XG4gIGNvbnN0IGZ1bGxVcmwgPVxuICAgICdodHRwczovL2FwaS5jbG91ZG5zLm5ldCcgK1xuICAgIHJlbGF0aXZlVXJsICtcbiAgICAnPycgK1xuICAgIHF1ZXJ5c3RyaW5nLnN0cmluZ2lmeShcbiAgICAgIE9iamVjdC5hc3NpZ24oXG4gICAgICAgIHtcbiAgICAgICAgICAnc3ViLWF1dGgtdXNlcic6IGNsb3VkbnNVc2VybmFtZSxcbiAgICAgICAgICAnYXV0aC1wYXNzd29yZCc6IGNsb3VkbnNQYXNzd29yZCxcbiAgICAgICAgfSxcbiAgICAgICAgcXVlcnlPcHRpb25zIHx8IHt9XG4gICAgICApXG4gICAgKVxuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goZnVsbFVybCwge1xuICAgIG1ldGhvZDogbWV0aG9kLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICB9LFxuICB9KVxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpXG4gICAgY29uc29sZS5lcnJvcignSFRUUCBFcnJvcicsIHJlc3BvbnNlLnN0YXR1cywgcmVzcG9uc2Uuc3RhdHVzVGV4dCwgZXJyb3JUZXh0KVxuICAgIHRocm93IG5ldyBFcnJvcihlcnJvclRleHQpXG4gIH1cbiAgcmV0dXJuIChhd2FpdCByZXNwb25zZS5qc29uKCkpIGFzIENsb3VkbnNSZXN0Q2FsbFJlc3BvbnNlXG59XG5cbi8qKlxuICogQ2xvdUROUyByZXBvcnRzIGZhaWx1cmVzIGluIHRoZSBib2R5IHdpdGggSFRUUCAyMDAsIHNvIGEgY2FsbCBpcyBvbmx5IHN1Y2Nlc3NmdWwgaWYgaXQgc2F5cyBzby5cbiAqXG4gKiBUcmVhdGluZyBcIm5vdCB0aGUgc3RyaW5nIEZhaWxlZFwiIGFzIHN1Y2Nlc3MgaXMgaG93IGEgcmVqZWN0ZWQgd3JpdGUgZ2V0cyByZXBvcnRlZCBhcyBkb25lIOKAlFxuICogY2hlY2tlZCBwb3NpdGl2ZWx5IGhlcmUgaW5zdGVhZC5cbiAqL1xuZnVuY3Rpb24gYXNzZXJ0U3VjY2VzcyhyZXN1bHQ6IGFueSwgd2hhdDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHN0YXR1cyA9IHJlc3VsdD8uc3RhdHVzXG4gIGlmIChzdGF0dXMgPT09ICdTdWNjZXNzJyB8fCBzdGF0dXMgPT09IDEgfHwgc3RhdHVzID09PSAnMScpIHJldHVyblxuICB0aHJvdyBuZXcgRXJyb3IoYCR7d2hhdH0gZmFpbGVkOiAke3Jlc3VsdD8uc3RhdHVzRGVzY3JpcHRpb24gfHwgcmVzdWx0Py5zdGF0dXNNZXNzYWdlIHx8IEpTT04uc3RyaW5naWZ5KHJlc3VsdCl9YClcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXV0b0RldGVjdENsb3VkbnNIb3N0QW5kWm9uZShjbG91ZG5zVXNlcm5hbWU6IHN0cmluZywgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgem9uZUNhY2hlOiBhbnkpIHtcbiAgY29uc3QgbmFtZVBhcnRzID0gbmFtZS5zcGxpdCgnLicpXG5cbiAgLy8gWm9uZSBhbmQgaG9zdCBuYW1lIGZvciB4eHgudGxkXG4gIGNvbnN0IGhvc3ROYW1lMSA9IG5hbWVQYXJ0cy5zbGljZSgwLCBuYW1lUGFydHMubGVuZ3RoIC0gMikuam9pbignLicpXG4gIGNvbnN0IHpvbmVOYW1lMSA9IG5hbWVQYXJ0cy5zbGljZShuYW1lUGFydHMubGVuZ3RoIC0gMikuam9pbignLicpXG5cbiAgLy8gWm9uZSBhbmQgaG9zdCBuYW1lIGZvciB4eHguc3VidGxkLnRsZFxuICBjb25zdCBob3N0TmFtZTIgPSBuYW1lUGFydHMuc2xpY2UoMCwgbmFtZVBhcnRzLmxlbmd0aCAtIDMpLmpvaW4oJy4nKVxuICBjb25zdCB6b25lTmFtZTIgPSBuYW1lUGFydHMuc2xpY2UobmFtZVBhcnRzLmxlbmd0aCAtIDMpLmpvaW4oJy4nKVxuXG4gIC8vIENoZWNrIHdoaWNoIHpvbmUgZXhpc3RzXG4gIGNvbnN0IHpvbmVSZXNwb25zZTEgPVxuICAgIHpvbmVDYWNoZVt6b25lTmFtZTFdIHx8XG4gICAgKGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ0dFVCcsICcvZG5zL2dldC16b25lLWluZm8uanNvbicsIHtcbiAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lMSxcbiAgICB9KSlcbiAgem9uZUNhY2hlW3pvbmVOYW1lMV0gPSB6b25lUmVzcG9uc2UxXG4gIGNvbnN0IHpvbmVSZXNwb25zZTIgPVxuICAgIHpvbmVDYWNoZVt6b25lTmFtZTJdIHx8XG4gICAgKGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ0dFVCcsICcvZG5zL2dldC16b25lLWluZm8uanNvbicsIHtcbiAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lMixcbiAgICB9KSlcbiAgem9uZUNhY2hlW3pvbmVOYW1lMl0gPSB6b25lUmVzcG9uc2UyXG5cbiAgY29uc3Qgem9uZU5hbWUgPSB6b25lUmVzcG9uc2UxLnN0YXR1cyA9PT0gJzEnID8gem9uZU5hbWUxIDogem9uZVJlc3BvbnNlMi5zdGF0dXMgPT09ICcxJyA/IHpvbmVOYW1lMiA6ICcnXG4gIGNvbnN0IGhvc3ROYW1lID0gem9uZVJlc3BvbnNlMS5zdGF0dXMgPT09ICcxJyA/IGhvc3ROYW1lMSA6IHpvbmVSZXNwb25zZTIuc3RhdHVzID09PSAnMScgPyBob3N0TmFtZTIgOiAnJ1xuICBpZiAoIXpvbmVOYW1lKSB7XG4gICAgLy8gTmVpdGhlciB6b25lIGV4aXN0c1xuICAgIHRocm93IG5ldyBFcnJvcignWm9uZSBOb3QgRm91bmQ6ICcgKyBuYW1lKVxuICB9XG4gIHJldHVybiB7XG4gICAgaG9zdE5hbWU6IGhvc3ROYW1lLFxuICAgIHpvbmVOYW1lOiB6b25lTmFtZSxcbiAgfVxufVxuXG4vKiogRXZlcnkgcmVjb3JkIGluIGEgem9uZSwgbm90ZXMgaW5jbHVkZWQuIEFsc28gdGhlIGJhc2lzIGZvciBmaW5kaW5nIG9ycGhhbnMuICovXG5hc3luYyBmdW5jdGlvbiBsaXN0Wm9uZVJlY29yZHMoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCB6b25lTmFtZTogc3RyaW5nKTogUHJvbWlzZTxDbG91ZG5zUmVjb3JkW10+IHtcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdHRVQnLCAnL2Rucy9yZWNvcmRzLmpzb24nLCB7XG4gICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgJ2luY2x1ZGUtbm90ZXMnOiAnMScsXG4gIH0pXG4gIC8vIEFuIGVtcHR5IHpvbmUgY29tZXMgYmFjayBhcyBhbiBlbXB0eSBhcnJheSByYXRoZXIgdGhhbiBhbiBlbXB0eSBvYmplY3QuXG4gIGlmICghcmVzcG9uc2UgfHwgQXJyYXkuaXNBcnJheShyZXNwb25zZSkpIHJldHVybiBbXVxuICByZXR1cm4gT2JqZWN0LnZhbHVlcyhyZXNwb25zZSkgYXMgQ2xvdWRuc1JlY29yZFtdXG59XG5cbmZ1bmN0aW9uIG93bmVyc2hpcE5vdGUoc3RhY2tOYW1lOiBzdHJpbmcsIGV4cG9ydE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtOT1RFX01BUktFUn0gc3RhY2s9JHtzdGFja05hbWV9IGV4cG9ydD0ke2V4cG9ydE5hbWV9YFxufVxuXG4vKiogVGhlIHN0YWNrIG5hbWVkIGluIGEgcmVjb3JkJ3Mgbm90ZSwgb3IgdW5kZWZpbmVkIHdoZW4gdGhlIHJlY29yZCBpcyBub3Qgb3Vycy4gKi9cbmZ1bmN0aW9uIG5vdGVTdGFja05hbWUocmVjb3JkOiBDbG91ZG5zUmVjb3JkKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFyZWNvcmQubm90ZSB8fCByZWNvcmQubm90ZS5pbmRleE9mKE5PVEVfTUFSS0VSKSA9PT0gLTEpIHJldHVybiB1bmRlZmluZWRcbiAgY29uc3QgbWF0Y2ggPSAvc3RhY2s9KFxcUyspLy5leGVjKHJlY29yZC5ub3RlKVxuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFsxXSA6ICcnXG59XG5cbmFzeW5jIGZ1bmN0aW9uIHNldFJlY29yZE5vdGUoXG4gIGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLFxuICBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZyxcbiAgem9uZU5hbWU6IHN0cmluZyxcbiAgcmVjb3JkSWQ6IHN0cmluZyxcbiAgbm90ZTogc3RyaW5nLFxuICBkcnlSdW46IGJvb2xlYW5cbik6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoZHJ5UnVuKSByZXR1cm5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnUE9TVCcsICcvZG5zL3NldC1yZWNvcmQtbm90ZS5qc29uJywge1xuICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICdyZWNvcmQtaWQnOiByZWNvcmRJZCxcbiAgICBub3RlOiBub3RlLFxuICB9KVxuICBhc3NlcnRTdWNjZXNzKHJlc3VsdCwgJ1NldCByZWNvcmQgbm90ZScpXG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNyZWF0ZU9yVXBkYXRlQ2xvdWRuc1Jlc291cmNlKFxuICBjbG91ZG5zVXNlcm5hbWU6IHN0cmluZyxcbiAgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsXG4gIGRlc2lyZWQ6IERlc2lyZWRSZWNvcmQsXG4gIHR0bFZhbHVlOiBzdHJpbmcsXG4gIGRyeVJ1bjogYm9vbGVhblxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHsgem9uZU5hbWUsIGhvc3ROYW1lLCB0eXBlLCB2YWx1ZSB9ID0gZGVzaXJlZFxuICBjb25zdCBuYW1lID0gaG9zdE5hbWUgPyBgJHtob3N0TmFtZX0uJHt6b25lTmFtZX1gIDogem9uZU5hbWVcblxuICBjb25zdCByZWNvcmRzID0gYXdhaXQgbGlzdFpvbmVSZWNvcmRzKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCB6b25lTmFtZSlcbiAgLyoqXG4gICAqIE1hdGNoIG9uIGhvc3QgYW5kIHR5cGUgYWNyb3NzIHRoZSB3aG9sZSB6b25lIHJhdGhlciB0aGFuIHRydXN0aW5nIGEgZmlsdGVyZWQgcXVlcnkncyBmaXJzdFxuICAgKiBlbnRyeS4gVGFraW5nIHdoaWNoZXZlciByZWNvcmQgaGFwcGVuZWQgdG8gY29tZSBiYWNrIGZpcnN0IG1lYW50IHRoYXQgYSBob3N0IHdpdGggbW9yZSB0aGFuIG9uZVxuICAgKiByZWNvcmQgb2YgYSB0eXBlIGhhZCBvbmUgb2YgdGhlbSB1cGRhdGVkIGF0IHJhbmRvbSB3aGlsZSB0aGUgb3RoZXIga2VwdCBzZXJ2aW5nIHRyYWZmaWMuXG4gICAqL1xuICBjb25zdCBtYXRjaGluZyA9IHJlY29yZHMuZmlsdGVyKChyZWNvcmQpID0+IHJlY29yZC5ob3N0ID09PSBob3N0TmFtZSAmJiByZWNvcmQudHlwZSA9PT0gdHlwZSlcbiAgaWYgKG1hdGNoaW5nLmxlbmd0aCA+IDEpIHtcbiAgICBjb25zb2xlLndhcm4oJ1dBUk4nLCBuYW1lLCB0eXBlLCAnaGFzJywgbWF0Y2hpbmcubGVuZ3RoLCAncmVjb3JkczsgdXBkYXRpbmcgdGhlIGZpcnN0IGFuZCBsZWF2aW5nIHRoZSByZXN0JylcbiAgfVxuICBjb25zdCBleGlzdGluZ1JlY29yZCA9IG1hdGNoaW5nWzBdXG4gIGNvbnN0IG5vdGUgPSBvd25lcnNoaXBOb3RlKGRlc2lyZWQuc3RhY2tOYW1lLCBkZXNpcmVkLmV4cG9ydE5hbWUpXG5cbiAgaWYgKGV4aXN0aW5nUmVjb3JkICYmIGV4aXN0aW5nUmVjb3JkLnJlY29yZCA9PT0gdmFsdWUgJiYgU3RyaW5nKGV4aXN0aW5nUmVjb3JkLnR0bCkgPT09IFN0cmluZyh0dGxWYWx1ZSkpIHtcbiAgICBpZiAoZXhpc3RpbmdSZWNvcmQubm90ZSA9PT0gbm90ZSkge1xuICAgICAgY29uc29sZS5sb2coJ09LJywgbmFtZSwgdHlwZSwgdHRsVmFsdWUsIHZhbHVlLCAnWk9ORScsIHpvbmVOYW1lLCAnSE9TVCcsIGhvc3ROYW1lKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBBZG9wdHMgcmVjb3JkcyBjcmVhdGVkIGJlZm9yZSBvd25lcnNoaXAgbm90ZXMgZXhpc3RlZCwgYW5kIHJlcGFpcnMgYSBub3RlIHRoYXQgZHJpZnRlZC5cbiAgICAgIGNvbnNvbGUubG9nKCdBRE9QVCcsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgICAgIGF3YWl0IHNldFJlY29yZE5vdGUoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHpvbmVOYW1lLCBleGlzdGluZ1JlY29yZC5pZCwgbm90ZSwgZHJ5UnVuKVxuICAgIH1cbiAgICByZXR1cm5cbiAgfVxuXG4gIGlmIChleGlzdGluZ1JlY29yZCkge1xuICAgIGNvbnNvbGUubG9nKCdVUERBVEUnLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gICAgaWYgKCFkcnlSdW4pIHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ1BPU1QnLCAnL2Rucy9tb2QtcmVjb3JkLmpzb24nLCB7XG4gICAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICAgICAncmVjb3JkLWlkJzogZXhpc3RpbmdSZWNvcmQuaWQsXG4gICAgICAgIGhvc3Q6IGhvc3ROYW1lLFxuICAgICAgICAncmVjb3JkLXR5cGUnOiB0eXBlLFxuICAgICAgICByZWNvcmQ6IHZhbHVlLFxuICAgICAgICB0dGw6IHR0bFZhbHVlLFxuICAgICAgfSlcbiAgICAgIGFzc2VydFN1Y2Nlc3MocmVzdWx0LCAnTW9kaWZ5IHJlY29yZCcpXG4gICAgICBhd2FpdCBzZXRSZWNvcmROb3RlKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCB6b25lTmFtZSwgZXhpc3RpbmdSZWNvcmQuaWQsIG5vdGUsIGRyeVJ1bilcbiAgICAgIGF3YWl0IHZlcmlmeVJlY29yZChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgZGVzaXJlZCwgdHRsVmFsdWUpXG4gICAgfVxuICAgIHJldHVyblxuICB9XG5cbiAgY29uc29sZS5sb2coJ0NSRUFURScsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgaWYgKGRyeVJ1bikgcmV0dXJuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ1BPU1QnLCAnL2Rucy9hZGQtcmVjb3JkLmpzb24nLCB7XG4gICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgaG9zdDogaG9zdE5hbWUsXG4gICAgJ3JlY29yZC10eXBlJzogdHlwZSxcbiAgICByZWNvcmQ6IHZhbHVlLFxuICAgIHR0bDogdHRsVmFsdWUsXG4gIH0pXG4gIGFzc2VydFN1Y2Nlc3MocmVzdWx0LCAnQWRkIHJlY29yZCcpXG4gIGNvbnN0IGNyZWF0ZWRJZCA9IHJlc3VsdD8uZGF0YT8uaWRcbiAgaWYgKGNyZWF0ZWRJZCkgYXdhaXQgc2V0UmVjb3JkTm90ZShjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWUsIFN0cmluZyhjcmVhdGVkSWQpLCBub3RlLCBkcnlSdW4pXG4gIGF3YWl0IHZlcmlmeVJlY29yZChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgZGVzaXJlZCwgdHRsVmFsdWUpXG59XG5cbi8qKlxuICogUmVhZHMgdGhlIHJlY29yZCBiYWNrIGFuZCBjb21wbGFpbnMgaWYgaXQgaXMgbm90IHdoYXQgd2FzIGp1c3Qgd3JpdHRlbi5cbiAqXG4gKiBXaXRob3V0IHRoaXMgdGhlIGxvZyByZXBvcnRzIGludGVudCByYXRoZXIgdGhhbiBvdXRjb21lLCB3aGljaCBpcyBob3cgYSBjdXRvdmVyIHRoYXQgbmV2ZXJcbiAqIGhhcHBlbmVkIGNhbiBsb29rIGxpa2UgYSBjbGVhbiBydW4uIE5vdGUgdGhpcyBjb25maXJtcyB0aGUgc3RvcmVkIHJlY29yZCBvbmx5IOKAlCBDbG91RE5TIHJlc29sdmVzXG4gKiBBTElBUyB0YXJnZXRzIG9uIGl0cyBvd24gc2NoZWR1bGUsIHNvIHdoYXQgdGhlIHpvbmUgKnNlcnZlcyogY2FuIGxhZyB0aGUgcmVjb3JkIGJ5IGEgbG9uZyB3YXkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHZlcmlmeVJlY29yZChjbG91ZG5zVXNlcm5hbWU6IHN0cmluZywgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsIGRlc2lyZWQ6IERlc2lyZWRSZWNvcmQsIHR0bFZhbHVlOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcmVjb3JkcyA9IGF3YWl0IGxpc3Rab25lUmVjb3JkcyhjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgZGVzaXJlZC56b25lTmFtZSlcbiAgY29uc3Qgc3RvcmVkID0gcmVjb3Jkcy5maW5kKChyZWNvcmQpID0+IHJlY29yZC5ob3N0ID09PSBkZXNpcmVkLmhvc3ROYW1lICYmIHJlY29yZC50eXBlID09PSBkZXNpcmVkLnR5cGUpXG4gIGlmICghc3RvcmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBWZXJpZmljYXRpb24gZmFpbGVkOiAke2Rlc2lyZWQuaG9zdE5hbWV9LiR7ZGVzaXJlZC56b25lTmFtZX0gJHtkZXNpcmVkLnR5cGV9IGlzIG1pc3NpbmcgYWZ0ZXIgd3JpdGVgKVxuICB9XG4gIGlmIChzdG9yZWQucmVjb3JkICE9PSBkZXNpcmVkLnZhbHVlIHx8IFN0cmluZyhzdG9yZWQudHRsKSAhPT0gU3RyaW5nKHR0bFZhbHVlKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBWZXJpZmljYXRpb24gZmFpbGVkOiAke2Rlc2lyZWQuaG9zdE5hbWV9LiR7ZGVzaXJlZC56b25lTmFtZX0gJHtkZXNpcmVkLnR5cGV9IGlzICR7c3RvcmVkLnJlY29yZH0gKHR0bCAke3N0b3JlZC50dGx9KSwgZXhwZWN0ZWQgJHtkZXNpcmVkLnZhbHVlfSAodHRsICR7dHRsVmFsdWV9KWBcbiAgICApXG4gIH1cbn1cblxuLyoqXG4gKiBEZWxldGVzIG1hbmFnZWQgcmVjb3JkcyB3aG9zZSBleHBvcnQgbm8gbG9uZ2VyIGV4aXN0cy5cbiAqXG4gKiBPbmx5IHJlY29yZHMgY2FycnlpbmcgdGhpcyB0b29sJ3Mgbm90ZSBhcmUgY29uc2lkZXJlZCwgYW5kIHdoZW4gLS1zdGFjayB3YXMgZ2l2ZW4gb25seSB0aG9zZVxuICogd2hvc2Ugbm90ZSBuYW1lcyBvbmUgb2YgdGhvc2Ugc3RhY2tzIOKAlCBvdGhlcndpc2Ugc3luY2luZyBvbmUgc3RhY2sgd291bGQgZGVsZXRlIHRoZSByZWNvcmRzIG9mXG4gKiBhbm90aGVyLlxuICovXG5hc3luYyBmdW5jdGlvbiBwcnVuZU9ycGhhbnMoXG4gIGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLFxuICBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZyxcbiAgem9uZU5hbWVzOiBzdHJpbmdbXSxcbiAgZGVzaXJlZDogRGVzaXJlZFJlY29yZFtdLFxuICBvcHRpb25zOiBPcHRpb25zXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgZGVzaXJlZEtleXMgPSBuZXcgU2V0KGRlc2lyZWQubWFwKChyZWNvcmQpID0+IGAke3JlY29yZC56b25lTmFtZX18JHtyZWNvcmQuaG9zdE5hbWV9fCR7cmVjb3JkLnR5cGV9YCkpXG4gIGNvbnN0IG9ycGhhbnM6IHsgem9uZU5hbWU6IHN0cmluZzsgcmVjb3JkOiBDbG91ZG5zUmVjb3JkIH1bXSA9IFtdXG5cbiAgZm9yIChjb25zdCB6b25lTmFtZSBvZiB6b25lTmFtZXMpIHtcbiAgICBmb3IgKGNvbnN0IHJlY29yZCBvZiBhd2FpdCBsaXN0Wm9uZVJlY29yZHMoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHpvbmVOYW1lKSkge1xuICAgICAgY29uc3Qgc3RhY2sgPSBub3RlU3RhY2tOYW1lKHJlY29yZClcbiAgICAgIGlmIChzdGFjayA9PT0gdW5kZWZpbmVkKSBjb250aW51ZSAvLyBub3Qgb3Vyc1xuICAgICAgaWYgKG9wdGlvbnMuc3RhY2tOYW1lcy5sZW5ndGggJiYgIW9wdGlvbnMuc3RhY2tOYW1lcy5pbmNsdWRlcyhzdGFjaykpIGNvbnRpbnVlIC8vIGFub3RoZXIgc3RhY2snc1xuICAgICAgaWYgKGRlc2lyZWRLZXlzLmhhcyhgJHt6b25lTmFtZX18JHtyZWNvcmQuaG9zdH18JHtyZWNvcmQudHlwZX1gKSkgY29udGludWUgLy8gc3RpbGwgd2FudGVkXG4gICAgICBvcnBoYW5zLnB1c2goeyB6b25lTmFtZSwgcmVjb3JkIH0pXG4gICAgfVxuICB9XG5cbiAgaWYgKCFvcnBoYW5zLmxlbmd0aCkge1xuICAgIGNvbnNvbGUubG9nKCdQUlVORSBub25lJylcbiAgICByZXR1cm5cbiAgfVxuXG4gIGZvciAoY29uc3QgeyB6b25lTmFtZSwgcmVjb3JkIH0gb2Ygb3JwaGFucykge1xuICAgIGNvbnN0IG5hbWUgPSByZWNvcmQuaG9zdCA/IGAke3JlY29yZC5ob3N0fS4ke3pvbmVOYW1lfWAgOiB6b25lTmFtZVxuICAgIGNvbnNvbGUubG9nKG9wdGlvbnMuZHJ5UnVuID8gJ1dPVUxEIFBSVU5FJyA6ICdQUlVORScsIG5hbWUsIHJlY29yZC50eXBlLCByZWNvcmQucmVjb3JkLCAnWk9ORScsIHpvbmVOYW1lKVxuICB9XG5cbiAgaWYgKG9ycGhhbnMubGVuZ3RoID4gb3B0aW9ucy5tYXhQcnVuZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgUmVmdXNpbmcgdG8gZGVsZXRlICR7b3JwaGFucy5sZW5ndGh9IHJlY29yZHMgaW4gb25lIHJ1biAobGltaXQgJHtvcHRpb25zLm1heFBydW5lfSk7IHJhaXNlIC0tbWF4LXBydW5lIGlmIHRoaXMgaXMgaW50ZW5kZWRgKVxuICB9XG5cbiAgaWYgKG9wdGlvbnMuZHJ5UnVuKSByZXR1cm5cblxuICBmb3IgKGNvbnN0IHsgem9uZU5hbWUsIHJlY29yZCB9IG9mIG9ycGhhbnMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdQT1NUJywgJy9kbnMvZGVsZXRlLXJlY29yZC5qc29uJywge1xuICAgICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgICAncmVjb3JkLWlkJzogcmVjb3JkLmlkLFxuICAgIH0pXG4gICAgYXNzZXJ0U3VjY2VzcyhyZXN1bHQsICdEZWxldGUgcmVjb3JkJylcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgY29uc29sZS5sb2coJ0Nsb3VETlMgQ2xvdWRGb3JtYXRpb24gU3luYyBieSBLZW5uZXRoIEZhbGNrIDxrZW5udUBjbG91ZGVuLm5ldD4gKEMpIENsb3VkZW4gT3kgMjAyMC0yMDI2JylcbiAgY29uc3Qgb3B0aW9ucyA9IHBhcnNlQXJncyhwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpXG5cbiAgaWYgKCFvcHRpb25zLnVzZXJuYW1lIHx8ICFvcHRpb25zLnBhc3N3b3JkUGFyYW1ldGVyKSB7XG4gICAgY29uc29sZS5lcnJvcihVU0FHRSlcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuICBpZiAob3B0aW9ucy5mb3JjZVBydW5lICYmICFvcHRpb25zLnpvbmVOYW1lcy5sZW5ndGgpIHtcbiAgICBjb25zb2xlLmVycm9yKCctLWZvcmNlLXBydW5lIG5lZWRzIGF0IGxlYXN0IG9uZSAtLXpvbmU6IHdpdGggbm8gZXhwb3J0cyB0aGVyZSBpcyBub3RoaW5nIHRvIGluZmVyIGEgem9uZSBmcm9tJylcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIGNvbnN0IHNzbSA9IG5ldyBTU01DbGllbnQoe30pXG4gIGNvbnN0IHpvbmVDYWNoZSA9IHt9XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBzc20uc2VuZChcbiAgICBuZXcgR2V0UGFyYW1ldGVyQ29tbWFuZCh7XG4gICAgICBOYW1lOiBvcHRpb25zLnBhc3N3b3JkUGFyYW1ldGVyLFxuICAgICAgV2l0aERlY3J5cHRpb246IHRydWUsXG4gICAgfSlcbiAgKVxuICBjb25zdCBjbG91ZG5zUGFzc3dvcmQgPSByZXNwb25zZS5QYXJhbWV0ZXI/LlZhbHVlIHx8ICcnXG5cbiAgLy8gQ29sbGVjdCBldmVyeXRoaW5nIHRoZSBleHBvcnRzIGFzayBmb3IgYmVmb3JlIHdyaXRpbmcgYW55dGhpbmcsIHNvIHBydW5pbmcgY2FuIGNvbXBhcmUgYWdhaW5zdFxuICAvLyB0aGUgY29tcGxldGUgcGljdHVyZSByYXRoZXIgdGhhbiBhZ2FpbnN0IHdoYXRldmVyIGhhcyBiZWVuIHByb2Nlc3NlZCBzbyBmYXIuXG4gIGNvbnN0IGRlc2lyZWQ6IERlc2lyZWRSZWNvcmRbXSA9IFtdXG4gIGNvbnN0IG1hdGNoZWRTdGFja3MgPSBuZXcgU2V0PHN0cmluZz4oKVxuICBjb25zdCBjbG91ZEZvcm1hdGlvbiA9IG5ldyBDbG91ZEZvcm1hdGlvbkNsaWVudCh7fSlcbiAgbGV0IG5leHRUb2tlblxuICBkbyB7XG4gICAgY29uc3QgcmVzcG9uc2U6IExpc3RFeHBvcnRzT3V0cHV0ID0gYXdhaXQgY2xvdWRGb3JtYXRpb24uc2VuZChuZXcgTGlzdEV4cG9ydHNDb21tYW5kKHsgTmV4dFRva2VuOiBuZXh0VG9rZW4gfSkpXG4gICAgZm9yIChjb25zdCBleHBvcnRPYmogb2YgcmVzcG9uc2UuRXhwb3J0cyB8fCBbXSkge1xuICAgICAgY29uc3Qgc3RhY2tNYXRjaCA9IGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkPy5tYXRjaCgvXmFybjpbXjpdKzpjbG91ZGZvcm1hdGlvbjpbXjpdKzpbXjpdKzpzdGFja1xcLyhbXi9dKylcXC8vKVxuICAgICAgY29uc3Qgc3RhY2tOYW1lID0gc3RhY2tNYXRjaCA/IHN0YWNrTWF0Y2hbMV0gOiBleHBvcnRPYmouRXhwb3J0aW5nU3RhY2tJZCB8fCAnJ1xuICAgICAgaWYgKG9wdGlvbnMuc3RhY2tOYW1lcy5sZW5ndGggJiYgIW9wdGlvbnMuc3RhY2tOYW1lcy5pbmNsdWRlcyhleHBvcnRPYmouRXhwb3J0aW5nU3RhY2tJZCB8fCAnJykgJiYgIW9wdGlvbnMuc3RhY2tOYW1lcy5pbmNsdWRlcyhzdGFja05hbWUpKSB7XG4gICAgICAgIGNvbnRpbnVlXG4gICAgICB9XG4gICAgICBpZiAoIWV4cG9ydE9iai5OYW1lPy5tYXRjaCgvXkNsb3VETlM6LykpIGNvbnRpbnVlXG5cbiAgICAgIGNvbnN0IG5hbWVQYXJ0cyA9IGV4cG9ydE9iai5OYW1lLnNwbGl0KCc6JylcbiAgICAgIGNvbnN0IHJlc291cmNlVHlwZSA9IG5hbWVQYXJ0c1sxXVxuICAgICAgY29uc3QgcmVzb3VyY2VOYW1lID0gbmFtZVBhcnRzLnNsaWNlKDIpLmpvaW4oJy4nKVxuICAgICAgY29uc3QgeyB6b25lTmFtZSwgaG9zdE5hbWUgfSA9IGF3YWl0IGF1dG9EZXRlY3RDbG91ZG5zSG9zdEFuZFpvbmUob3B0aW9ucy51c2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCByZXNvdXJjZU5hbWUsIHpvbmVDYWNoZSlcbiAgICAgIG1hdGNoZWRTdGFja3MuYWRkKHN0YWNrTmFtZSlcbiAgICAgIGRlc2lyZWQucHVzaCh7XG4gICAgICAgIHpvbmVOYW1lLFxuICAgICAgICBob3N0TmFtZSxcbiAgICAgICAgdHlwZTogcmVzb3VyY2VUeXBlLFxuICAgICAgICB2YWx1ZTogZXhwb3J0T2JqLlZhbHVlISxcbiAgICAgICAgc3RhY2tOYW1lLFxuICAgICAgICBleHBvcnROYW1lOiBleHBvcnRPYmouTmFtZSxcbiAgICAgIH0pXG4gICAgfVxuICAgIG5leHRUb2tlbiA9IHJlc3BvbnNlLk5leHRUb2tlblxuICB9IHdoaWxlIChuZXh0VG9rZW4pXG5cbiAgLyoqXG4gICAqIEEgLS1zdGFjayB0aGF0IG1hdGNoZWQgbm90aGluZyBpcyBuZWFybHkgYWx3YXlzIGEgdHlwbyBvciBhIHN0YWNrIHRoYXQgaGFzIG5vdCBkZXBsb3llZCB5ZXQuXG4gICAqIEl0IHVzZWQgdG8gcGFzcyBzaWxlbnRseSBhcyBhIG5vLW9wOyB3aXRoIHBydW5pbmcgZW5hYmxlZCB0aGUgc2FtZSBjb25kaXRpb24gd291bGQgbG9vayBsaWtlXG4gICAqIFwiZXZlcnkgcmVjb3JkIGlzIGFuIG9ycGhhblwiLCBzbyBpdCBpcyBmYXRhbCB0aGVyZSBhbmQgYSB3YXJuaW5nIG90aGVyd2lzZS5cbiAgICovXG4gIGZvciAoY29uc3Qgc3RhY2tOYW1lIG9mIG9wdGlvbnMuc3RhY2tOYW1lcykge1xuICAgIGlmICghbWF0Y2hlZFN0YWNrcy5oYXMoc3RhY2tOYW1lKSkge1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGBTdGFjayAke3N0YWNrTmFtZX0gcHJvZHVjZWQgbm8gQ2xvdUROUyBleHBvcnRzYFxuICAgICAgaWYgKG9wdGlvbnMucHJ1bmUpIHRocm93IG5ldyBFcnJvcihgJHttZXNzYWdlfTsgcmVmdXNpbmcgdG8gcHJ1bmUgb24gYW4gdW52ZXJpZmllZCBzdGFjayBuYW1lYClcbiAgICAgIGNvbnNvbGUud2FybignV0FSTicsIG1lc3NhZ2UpXG4gICAgfVxuICB9XG5cbiAgZm9yIChjb25zdCByZWNvcmQgb2YgZGVzaXJlZCkge1xuICAgIGF3YWl0IGNyZWF0ZU9yVXBkYXRlQ2xvdWRuc1Jlc291cmNlKG9wdGlvbnMudXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgcmVjb3JkLCBvcHRpb25zLnR0bCwgb3B0aW9ucy5kcnlSdW4pXG4gIH1cblxuICBpZiAoIW9wdGlvbnMucHJ1bmUpIHJldHVyblxuXG4gIGlmICghZGVzaXJlZC5sZW5ndGggJiYgIW9wdGlvbnMuZm9yY2VQcnVuZSkge1xuICAgIGNvbnNvbGUud2FybignV0FSTiBObyBleHBvcnRzIG1hdGNoZWQsIHNvIG5vdGhpbmcgaXMga25vd24gdG8gYmUgd2FudGVkOyBza2lwcGluZyBwcnVuZS4gVXNlIC0tZm9yY2UtcHJ1bmUgd2l0aCAtLXpvbmUgaWYgdGhpcyBpcyBhIHRlYXJkb3duLicpXG4gICAgcmV0dXJuXG4gIH1cblxuICBjb25zdCB6b25lTmFtZXMgPSBbLi4ubmV3IFNldChbLi4ub3B0aW9ucy56b25lTmFtZXMsIC4uLmRlc2lyZWQubWFwKChyZWNvcmQpID0+IHJlY29yZC56b25lTmFtZSldKV1cbiAgYXdhaXQgcHJ1bmVPcnBoYW5zKG9wdGlvbnMudXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgem9uZU5hbWVzLCBkZXNpcmVkLCBvcHRpb25zKVxufVxuIl19