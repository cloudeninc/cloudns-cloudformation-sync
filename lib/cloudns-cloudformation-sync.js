"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
/**
 * Read AWS CloudFormation Exports and autogenerate ClouDNS records based on their names and values.
 * Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020-2024
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
 * Command line usage: AWS_PROFILE=xxx ts-node cloudns-cloudformation-sync.ts <cloudns-username> <cloudns-password-parameter-name> [ttl [stackName...]]
 *
 * AWS_PROFILE=xxx - Specify your AWS profile in ~/.aws/credentials as an environment variable
 * <cloudns-username> - ClouDNS API sub-auth-user
 * <cloudns-password-parameter-name> - SSM Parameter with the encrypted ClouDNS API password
 * [ttl] - Optional TTL for generated records (defaults to 300)
 * [stackName...] - Optional CloudFormation stack name(s) to limit the exports to scan (defaults to all stacks)
 */
const client_ssm_1 = require("@aws-sdk/client-ssm");
const client_cloudformation_1 = require("@aws-sdk/client-cloudformation");
const querystring = require("querystring");
// Load ~/.aws/config
process.env.AWS_SDK_LOAD_CONFIG = '1';
async function cloudnsRestCall(cloudnsUsername, cloudnsPassword, method, relativeUrl, queryOptions) {
    let fullUrl = 'https://api.cloudns.net' +
        relativeUrl +
        '?' +
        querystring.stringify(Object.assign({
            'sub-auth-user': cloudnsUsername,
            'auth-password': cloudnsPassword,
        }, queryOptions || {}));
    // console.log('Note: Calling', fullUrl)
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
    const parsedResponse = await response.json();
    return parsedResponse;
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
    // console.log('Note: Response for host', hostName1, 'in zone', zoneName1, ':', zoneResponse1)
    // console.log('Note: Response for host', hostName2, 'in zone', zoneName2, ':', zoneResponse2)
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
async function createOrUpdateCloudnsResource(cloudnsUsername, cloudnsPassword, name, type, value, ttlValue, zoneCache) {
    const { zoneName, hostName } = await autoDetectCloudnsHostAndZone(cloudnsUsername, cloudnsPassword, name, zoneCache);
    // Does the record exist?
    const recordsResponse = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/records.json', {
        'domain-name': zoneName,
        host: hostName,
        type: type,
    });
    const existingRecord = Object.values(recordsResponse)[0];
    if ((existingRecord === null || existingRecord === void 0 ? void 0 : existingRecord.host) === hostName && (existingRecord === null || existingRecord === void 0 ? void 0 : existingRecord.type) === type && (existingRecord === null || existingRecord === void 0 ? void 0 : existingRecord.ttl) === ttlValue && (existingRecord === null || existingRecord === void 0 ? void 0 : existingRecord.record) === value) {
        // Record exists already - no change
        console.log('OK', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName);
    }
    else if (existingRecord === null || existingRecord === void 0 ? void 0 : existingRecord.id) {
        // Update record
        console.log('UPDATE', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName);
        const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/mod-record.json', {
            'domain-name': zoneName,
            'record-id': existingRecord === null || existingRecord === void 0 ? void 0 : existingRecord.id,
            host: hostName,
            'record-type': type,
            record: value,
            ttl: ttlValue,
        });
        if (result.status === 'Failed') {
            throw new Error('Modify record failed: ' + (result.statusMessage || result.statusDescription));
        }
    }
    else {
        // Create record
        console.log('CREATE', name, type, ttlValue, value, 'ZONE', zoneName, 'HOST', hostName);
        const result = await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'POST', '/dns/add-record.json', {
            'domain-name': zoneName,
            host: hostName,
            'record-type': type,
            record: value,
            ttl: ttlValue,
        });
        if (result.status === 'Failed') {
            throw new Error('Add record failed: ' + (result.statusMessage || result.statusDescription));
        }
    }
}
async function main() {
    var _a, _b, _c;
    console.log('ClouDNS CloudFormation Sync by Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020-2024');
    const cloudnsUsername = process.argv[2];
    const cloudnsPasswordParameter = process.argv[3];
    const ttlValue = process.argv[4] || '300';
    const stackNames = process.argv.slice(5);
    if (!cloudnsUsername) {
        console.error('Usage: cloudns-cloudformation-sync <cloudns-username> <cloudns-password-parameter-name> [ttl [stackName...]]');
        process.exit(1);
    }
    if (!cloudnsPasswordParameter) {
        console.error('Usage: cloudns-cloudformation-sync <cloudns-username> <cloudns-password-parameter-name> [ttl [stackName...]]');
        process.exit(1);
    }
    const ssm = new client_ssm_1.SSMClient({});
    const zoneCache = {};
    const response = await ssm.send(new client_ssm_1.GetParameterCommand({
        Name: cloudnsPasswordParameter,
        WithDecryption: true,
    }));
    const cloudnsPassword = ((_a = response.Parameter) === null || _a === void 0 ? void 0 : _a.Value) || '';
    const cloudFormation = new client_cloudformation_1.CloudFormationClient({});
    let nextToken;
    do {
        const response = await cloudFormation.send(new client_cloudformation_1.ListExportsCommand({
            NextToken: nextToken,
        }));
        for (const exportObj of response.Exports || []) {
            if (stackNames.length && !stackNames.includes(exportObj.ExportingStackId || '')) {
                // Check if the name part of the ID matches arn:aws:cloudformation:eu-west-1:<xxx>:stack/<name>/<xxx>
                const m = (_b = exportObj.ExportingStackId) === null || _b === void 0 ? void 0 : _b.match(/^arn:[^:]+:cloudformation:[^:]+:[^:]+:stack\/([^\/]+)\//);
                if (!m || !stackNames.includes(m[1])) {
                    // Stack ID name part didn't match given stackName, so skip it
                    continue;
                }
            }
            if ((_c = exportObj.Name) === null || _c === void 0 ? void 0 : _c.match(/^ClouDNS:/)) {
                const nameParts = exportObj.Name.split(':');
                const resourceType = nameParts[1];
                const resourceName = nameParts.slice(2).join('.');
                const resourceValue = exportObj.Value;
                await createOrUpdateCloudnsResource(cloudnsUsername, cloudnsPassword, resourceName, resourceType, resourceValue, ttlValue, zoneCache);
            }
        }
        nextToken = response.NextToken;
    } while (nextToken);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQThKQSxvQkFxREM7QUFuTkQ7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F5Qkc7QUFDSCxvREFBb0U7QUFDcEUsMEVBQTRHO0FBQzVHLDJDQUEwQztBQUUxQyxxQkFBcUI7QUFDckIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsR0FBRyxHQUFHLENBQUE7QUFJckMsS0FBSyxVQUFVLGVBQWUsQ0FBQyxlQUF1QixFQUFFLGVBQXVCLEVBQUUsTUFBYyxFQUFFLFdBQW1CLEVBQUUsWUFBaUI7SUFDckksSUFBSSxPQUFPLEdBQ1QseUJBQXlCO1FBQ3pCLFdBQVc7UUFDWCxHQUFHO1FBQ0gsV0FBVyxDQUFDLFNBQVMsQ0FDbkIsTUFBTSxDQUFDLE1BQU0sQ0FDWDtZQUNFLGVBQWUsRUFBRSxlQUFlO1lBQ2hDLGVBQWUsRUFBRSxlQUFlO1NBQ2pDLEVBQ0QsWUFBWSxJQUFJLEVBQUUsQ0FDbkIsQ0FDRixDQUFBO0lBRUgsd0NBQXdDO0lBRXhDLE1BQU0sUUFBUSxHQUFHLE1BQU0sS0FBSyxDQUFDLE9BQU8sRUFBRTtRQUNwQyxNQUFNLEVBQUUsTUFBTTtRQUNkLE9BQU8sRUFBRTtZQUNQLGNBQWMsRUFBRSxrQkFBa0I7WUFDbEMsTUFBTSxFQUFFLGtCQUFrQjtTQUMzQjtLQUNGLENBQUMsQ0FBQTtJQUNGLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxFQUFFLENBQUM7UUFDakIsTUFBTSxTQUFTLEdBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUE7UUFDdkMsT0FBTyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQUUsUUFBUSxDQUFDLE1BQU0sRUFBRSxRQUFRLENBQUMsVUFBVSxFQUFFLFNBQVMsQ0FBQyxDQUFBO1FBQzVFLE1BQU0s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QUMsU0FBUyxDQUFBO0lBQ2hDLENBQUMsUUFBUSxTQUFTLEVBQUM7QUFDckIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUmVhZCBBV1MgQ2xvdWRGb3JtYXRpb24gRXhwb3J0cyBhbmQgYXV0b2dlbmVyYXRlIENsb3VETlMgcmVjb3JkcyBiYXNlZCBvbiB0aGVpciBuYW1lcyBhbmQgdmFsdWVzLlxuICogS2VubmV0aCBGYWxjayA8a2VubnVAY2xvdWRlbi5uZXQ+IChDKSBDbG91ZGVuIE95IDIwMjAtMjAyNFxuICpcbiAqIFRoaXMgdG9vbCBjYW4gYmUgdXNlZCB0byBhdXRvZ2VuZXJhdGUgQ2xvdUROUyByZWNvcmRzIGZvciBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZXMgbGlrZVxuICogQ2xvdWRGcm9udCBkaXN0cmlidXRpb25zIGFuZCBBUEkgR2F0ZXdheSBkb21haW5zLlxuICpcbiAqIENsb3VkRm9ybWF0aW9uIGV4cG9ydCBuYW1lIG11c3Qgc3BlY2lmeSB0aGUgcmVzb3VyY2UgdHlwZSBhbmQgcmVjb3JkIGhvc3RuYW1lIGFzIGZvbGxvd3M6XG4gKiBDbG91RE5TOkNOQU1FOm15aG9zdDpleGFtcGxlOm9yZ1xuICpcbiAqIENsb3VkRm9ybWF0aW9uIGV4cG9ydCB2YWx1ZSBtdXN0IHNwZWNpZnkgdGhlIHJlY29yZCB2YWx1ZSBhcy1pcyAoZm9yIGluc3RhbmNlLCBhIGRpc3RyaWJ1dGlvbiBkb21haW4gbmFtZSk6XG4gKiB4eHh4eHh4eHh4eHh4eC5jbG91ZGZyb250Lm5ldFxuICpcbiAqIFRoZSBhYm92ZSBleGFtcGxlIHdpbGwgZ2VuZXJhdGUgdGhlIGZvbGxvd2luZyByZWNvcmQgaW4gdGhlIENsb3VETlMgem9uZSBleGFtcGxlLm9yZzpcbiAqIG15aG9zdC5leGFtcGxlLm9yZyBDTkFNRSB4eHh4eHh4eHh4eHh4eC5jbG91ZGZyb250Lm5ldFxuICpcbiAqIE90aGVyIHJlc291cmNlIHR5cGVzIGFyZSBhbHNvIGFsbG93ZWQgKEEsIEFBQUEsIEFMSUFTLCBldGMpLlxuICpcbiAqIENvbW1hbmQgbGluZSB1c2FnZTogQVdTX1BST0ZJTEU9eHh4IHRzLW5vZGUgY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLnRzIDxjbG91ZG5zLXVzZXJuYW1lPiA8Y2xvdWRucy1wYXNzd29yZC1wYXJhbWV0ZXItbmFtZT4gW3R0bCBbc3RhY2tOYW1lLi4uXV1cbiAqXG4gKiBBV1NfUFJPRklMRT14eHggLSBTcGVjaWZ5IHlvdXIgQVdTIHByb2ZpbGUgaW4gfi8uYXdzL2NyZWRlbnRpYWxzIGFzIGFuIGVudmlyb25tZW50IHZhcmlhYmxlXG4gKiA8Y2xvdWRucy11c2VybmFtZT4gLSBDbG91RE5TIEFQSSBzdWItYXV0aC11c2VyXG4gKiA8Y2xvdWRucy1wYXNzd29yZC1wYXJhbWV0ZXItbmFtZT4gLSBTU00gUGFyYW1ldGVyIHdpdGggdGhlIGVuY3J5cHRlZCBDbG91RE5TIEFQSSBwYXNzd29yZFxuICogW3R0bF0gLSBPcHRpb25hbCBUVEwgZm9yIGdlbmVyYXRlZCByZWNvcmRzIChkZWZhdWx0cyB0byAzMDApXG4gKiBbc3RhY2tOYW1lLi4uXSAtIE9wdGlvbmFsIENsb3VkRm9ybWF0aW9uIHN0YWNrIG5hbWUocykgdG8gbGltaXQgdGhlIGV4cG9ydHMgdG8gc2NhbiAoZGVmYXVsdHMgdG8gYWxsIHN0YWNrcylcbiAqL1xuaW1wb3J0IHsgU1NNQ2xpZW50LCBHZXRQYXJhbWV0ZXJDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNzbSdcbmltcG9ydCB7IENsb3VkRm9ybWF0aW9uQ2xpZW50LCBMaXN0RXhwb3J0c0NvbW1hbmQsIExpc3RFeHBvcnRzT3V0cHV0IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWNsb3VkZm9ybWF0aW9uJ1xuaW1wb3J0ICogYXMgcXVlcnlzdHJpbmcgZnJvbSAncXVlcnlzdHJpbmcnXG5cbi8vIExvYWQgfi8uYXdzL2NvbmZpZ1xucHJvY2Vzcy5lbnYuQVdTX1NES19MT0FEX0NPTkZJRyA9ICcxJ1xuXG50eXBlIENsb3VkbnNSZXN0Q2FsbFJlc3BvbnNlID0gYW55XG5cbmFzeW5jIGZ1bmN0aW9uIGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWU6IHN0cmluZywgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsIG1ldGhvZDogc3RyaW5nLCByZWxhdGl2ZVVybDogc3RyaW5nLCBxdWVyeU9wdGlvbnM6IGFueSk6IFByb21pc2U8Q2xvdWRuc1Jlc3RDYWxsUmVzcG9uc2U+IHtcbiAgbGV0IGZ1bGxVcmwgPVxuICAgICdodHRwczovL2FwaS5jbG91ZG5zLm5ldCcgK1xuICAgIHJlbGF0aXZlVXJsICtcbiAgICAnPycgK1xuICAgIHF1ZXJ5c3RyaW5nLnN0cmluZ2lmeShcbiAgICAgIE9iamVjdC5hc3NpZ24oXG4gICAgICAgIHtcbiAgICAgICAgICAnc3ViLWF1dGgtdXNlcic6IGNsb3VkbnNVc2VybmFtZSxcbiAgICAgICAgICAnYXV0aC1wYXNzd29yZCc6IGNsb3VkbnNQYXNzd29yZCxcbiAgICAgICAgfSxcbiAgICAgICAgcXVlcnlPcHRpb25zIHx8IHt9XG4gICAgICApXG4gICAgKVxuXG4gIC8vIGNvbnNvbGUubG9nKCdOb3RlOiBDYWxsaW5nJywgZnVsbFVybClcblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKGZ1bGxVcmwsIHtcbiAgICBtZXRob2Q6IG1ldGhvZCxcbiAgICBoZWFkZXJzOiB7XG4gICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgQWNjZXB0OiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgfSxcbiAgfSlcbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKVxuICAgIGNvbnNvbGUuZXJyb3IoJ0hUVFAgRXJyb3InLCByZXNwb25zZS5zdGF0dXMsIHJlc3BvbnNlLnN0YXR1c1RleHQsIGVycm9yVGV4dClcbiAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JUZXh0KVxuICB9XG4gIGNvbnN0IHBhcnNlZFJlc3BvbnNlOiBDbG91ZG5zUmVzdENhbGxSZXNwb25zZSA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKVxuICByZXR1cm4gcGFyc2VkUmVzcG9uc2Vcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXV0b0RldGVjdENsb3VkbnNIb3N0QW5kWm9uZShjbG91ZG5zVXNlcm5hbWU6IHN0cmluZywgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgem9uZUNhY2hlOiBhbnkpIHtcbiAgY29uc3QgbmFtZVBhcnRzID0gbmFtZS5zcGxpdCgnLicpXG5cbiAgLy8gWm9uZSBhbmQgaG9zdCBuYW1lIGZvciB4eHgudGxkXG4gIGNvbnN0IGhvc3ROYW1lMSA9IG5hbWVQYXJ0cy5zbGljZSgwLCBuYW1lUGFydHMubGVuZ3RoIC0gMikuam9pbignLicpXG4gIGNvbnN0IHpvbmVOYW1lMSA9IG5hbWVQYXJ0cy5zbGljZShuYW1lUGFydHMubGVuZ3RoIC0gMikuam9pbignLicpXG5cbiAgLy8gWm9uZSBhbmQgaG9zdCBuYW1lIGZvciB4eHguc3VidGxkLnRsZFxuICBjb25zdCBob3N0TmFtZTIgPSBuYW1lUGFydHMuc2xpY2UoMCwgbmFtZVBhcnRzLmxlbmd0aCAtIDMpLmpvaW4oJy4nKVxuICBjb25zdCB6b25lTmFtZTIgPSBuYW1lUGFydHMuc2xpY2UobmFtZVBhcnRzLmxlbmd0aCAtIDMpLmpvaW4oJy4nKVxuXG4gIC8vIENoZWNrIHdoaWNoIHpvbmUgZXhpc3RzXG4gIGNvbnN0IHpvbmVSZXNwb25zZTEgPVxuICAgIHpvbmVDYWNoZVt6b25lTmFtZTFdIHx8XG4gICAgKGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ0dFVCcsICcvZG5zL2dldC16b25lLWluZm8uanNvbicsIHtcbiAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lMSxcbiAgICB9KSlcbiAgem9uZUNhY2hlW3pvbmVOYW1lMV0gPSB6b25lUmVzcG9uc2UxXG4gIGNvbnN0IHpvbmVSZXNwb25zZTIgPVxuICAgIHpvbmVDYWNoZVt6b25lTmFtZTJdIHx8XG4gICAgKGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ0dFVCcsICcvZG5zL2dldC16b25lLWluZm8uanNvbicsIHtcbiAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lMixcbiAgICB9KSlcbiAgem9uZUNhY2hlW3pvbmVOYW1lMl0gPSB6b25lUmVzcG9uc2UyXG5cbiAgLy8gY29uc29sZS5sb2coJ05vdGU6IFJlc3BvbnNlIGZvciBob3N0JywgaG9zdE5hbWUxLCAnaW4gem9uZScsIHpvbmVOYW1lMSwgJzonLCB6b25lUmVzcG9uc2UxKVxuICAvLyBjb25zb2xlLmxvZygnTm90ZTogUmVzcG9uc2UgZm9yIGhvc3QnLCBob3N0TmFtZTIsICdpbiB6b25lJywgem9uZU5hbWUyLCAnOicsIHpvbmVSZXNwb25zZTIpXG5cbiAgY29uc3Qgem9uZU5hbWUgPSB6b25lUmVzcG9uc2UxLnN0YXR1cyA9PT0gJzEnID8gem9uZU5hbWUxIDogem9uZVJlc3BvbnNlMi5zdGF0dXMgPT09ICcxJyA/IHpvbmVOYW1lMiA6ICcnXG4gIGNvbnN0IGhvc3ROYW1lID0gem9uZVJlc3BvbnNlMS5zdGF0dXMgPT09ICcxJyA/IGhvc3ROYW1lMSA6IHpvbmVSZXNwb25zZTIuc3RhdHVzID09PSAnMScgPyBob3N0TmFtZTIgOiAnJ1xuICBpZiAoIXpvbmVOYW1lKSB7XG4gICAgLy8gTmVpdGhlciB6b25lIGV4aXN0c1xuICAgIHRocm93IG5ldyBFcnJvcignWm9uZSBOb3QgRm91bmQ6ICcgKyBuYW1lKVxuICB9XG4gIHJldHVybiB7XG4gICAgaG9zdE5hbWU6IGhvc3ROYW1lLFxuICAgIHpvbmVOYW1lOiB6b25lTmFtZSxcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVPclVwZGF0ZUNsb3VkbnNSZXNvdXJjZShcbiAgY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsXG4gIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLFxuICBuYW1lOiBzdHJpbmcsXG4gIHR5cGU6IHN0cmluZyxcbiAgdmFsdWU6IHN0cmluZyxcbiAgdHRsVmFsdWU6IHN0cmluZyxcbiAgem9uZUNhY2hlOiBhbnlcbikge1xuICBjb25zdCB7IHpvbmVOYW1lLCBob3N0TmFtZSB9ID0gYXdhaXQgYXV0b0RldGVjdENsb3VkbnNIb3N0QW5kWm9uZShjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgbmFtZSwgem9uZUNhY2hlKVxuICAvLyBEb2VzIHRoZSByZWNvcmQgZXhpc3Q/XG4gIGNvbnN0IHJlY29yZHNSZXNwb25zZSA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ0dFVCcsICcvZG5zL3JlY29yZHMuanNvbicsIHtcbiAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICBob3N0OiBob3N0TmFtZSxcbiAgICB0eXBlOiB0eXBlLFxuICB9KVxuICBjb25zdCBleGlzdGluZ1JlY29yZDogYW55ID0gT2JqZWN0LnZhbHVlcyhyZWNvcmRzUmVzcG9uc2UpWzBdXG4gIGlmIChleGlzdGluZ1JlY29yZD8uaG9zdCA9PT0gaG9zdE5hbWUgJiYgZXhpc3RpbmdSZWNvcmQ/LnR5cGUgPT09IHR5cGUgJiYgZXhpc3RpbmdSZWNvcmQ/LnR0bCA9PT0gdHRsVmFsdWUgJiYgZXhpc3RpbmdSZWNvcmQ/LnJlY29yZCA9PT0gdmFsdWUpIHtcbiAgICAvLyBSZWNvcmQgZXhpc3RzIGFscmVhZHkgLSBubyBjaGFuZ2VcbiAgICBjb25zb2xlLmxvZygnT0snLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gIH0gZWxzZSBpZiAoZXhpc3RpbmdSZWNvcmQ/LmlkKSB7XG4gICAgLy8gVXBkYXRlIHJlY29yZFxuICAgIGNvbnNvbGUubG9nKCdVUERBVEUnLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnUE9TVCcsICcvZG5zL21vZC1yZWNvcmQuanNvbicsIHtcbiAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICAgJ3JlY29yZC1pZCc6IGV4aXN0aW5nUmVjb3JkPy5pZCxcbiAgICAgIGhvc3Q6IGhvc3ROYW1lLFxuICAgICAgJ3JlY29yZC10eXBlJzogdHlwZSxcbiAgICAgIHJlY29yZDogdmFsdWUsXG4gICAgICB0dGw6IHR0bFZhbHVlLFxuICAgIH0pXG4gICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09ICdGYWlsZWQnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ01vZGlmeSByZWNvcmQgZmFpbGVkOiAnICsgKHJlc3VsdC5zdGF0dXNNZXNzYWdlIHx8IHJlc3VsdC5zdGF0dXNEZXNjcmlwdGlvbikpXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIENyZWF0ZSByZWNvcmRcbiAgICBjb25zb2xlLmxvZygnQ1JFQVRFJywgbmFtZSwgdHlwZSwgdHRsVmFsdWUsIHZhbHVlLCAnWk9ORScsIHpvbmVOYW1lLCAnSE9TVCcsIGhvc3ROYW1lKVxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ1BPU1QnLCAnL2Rucy9hZGQtcmVjb3JkLmpzb24nLCB7XG4gICAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAgIGhvc3Q6IGhvc3ROYW1lLFxuICAgICAgJ3JlY29yZC10eXBlJzogdHlwZSxcbiAgICAgIHJlY29yZDogdmFsdWUsXG4gICAgICB0dGw6IHR0bFZhbHVlLFxuICAgIH0pXG4gICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09ICdGYWlsZWQnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ0FkZCByZWNvcmQgZmFpbGVkOiAnICsgKHJlc3VsdC5zdGF0dXNNZXNzYWdlIHx8IHJlc3VsdC5zdGF0dXNEZXNjcmlwdGlvbikpXG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICBjb25zb2xlLmxvZygnQ2xvdUROUyBDbG91ZEZvcm1hdGlvbiBTeW5jIGJ5IEtlbm5ldGggRmFsY2sgPGtlbm51QGNsb3VkZW4ubmV0PiAoQykgQ2xvdWRlbiBPeSAyMDIwLTIwMjQnKVxuICBjb25zdCBjbG91ZG5zVXNlcm5hbWUgPSBwcm9jZXNzLmFyZ3ZbMl1cbiAgY29uc3QgY2xvdWRuc1Bhc3N3b3JkUGFyYW1ldGVyID0gcHJvY2Vzcy5hcmd2WzNdXG4gIGNvbnN0IHR0bFZhbHVlID0gcHJvY2Vzcy5hcmd2WzRdIHx8ICczMDAnXG4gIGNvbnN0IHN0YWNrTmFtZXMgPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoNSlcbiAgaWYgKCFjbG91ZG5zVXNlcm5hbWUpIHtcbiAgICBjb25zb2xlLmVycm9yKCdVc2FnZTogY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jIDxjbG91ZG5zLXVzZXJuYW1lPiA8Y2xvdWRucy1wYXNzd29yZC1wYXJhbWV0ZXItbmFtZT4gW3R0bCBbc3RhY2tOYW1lLi4uXV0nKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG4gIGlmICghY2xvdWRuc1Bhc3N3b3JkUGFyYW1ldGVyKSB7XG4gICAgY29uc29sZS5lcnJvcignVXNhZ2U6IGNsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYyA8Y2xvdWRucy11c2VybmFtZT4gPGNsb3VkbnMtcGFzc3dvcmQtcGFyYW1ldGVyLW5hbWU+IFt0dGwgW3N0YWNrTmFtZS4uLl1dJylcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIGNvbnN0IHNzbSA9IG5ldyBTU01DbGllbnQoe30pXG4gIGNvbnN0IHpvbmVDYWNoZSA9IHt9XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBzc20uc2VuZChcbiAgICBuZXcgR2V0UGFyYW1ldGVyQ29tbWFuZCh7XG4gICAgICBOYW1lOiBjbG91ZG5zUGFzc3dvcmRQYXJhbWV0ZXIsXG4gICAgICBXaXRoRGVjcnlwdGlvbjogdHJ1ZSxcbiAgICB9KVxuICApXG4gIGNvbnN0IGNsb3VkbnNQYXNzd29yZCA9IHJlc3BvbnNlLlBhcmFtZXRlcj8uVmFsdWUgfHwgJydcblxuICBjb25zdCBjbG91ZEZvcm1hdGlvbiA9IG5ldyBDbG91ZEZvcm1hdGlvbkNsaWVudCh7fSlcbiAgbGV0IG5leHRUb2tlblxuICBkbyB7XG4gICAgY29uc3QgcmVzcG9uc2U6IExpc3RFeHBvcnRzT3V0cHV0ID0gYXdhaXQgY2xvdWRGb3JtYXRpb24uc2VuZChcbiAgICAgIG5ldyBMaXN0RXhwb3J0c0NvbW1hbmQoe1xuICAgICAgICBOZXh0VG9rZW46IG5leHRUb2tlbixcbiAgICAgIH0pXG4gICAgKVxuICAgIGZvciAoY29uc3QgZXhwb3J0T2JqIG9mIHJlc3BvbnNlLkV4cG9ydHMgfHwgW10pIHtcbiAgICAgIGlmIChzdGFja05hbWVzLmxlbmd0aCAmJiAhc3RhY2tOYW1lcy5pbmNsdWRlcyhleHBvcnRPYmouRXhwb3J0aW5nU3RhY2tJZCB8fCAnJykpIHtcbiAgICAgICAgLy8gQ2hlY2sgaWYgdGhlIG5hbWUgcGFydCBvZiB0aGUgSUQgbWF0Y2hlcyBhcm46YXdzOmNsb3VkZm9ybWF0aW9uOmV1LXdlc3QtMTo8eHh4PjpzdGFjay88bmFtZT4vPHh4eD5cbiAgICAgICAgY29uc3QgbSA9IGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkPy5tYXRjaCgvXmFybjpbXjpdKzpjbG91ZGZvcm1hdGlvbjpbXjpdKzpbXjpdKzpzdGFja1xcLyhbXlxcL10rKVxcLy8pXG4gICAgICAgIGlmICghbSB8fCAhc3RhY2tOYW1lcy5pbmNsdWRlcyhtWzFdKSkge1xuICAgICAgICAgIC8vIFN0YWNrIElEIG5hbWUgcGFydCBkaWRuJ3QgbWF0Y2ggZ2l2ZW4gc3RhY2tOYW1lLCBzbyBza2lwIGl0XG4gICAgICAgICAgY29udGludWVcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgaWYgKGV4cG9ydE9iai5OYW1lPy5tYXRjaCgvXkNsb3VETlM6LykpIHtcbiAgICAgICAgY29uc3QgbmFtZVBhcnRzID0gZXhwb3J0T2JqLk5hbWUuc3BsaXQoJzonKVxuICAgICAgICBjb25zdCByZXNvdXJjZVR5cGUgPSBuYW1lUGFydHNbMV1cbiAgICAgICAgY29uc3QgcmVzb3VyY2VOYW1lID0gbmFtZVBhcnRzLnNsaWNlKDIpLmpvaW4oJy4nKVxuICAgICAgICBjb25zdCByZXNvdXJjZVZhbHVlID0gZXhwb3J0T2JqLlZhbHVlIVxuICAgICAgICBhd2FpdCBjcmVhdGVPclVwZGF0ZUNsb3VkbnNSZXNvdXJjZShjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgcmVzb3VyY2VOYW1lLCByZXNvdXJjZVR5cGUsIHJlc291cmNlVmFsdWUsIHR0bFZhbHVlLCB6b25lQ2FjaGUpXG4gICAgICB9XG4gICAgfVxuICAgIG5leHRUb2tlbiA9IHJlc3BvbnNlLk5leHRUb2tlblxuICB9IHdoaWxlIChuZXh0VG9rZW4pXG59XG4iXX0=