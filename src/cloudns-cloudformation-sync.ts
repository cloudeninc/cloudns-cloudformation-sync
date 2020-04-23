/**
 * Read AWS CloudFormation Exports and autogenerate ClouDNS records based on their names and values.
 * Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020
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
 * Command line usage: AWS_PROFILE=xxx ts-node cloudns-cloudformation-sync.ts <cloudns-username> <cloudns-password-parameter-name> [ttl]
 *
 * AWS_PROFILE=xxx - Specify your AWS profile in ~/.aws/credentials as an environment variable
 * <cloudns-username> - ClouDNS API sub-auth-user
 * <cloudns-password-parameter-name> - SSM Parameter with the encrypted ClouDNS API password
 * [ttl] - Optional TTL for generated records (defaults to 300)
 */
import { SSM, CloudFormation } from 'aws-sdk'
import fetch from 'node-fetch'
import * as querystring from 'querystring'

// Load ~/.aws/config
process.env.AWS_SDK_LOAD_CONFIG = '1'

async function cloudnsRestCall(cloudnsUsername: string, cloudnsPassword: string, method: string, relativeUrl: string, queryOptions: any) {
  let fullUrl = 'https://api.cloudns.net' + relativeUrl + '?' + querystring.stringify(Object.assign({
    'sub-auth-user': cloudnsUsername,
    'auth-password': cloudnsPassword,
  }, queryOptions || {}))

  const response = await fetch(fullUrl, {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }
  })
  if (!response.ok) {
    const errorText = await response.text()
    console.error('HTTP Error', response.status, response.statusText, errorText)
    throw new Error(errorText)
  }
  return response.json()
}

async function autoDetectCloudnsHostAndZone(cloudnsUsername: string, cloudnsPassword: string, name: string, zoneCache: any) {
  const nameParts = name.split('.')

  // Zone and host name for xxx.tld
  const hostName1 = nameParts.slice(0, nameParts.length-2).join('.')
  const zoneName1 = nameParts.slice(nameParts.length-2).join('.')

  // Zone and host name for xxx.subtld.tld
  const hostName2 = nameParts.slice(0, nameParts.length-3).join('.')
  const zoneName2 = nameParts.slice(nameParts.length-3).join('.')

  // Check which zone exists
  const zoneResponse1 = zoneCache[zoneName1] || await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/get-zone-info.json', {
    'domain-name': zoneName1,
  })
  zoneCache[zoneName1] = zoneResponse1
  const zoneResponse2 = zoneCache[zoneName2] || await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/get-zone-info.json', {
    'domain-name': zoneName2,
  })
  zoneCache[zoneName2] = zoneResponse2
  const zoneName = (zoneResponse1.status === '1' ? zoneName1 : zoneResponse2.status === '1' ? zoneName2 : '')
  const hostName = (zoneResponse1.status === '1' ? hostName1 : zoneResponse2.status === '1' ? hostName2 : '')
  if (!zoneName) {
    // Neither zone exists
    throw new Error('Zone Not Found: ' + name)
  }
  return {
    hostName: hostName,
    zoneName: zoneName,
  }
}

async function createOrUpdateCloudnsResource(cloudnsUsername: string, cloudnsPassword: string, name: string, type: string, value: string, ttlValue: string, zoneCache: any) {
  const { zoneName, hostName } = await autoDetectCloudnsHostAndZone(cloudnsUsername, cloudnsPassword, name, zoneCache)
  // Does the record exist?
  const recordsResponse = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/records.json', {
    'domain-name': zoneName,
    'host': hostName,
    'type': type,
  })
  const existingRecord: any = Object.values(recordsResponse)[0]
  if (existingRecord?.host === hostName && existingRecord?.type === type && existingRecord?.ttl === ttlValue && existingRecord?.record === value) {
    // Record exists already - no change
    console.log('OK', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName)
  } else if (existingRecord?.id) {
    // Update record
    console.log('UPDATE', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName)
    const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/mod-record.json', {
      'domain-name': zoneName,
      'record-id': existingRecord?.id,
      'host': hostName,
      'record-type': type,
      'record': value,
      'ttl': ttlValue,
    })
    if (result.status === 'Failed') {
      throw new Error( 'Modify record failed: ' + (result.statusMessage || result.statusDescription))
    }
  } else {
    // Create record
    console.log('CREATE', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName)
    const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/add-record.json', {
      'domain-name': zoneName,
      'host': hostName,
      'record-type': type,
      'record': value,
      'ttl': ttlValue,
    })
    if (result.status === 'Failed') {
      throw new Error( 'Add record failed: ' + (result.statusMessage || result.statusDescription))
    }
  }
}

export async function main() {
  console.log('ClouDNS CloudFormation Sync by Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020')
  const cloudnsUsername = process.argv[2]
  const cloudnsPasswordParameter = process.argv[3]
  const ttlValue = process.argv[4] || '300'
  if (!cloudnsUsername) {
    console.error('Usage: cloudns-cloudformation-sync <cloudns-username> <cloudns-password-parameter-name> [ttl]')
    process.exit(1)
  }
  if (!cloudnsPasswordParameter) {
    console.error('Usage: cloudns-cloudformation-sync <cloudns-username> <cloudns-password-parameter-name> [ttl]')
    process.exit(1)
  }

  const ssm = new SSM()
  const zoneCache = {}

  const response = await ssm.getParameter({
    Name: cloudnsPasswordParameter,
    WithDecryption: true,
  }).promise()
  const cloudnsPassword = response.Parameter?.Value || ''

  const cloudFormation = new CloudFormation()
  let nextToken
  do {
    const response: CloudFormation.ListExportsOutput = await cloudFormation.listExports({
      NextToken: nextToken,
    }).promise()
    for (const exportObj of response.Exports || []) {
      if (exportObj.Name?.match(/^ClouDNS:/)) {
        const nameParts = exportObj.Name.split(':')
        const resourceType = nameParts[1]
        const resourceName = nameParts.slice(2).join('.')
        const resourceValue = exportObj.Value!
        await createOrUpdateCloudnsResource(cloudnsUsername, cloudnsPassword, resourceName, resourceType, resourceValue, ttlValue, zoneCache)
      }
    }
    nextToken = response.NextToken
  } while (nextToken)
}

