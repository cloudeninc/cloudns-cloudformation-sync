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
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm'
import { CloudFormationClient, ListExportsCommand, ListExportsOutput } from '@aws-sdk/client-cloudformation'
import * as querystring from 'querystring'

// Load ~/.aws/config
process.env.AWS_SDK_LOAD_CONFIG = '1'

/** Marks a record as ours. Present in the note of every record this tool manages. */
const NOTE_MARKER = 'managed-by=cloudns-cloudformation-sync'

/** Most records one run will delete before refusing. Raise with --max-prune when it is genuinely more. */
const DEFAULT_MAX_PRUNE = 10

type CloudnsRestCallResponse = any

interface Options {
  username: string
  passwordParameter: string
  ttl: string
  stackNames: string[]
  zoneNames: string[]
  prune: boolean
  forcePrune: boolean
  maxPrune: number
  dryRun: boolean
}

interface DesiredRecord {
  zoneName: string
  hostName: string
  type: string
  value: string
  stackName: string
  exportName: string
}

interface CloudnsRecord {
  id: string
  host: string
  type: string
  ttl: string
  record: string
  note?: string
}

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

AWS_PROFILE selects the AWS credentials, as usual.`

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    username: '',
    passwordParameter: '',
    ttl: '300',
    stackNames: [],
    zoneNames: [],
    prune: false,
    forcePrune: false,
    maxPrune: DEFAULT_MAX_PRUNE,
    dryRun: false,
  }

  /**
   * Anything not starting with "-" in the first position is the old positional form:
   * <username> <password-parameter> [ttl [stack...]]. Kept working so existing deploy scripts and
   * CI jobs do not have to change in the same release that adds pruning.
   */
  if (argv.length && !argv[0].startsWith('-')) {
    options.username = argv[0]
    options.passwordParameter = argv[1] || ''
    /**
     * Options are still honoured after the positional arguments. Treating a trailing "-n" as a
     * stack name instead is how a run the caller believed was a rehearsal writes for real — which
     * is exactly what happened the first time this was tested.
     */
    const rest = argv.slice(2)
    const flagIndex = rest.findIndex((arg) => arg.startsWith('-'))
    const positional = flagIndex === -1 ? rest : rest.slice(0, flagIndex)
    if (positional[0]) options.ttl = positional[0]
    options.stackNames = positional.slice(1)
    if (flagIndex !== -1) applyFlags(rest.slice(flagIndex), options)
    return options
  }

  applyFlags(argv, options)
  return options
}

function applyFlags(argv: string[], options: Options): void {
  const next = (index: number, flag: string): string => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('-')) throw new Error(`Missing value for ${flag}`)
    return value
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-u':
      case '--username':
        options.username = next(i, arg)
        i++
        break
      case '-p':
      case '--password-parameter':
        options.passwordParameter = next(i, arg)
        i++
        break
      case '-t':
      case '--ttl':
        options.ttl = next(i, arg)
        i++
        break
      case '-s':
      case '--stack':
        options.stackNames.push(next(i, arg))
        i++
        break
      case '-z':
      case '--zone':
        options.zoneNames.push(next(i, arg))
        i++
        break
      case '--prune':
        options.prune = true
        break
      case '--force-prune':
        options.prune = true
        options.forcePrune = true
        break
      case '--max-prune':
        options.maxPrune = parseInt(next(i, arg), 10)
        i++
        break
      case '-n':
      case '--dry-run':
        options.dryRun = true
        break
      case '-h':
      case '--help':
        console.log(USAGE)
        process.exit(0)
        break
      case '-V':
      case '--version':
        console.log(require('../package.json').version)
        process.exit(0)
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }
}

async function cloudnsRestCall(
  cloudnsUsername: string,
  cloudnsPassword: string,
  method: string,
  relativeUrl: string,
  queryOptions: any
): Promise<CloudnsRestCallResponse> {
  const fullUrl =
    'https://api.cloudns.net' +
    relativeUrl +
    '?' +
    querystring.stringify(
      Object.assign(
        {
          'sub-auth-user': cloudnsUsername,
          'auth-password': cloudnsPassword,
        },
        queryOptions || {}
      )
    )

  const response = await fetch(fullUrl, {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  })
  if (!response.ok) {
    const errorText = await response.text()
    console.error('HTTP Error', response.status, response.statusText, errorText)
    throw new Error(errorText)
  }
  return (await response.json()) as CloudnsRestCallResponse
}

/**
 * ClouDNS reports failures in the body with HTTP 200, so a call is only successful if it says so.
 *
 * Treating "not the string Failed" as success is how a rejected write gets reported as done —
 * checked positively here instead.
 */
function assertSuccess(result: any, what: string): void {
  const status = result?.status
  if (status === 'Success' || status === 1 || status === '1') return
  throw new Error(`${what} failed: ${result?.statusDescription || result?.statusMessage || JSON.stringify(result)}`)
}

async function autoDetectCloudnsHostAndZone(cloudnsUsername: string, cloudnsPassword: string, name: string, zoneCache: any) {
  const nameParts = name.split('.')

  // Zone and host name for xxx.tld
  const hostName1 = nameParts.slice(0, nameParts.length - 2).join('.')
  const zoneName1 = nameParts.slice(nameParts.length - 2).join('.')

  // Zone and host name for xxx.subtld.tld
  const hostName2 = nameParts.slice(0, nameParts.length - 3).join('.')
  const zoneName2 = nameParts.slice(nameParts.length - 3).join('.')

  // Check which zone exists
  const zoneResponse1 =
    zoneCache[zoneName1] ||
    (await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/get-zone-info.json', {
      'domain-name': zoneName1,
    }))
  zoneCache[zoneName1] = zoneResponse1
  const zoneResponse2 =
    zoneCache[zoneName2] ||
    (await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/get-zone-info.json', {
      'domain-name': zoneName2,
    }))
  zoneCache[zoneName2] = zoneResponse2

  const zoneName = zoneResponse1.status === '1' ? zoneName1 : zoneResponse2.status === '1' ? zoneName2 : ''
  const hostName = zoneResponse1.status === '1' ? hostName1 : zoneResponse2.status === '1' ? hostName2 : ''
  if (!zoneName) {
    // Neither zone exists
    throw new Error('Zone Not Found: ' + name)
  }
  return {
    hostName: hostName,
    zoneName: zoneName,
  }
}

/** Every record in a zone, notes included. Also the basis for finding orphans. */
async function listZoneRecords(cloudnsUsername: string, cloudnsPassword: string, zoneName: string): Promise<CloudnsRecord[]> {
  const response = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/records.json', {
    'domain-name': zoneName,
    'include-notes': '1',
  })
  // An empty zone comes back as an empty array rather than an empty object.
  if (!response || Array.isArray(response)) return []
  return Object.values(response) as CloudnsRecord[]
}

function ownershipNote(stackName: string, exportName: string): string {
  return `${NOTE_MARKER} stack=${stackName} export=${exportName}`
}

/** The stack named in a record's note, or undefined when the record is not ours. */
function noteStackName(record: CloudnsRecord): string | undefined {
  if (!record.note || record.note.indexOf(NOTE_MARKER) === -1) return undefined
  const match = /stack=(\S+)/.exec(record.note)
  return match ? match[1] : ''
}

async function setRecordNote(
  cloudnsUsername: string,
  cloudnsPassword: string,
  zoneName: string,
  recordId: string,
  note: string,
  dryRun: boolean
): Promise<void> {
  if (dryRun) return
  const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/set-record-note.json', {
    'domain-name': zoneName,
    'record-id': recordId,
    note: note,
  })
  assertSuccess(result, 'Set record note')
}

async function createOrUpdateCloudnsResource(
  cloudnsUsername: string,
  cloudnsPassword: string,
  desired: DesiredRecord,
  ttlValue: string,
  dryRun: boolean
): Promise<void> {
  const { zoneName, hostName, type, value } = desired
  const name = hostName ? `${hostName}.${zoneName}` : zoneName

  const records = await listZoneRecords(cloudnsUsername, cloudnsPassword, zoneName)
  /**
   * Match on host and type across the whole zone rather than trusting a filtered query's first
   * entry. Taking whichever record happened to come back first meant that a host with more than one
   * record of a type had one of them updated at random while the other kept serving traffic.
   */
  const matching = records.filter((record) => record.host === hostName && record.type === type)
  if (matching.length > 1) {
    console.warn('WARN', name, type, 'has', matching.length, 'records; updating the first and leaving the rest')
  }
  const existingRecord = matching[0]
  const note = ownershipNote(desired.stackName, desired.exportName)

  if (existingRecord && existingRecord.record === value && String(existingRecord.ttl) === String(ttlValue)) {
    if (existingRecord.note === note) {
      console.log('OK', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName)
    } else {
      // Adopts records created before ownership notes existed, and repairs a note that drifted.
      console.log('ADOPT', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName)
      await setRecordNote(cloudnsUsername, cloudnsPassword, zoneName, existingRecord.id, note, dryRun)
    }
    return
  }

  if (existingRecord) {
    console.log('UPDATE', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName)
    if (!dryRun) {
      const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/mod-record.json', {
        'domain-name': zoneName,
        'record-id': existingRecord.id,
        host: hostName,
        'record-type': type,
        record: value,
        ttl: ttlValue,
      })
      assertSuccess(result, 'Modify record')
      await setRecordNote(cloudnsUsername, cloudnsPassword, zoneName, existingRecord.id, note, dryRun)
      await verifyRecord(cloudnsUsername, cloudnsPassword, desired, ttlValue)
    }
    return
  }

  console.log('CREATE', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName)
  if (dryRun) return
  const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/add-record.json', {
    'domain-name': zoneName,
    host: hostName,
    'record-type': type,
    record: value,
    ttl: ttlValue,
  })
  assertSuccess(result, 'Add record')
  const createdId = result?.data?.id
  if (createdId) await setRecordNote(cloudnsUsername, cloudnsPassword, zoneName, String(createdId), note, dryRun)
  await verifyRecord(cloudnsUsername, cloudnsPassword, desired, ttlValue)
}

/**
 * Reads the record back and complains if it is not what was just written.
 *
 * Without this the log reports intent rather than outcome, which is how a cutover that never
 * happened can look like a clean run. Note this confirms the stored record only — ClouDNS resolves
 * ALIAS targets on its own schedule, so what the zone *serves* can lag the record by a long way.
 */
async function verifyRecord(cloudnsUsername: string, cloudnsPassword: string, desired: DesiredRecord, ttlValue: string): Promise<void> {
  const records = await listZoneRecords(cloudnsUsername, cloudnsPassword, desired.zoneName)
  const stored = records.find((record) => record.host === desired.hostName && record.type === desired.type)
  if (!stored) {
    throw new Error(`Verification failed: ${desired.hostName}.${desired.zoneName} ${desired.type} is missing after write`)
  }
  if (stored.record !== desired.value || String(stored.ttl) !== String(ttlValue)) {
    throw new Error(
      `Verification failed: ${desired.hostName}.${desired.zoneName} ${desired.type} is ${stored.record} (ttl ${stored.ttl}), expected ${desired.value} (ttl ${ttlValue})`
    )
  }
}

/**
 * Deletes managed records whose export no longer exists.
 *
 * Only records carrying this tool's note are considered, and when --stack was given only those
 * whose note names one of those stacks — otherwise syncing one stack would delete the records of
 * another.
 */
async function pruneOrphans(
  cloudnsUsername: string,
  cloudnsPassword: string,
  zoneNames: string[],
  desired: DesiredRecord[],
  options: Options
): Promise<void> {
  const desiredKeys = new Set(desired.map((record) => `${record.zoneName}|${record.hostName}|${record.type}`))
  const orphans: { zoneName: string; record: CloudnsRecord }[] = []

  for (const zoneName of zoneNames) {
    for (const record of await listZoneRecords(cloudnsUsername, cloudnsPassword, zoneName)) {
      const stack = noteStackName(record)
      if (stack === undefined) continue // not ours
      if (options.stackNames.length && !options.stackNames.includes(stack)) continue // another stack's
      if (desiredKeys.has(`${zoneName}|${record.host}|${record.type}`)) continue // still wanted
      orphans.push({ zoneName, record })
    }
  }

  if (!orphans.length) {
    console.log('PRUNE none')
    return
  }

  for (const { zoneName, record } of orphans) {
    const name = record.host ? `${record.host}.${zoneName}` : zoneName
    console.log(options.dryRun ? 'WOULD PRUNE' : 'PRUNE', name, record.type, record.record, 'ZONE', zoneName)
  }

  if (orphans.length > options.maxPrune) {
    throw new Error(`Refusing to delete ${orphans.length} records in one run (limit ${options.maxPrune}); raise --max-prune if this is intended`)
  }

  if (options.dryRun) return

  for (const { zoneName, record } of orphans) {
    const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/delete-record.json', {
      'domain-name': zoneName,
      'record-id': record.id,
    })
    assertSuccess(result, 'Delete record')
  }
}

export async function main() {
  console.log('ClouDNS CloudFormation Sync by Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020-2026')
  const options = parseArgs(process.argv.slice(2))

  if (!options.username || !options.passwordParameter) {
    console.error(USAGE)
    process.exit(1)
  }
  if (options.forcePrune && !options.zoneNames.length) {
    console.error('--force-prune needs at least one --zone: with no exports there is nothing to infer a zone from')
    process.exit(1)
  }

  const ssm = new SSMClient({})
  const zoneCache = {}

  const response = await ssm.send(
    new GetParameterCommand({
      Name: options.passwordParameter,
      WithDecryption: true,
    })
  )
  const cloudnsPassword = response.Parameter?.Value || ''

  // Collect everything the exports ask for before writing anything, so pruning can compare against
  // the complete picture rather than against whatever has been processed so far.
  const desired: DesiredRecord[] = []
  const matchedStacks = new Set<string>()
  const cloudFormation = new CloudFormationClient({})
  let nextToken
  do {
    const response: ListExportsOutput = await cloudFormation.send(new ListExportsCommand({ NextToken: nextToken }))
    for (const exportObj of response.Exports || []) {
      const stackMatch = exportObj.ExportingStackId?.match(/^arn:[^:]+:cloudformation:[^:]+:[^:]+:stack\/([^/]+)\//)
      const stackName = stackMatch ? stackMatch[1] : exportObj.ExportingStackId || ''
      if (options.stackNames.length && !options.stackNames.includes(exportObj.ExportingStackId || '') && !options.stackNames.includes(stackName)) {
        continue
      }
      if (!exportObj.Name?.match(/^ClouDNS:/)) continue

      const nameParts = exportObj.Name.split(':')
      const resourceType = nameParts[1]
      const resourceName = nameParts.slice(2).join('.')
      const { zoneName, hostName } = await autoDetectCloudnsHostAndZone(options.username, cloudnsPassword, resourceName, zoneCache)
      matchedStacks.add(stackName)
      desired.push({
        zoneName,
        hostName,
        type: resourceType,
        value: exportObj.Value!,
        stackName,
        exportName: exportObj.Name,
      })
    }
    nextToken = response.NextToken
  } while (nextToken)

  /**
   * A --stack that matched nothing is nearly always a typo or a stack that has not deployed yet.
   * It used to pass silently as a no-op; with pruning enabled the same condition would look like
   * "every record is an orphan", so it is fatal there and a warning otherwise.
   */
  for (const stackName of options.stackNames) {
    if (!matchedStacks.has(stackName)) {
      const message = `Stack ${stackName} produced no ClouDNS exports`
      if (options.prune) throw new Error(`${message}; refusing to prune on an unverified stack name`)
      console.warn('WARN', message)
    }
  }

  for (const record of desired) {
    await createOrUpdateCloudnsResource(options.username, cloudnsPassword, record, options.ttl, options.dryRun)
  }

  if (!options.prune) return

  if (!desired.length && !options.forcePrune) {
    console.warn('WARN No exports matched, so nothing is known to be wanted; skipping prune. Use --force-prune with --zone if this is a teardown.')
    return
  }

  const zoneNames = [...new Set([...options.zoneNames, ...desired.map((record) => record.zoneName)])]
  await pruneOrphans(options.username, cloudnsPassword, zoneNames, desired, options)
}
