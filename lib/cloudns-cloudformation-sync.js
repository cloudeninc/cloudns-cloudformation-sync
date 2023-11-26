"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = void 0;
/**
 * Read AWS CloudFormation Exports and autogenerate ClouDNS records based on their names and values.
 * Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020-2023
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
 * Command line usage: AWS_PROFILE=xxx ts-node cloudns-cloudformation-sync.ts <cloudns-username> <cloudns-password-parameter-name> [ttl [stackName]]
 *
 * AWS_PROFILE=xxx - Specify your AWS profile in ~/.aws/credentials as an environment variable
 * <cloudns-username> - ClouDNS API sub-auth-user
 * <cloudns-password-parameter-name> - SSM Parameter with the encrypted ClouDNS API password
 * [ttl] - Optional TTL for generated records (defaults to 300)
 * [stackName] - Optional CloudFormation stack name to limit the exports to scan (defaults to all stacks)
 */
const client_ssm_1 = require("@aws-sdk/client-ssm");
const client_cloudformation_1 = require("@aws-sdk/client-cloudformation");
const node_fetch_1 = require("node-fetch");
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
    const response = await (0, node_fetch_1.default)(fullUrl, {
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
    return response.json();
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
    console.log('ClouDNS CloudFormation Sync by Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020-2023');
    const cloudnsUsername = process.argv[2];
    const cloudnsPasswordParameter = process.argv[3];
    const ttlValue = process.argv[4] || '300';
    const stackName = process.argv[5] || '';
    if (!cloudnsUsername) {
        console.error('Usage: cloudns-cloudformation-sync <cloudns-username> <cloudns-password-parameter-name> [ttl [stackName]]');
        process.exit(1);
    }
    if (!cloudnsPasswordParameter) {
        console.error('Usage: cloudns-cloudformation-sync <cloudns-username> <cloudns-password-parameter-name> [ttl [stackName]]');
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
            if (stackName && exportObj.ExportingStackId !== stackName) {
                // Check if the name part of the ID matches arn:aws:cloudformation:eu-west-1:<xxx>:stack/<name>/<xxx>
                const m = (_b = exportObj.ExportingStackId) === null || _b === void 0 ? void 0 : _b.match(/^arn:[^:]+:cloudformation:[^:]+:[^:]+:stack\/([^\/]+)\//);
                if (!m || m[1] !== stackName) {
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
exports.main = main;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXlCRztBQUNILG9EQUFvRTtBQUNwRSwwRUFBNEc7QUFDNUcsMkNBQThCO0FBQzlCLDJDQUEwQztBQUUxQyxxQkFBcUI7QUFDckIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsR0FBRyxHQUFHLENBQUE7QUFFckMsS0FBSyxVQUFVLGVBQWUsQ0FBQyxlQUF1QixFQUFFLGVBQXVCLEVBQUUsTUFBYyxFQUFFLFdBQW1CLEVBQUUsWUFBaUI7SUFDckksSUFBSSxPQUFPLEdBQ1QseUJBQXlCO1FBQ3pCLFdBQVc7UUFDWCxHQUFHO1FBQ0gsV0FBVyxDQUFDLFNBQVMsQ0FDbkIsTUFBTSxDQUFDLE1BQU0sQ0FDWDtZQUNFLGVBQWUsRUFBRSxlQUFlO1lBQ2hDLGVBQWUsRUFBRSxlQUFlO1NBQ2pDLEVBQ0QsWUFBWSxJQUFJLEVBQUUsQ0FDbkIsQ0FDRixDQUFBO0lBRUgsd0NBQXdDO0lBRXhDLE1BQU0sUUFBUSxHQUFHLE1BQU0sSUFBQSxvQkFBSyxFQUFDLE9BQU8sRUFBRTtRQUNwQyxNQUFNLEVBQUUsTUFBTTtRQUNkLE9BQU8sRUFBRTtZQUNQLGNBQWMsRUFBRSxrQkFBa0I7WUFDbEMsTUFBTSxFQUFFLGtCQUFrQjtTQUMzQjtLQUNGLENBQUMsQ0FBQTtJQUNGLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxFQUFFLENBQUM7UUFDakIsTUFBTSxTQUFTLEdBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUE7UUFDdkMsT0FBTyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQUUsUUFBUSxDQUFDLE1BQU0sRUFBRSxRQUFRLENBQUMsVUFBVSxFQUFFLFNBQVMsQ0FBQyxDQUFBO1FBQzVF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UmVhZCBBV1MgQ2xvdWRGb3JtYXRpb24gRXhwb3J0cyBhbmQgYXV0b2dlbmVyYXRlIENsb3VETlMgcmVjb3JkcyBiYXNlZCBvbiB0aGVpciBuYW1lcyBhbmQgdmFsdWVzLlxuICogS2VubmV0aCBGYWxjayA8a2VubnVAY2xvdWRlbi5uZXQ+IChDKSBDbG91ZGVuIE95IDIwMjAtMjAyM1xuICpcbiAqIFRoaXMgdG9vbCBjYW4gYmUgdXNlZCB0byBhdXRvZ2VuZXJhdGUgQ2xvdUROUyByZWNvcmRzIGZvciBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZXMgbGlrZVxuICogQ2xvdWRGcm9udCBkaXN0cmlidXRpb25zIGFuZCBBUEkgR2F0ZXdheSBkb21haW5zLlxuICpcbiAqIENsb3VkRm9ybWF0aW9uIGV4cG9ydCBuYW1lIG11c3Qgc3BlY2lmeSB0aGUgcmVzb3VyY2UgdHlwZSBhbmQgcmVjb3JkIGhvc3RuYW1lIGFzIGZvbGxvd3M6XG4gKiBDbG91RE5TOkNOQU1FOm15aG9zdDpleGFtcGxlOm9yZ1xuICpcbiAqIENsb3VkRm9ybWF0aW9uIGV4cG9ydCB2YWx1ZSBtdXN0IHNwZWNpZnkgdGhlIHJlY29yZCB2YWx1ZSBhcy1pcyAoZm9yIGluc3RhbmNlLCBhIGRpc3RyaWJ1dGlvbiBkb21haW4gbmFtZSk6XG4gKiB4eHh4eHh4eHh4eHh4eC5jbG91ZGZyb250Lm5ldFxuICpcbiAqIFRoZSBhYm92ZSBleGFtcGxlIHdpbGwgZ2VuZXJhdGUgdGhlIGZvbGxvd2luZyByZWNvcmQgaW4gdGhlIENsb3VETlMgem9uZSBleGFtcGxlLm9yZzpcbiAqIG15aG9zdC5leGFtcGxlLm9yZyBDTkFNRSB4eHh4eHh4eHh4eHh4eC5jbG91ZGZyb250Lm5ldFxuICpcbiAqIE90aGVyIHJlc291cmNlIHR5cGVzIGFyZSBhbHNvIGFsbG93ZWQgKEEsIEFBQUEsIEFMSUFTLCBldGMpLlxuICpcbiAqIENvbW1hbmQgbGluZSB1c2FnZTogQVdTX1BST0ZJTEU9eHh4IHRzLW5vZGUgY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLnRzIDxjbG91ZG5zLXVzZXJuYW1lPiA8Y2xvdWRucy1wYXNzd29yZC1wYXJhbWV0ZXItbmFtZT4gW3R0bCBbc3RhY2tOYW1lXV1cbiAqXG4gKiBBV1NfUFJPRklMRT14eHggLSBTcGVjaWZ5IHlvdXIgQVdTIHByb2ZpbGUgaW4gfi8uYXdzL2NyZWRlbnRpYWxzIGFzIGFuIGVudmlyb25tZW50IHZhcmlhYmxlXG4gKiA8Y2xvdWRucy11c2VybmFtZT4gLSBDbG91RE5TIEFQSSBzdWItYXV0aC11c2VyXG4gKiA8Y2xvdWRucy1wYXNzd29yZC1wYXJhbWV0ZXItbmFtZT4gLSBTU00gUGFyYW1ldGVyIHdpdGggdGhlIGVuY3J5cHRlZCBDbG91RE5TIEFQSSBwYXNzd29yZFxuICogW3R0bF0gLSBPcHRpb25hbCBUVEwgZm9yIGdlbmVyYXRlZCByZWNvcmRzIChkZWZhdWx0cyB0byAzMDApXG4gKiBbc3RhY2tOYW1lXSAtIE9wdGlvbmFsIENsb3VkRm9ybWF0aW9uIHN0YWNrIG5hbWUgdG8gbGltaXQgdGhlIGV4cG9ydHMgdG8gc2NhbiAoZGVmYXVsdHMgdG8gYWxsIHN0YWNrcylcbiAqL1xuaW1wb3J0IHsgU1NNQ2xpZW50LCBHZXRQYXJhbWV0ZXJDb21tYW5kIH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LXNzbSdcbmltcG9ydCB7IENsb3VkRm9ybWF0aW9uQ2xpZW50LCBMaXN0RXhwb3J0c0NvbW1hbmQsIExpc3RFeHBvcnRzT3V0cHV0IH0gZnJvbSAnQGF3cy1zZGsvY2xpZW50LWNsb3VkZm9ybWF0aW9uJ1xuaW1wb3J0IGZldGNoIGZyb20gJ25vZGUtZmV0Y2gnXG5pbXBvcnQgKiBhcyBxdWVyeXN0cmluZyBmcm9tICdxdWVyeXN0cmluZydcblxuLy8gTG9hZCB+Ly5hd3MvY29uZmlnXG5wcm9jZXNzLmVudi5BV1NfU0RLX0xPQURfQ09ORklHID0gJzEnXG5cbmFzeW5jIGZ1bmN0aW9uIGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWU6IHN0cmluZywgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsIG1ldGhvZDogc3RyaW5nLCByZWxhdGl2ZVVybDogc3RyaW5nLCBxdWVyeU9wdGlvbnM6IGFueSkge1xuICBsZXQgZnVsbFVybCA9XG4gICAgJ2h0dHBzOi8vYXBpLmNsb3VkbnMubmV0JyArXG4gICAgcmVsYXRpdmVVcmwgK1xuICAgICc/JyArXG4gICAgcXVlcnlzdHJpbmcuc3RyaW5naWZ5KFxuICAgICAgT2JqZWN0LmFzc2lnbihcbiAgICAgICAge1xuICAgICAgICAgICdzdWItYXV0aC11c2VyJzogY2xvdWRuc1VzZXJuYW1lLFxuICAgICAgICAgICdhdXRoLXBhc3N3b3JkJzogY2xvdWRuc1Bhc3N3b3JkLFxuICAgICAgICB9LFxuICAgICAgICBxdWVyeU9wdGlvbnMgfHwge31cbiAgICAgIClcbiAgICApXG5cbiAgLy8gY29uc29sZS5sb2coJ05vdGU6IENhbGxpbmcnLCBmdWxsVXJsKVxuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goZnVsbFVybCwge1xuICAgIG1ldGhvZDogbWV0aG9kLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICBBY2NlcHQ6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICB9LFxuICB9KVxuICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgY29uc3QgZXJyb3JUZXh0ID0gYXdhaXQgcmVzcG9uc2UudGV4dCgpXG4gICAgY29uc29sZS5lcnJvcignSFRUUCBFcnJvcicsIHJlc3BvbnNlLnN0YXR1cywgcmVzcG9uc2Uuc3RhdHVzVGV4dCwgZXJyb3JUZXh0KVxuICAgIHRocm93IG5ldyBFcnJvcihlcnJvclRleHQpXG4gIH1cbiAgcmV0dXJuIHJlc3BvbnNlLmpzb24oKVxufVxuXG5hc3luYyBmdW5jdGlvbiBhdXRvRGV0ZWN0Q2xvdWRuc0hvc3RBbmRab25lKGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLCBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZywgbmFtZTogc3RyaW5nLCB6b25lQ2FjaGU6IGFueSkge1xuICBjb25zdCBuYW1lUGFydHMgPSBuYW1lLnNwbGl0KCcuJylcblxuICAvLyBab25lIGFuZCBob3N0IG5hbWUgZm9yIHh4eC50bGRcbiAgY29uc3QgaG9zdE5hbWUxID0gbmFtZVBhcnRzLnNsaWNlKDAsIG5hbWVQYXJ0cy5sZW5ndGggLSAyKS5qb2luKCcuJylcbiAgY29uc3Qgem9uZU5hbWUxID0gbmFtZVBhcnRzLnNsaWNlKG5hbWVQYXJ0cy5sZW5ndGggLSAyKS5qb2luKCcuJylcblxuICAvLyBab25lIGFuZCBob3N0IG5hbWUgZm9yIHh4eC5zdWJ0bGQudGxkXG4gIGNvbnN0IGhvc3ROYW1lMiA9IG5hbWVQYXJ0cy5zbGljZSgwLCBuYW1lUGFydHMubGVuZ3RoIC0gMykuam9pbignLicpXG4gIGNvbnN0IHpvbmVOYW1lMiA9IG5hbWVQYXJ0cy5zbGljZShuYW1lUGFydHMubGVuZ3RoIC0gMykuam9pbignLicpXG5cbiAgLy8gQ2hlY2sgd2hpY2ggem9uZSBleGlzdHNcbiAgY29uc3Qgem9uZVJlc3BvbnNlMSA9XG4gICAgem9uZUNhY2hlW3pvbmVOYW1lMV0gfHxcbiAgICAoYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnR0VUJywgJy9kbnMvZ2V0LXpvbmUtaW5mby5qc29uJywge1xuICAgICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUxLFxuICAgIH0pKVxuICB6b25lQ2FjaGVbem9uZU5hbWUxXSA9IHpvbmVSZXNwb25zZTFcbiAgY29uc3Qgem9uZVJlc3BvbnNlMiA9XG4gICAgem9uZUNhY2hlW3pvbmVOYW1lMl0gfHxcbiAgICAoYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnR0VUJywgJy9kbnMvZ2V0LXpvbmUtaW5mby5qc29uJywge1xuICAgICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUyLFxuICAgIH0pKVxuICB6b25lQ2FjaGVbem9uZU5hbWUyXSA9IHpvbmVSZXNwb25zZTJcblxuICAvLyBjb25zb2xlLmxvZygnTm90ZTogUmVzcG9uc2UgZm9yIGhvc3QnLCBob3N0TmFtZTEsICdpbiB6b25lJywgem9uZU5hbWUxLCAnOicsIHpvbmVSZXNwb25zZTEpXG4gIC8vIGNvbnNvbGUubG9nKCdOb3RlOiBSZXNwb25zZSBmb3IgaG9zdCcsIGhvc3ROYW1lMiwgJ2luIHpvbmUnLCB6b25lTmFtZTIsICc6Jywgem9uZVJlc3BvbnNlMilcblxuICBjb25zdCB6b25lTmFtZSA9IHpvbmVSZXNwb25zZTEuc3RhdHVzID09PSAnMScgPyB6b25lTmFtZTEgOiB6b25lUmVzcG9uc2UyLnN0YXR1cyA9PT0gJzEnID8gem9uZU5hbWUyIDogJydcbiAgY29uc3QgaG9zdE5hbWUgPSB6b25lUmVzcG9uc2UxLnN0YXR1cyA9PT0gJzEnID8gaG9zdE5hbWUxIDogem9uZVJlc3BvbnNlMi5zdGF0dXMgPT09ICcxJyA/IGhvc3ROYW1lMiA6ICcnXG4gIGlmICghem9uZU5hbWUpIHtcbiAgICAvLyBOZWl0aGVyIHpvbmUgZXhpc3RzXG4gICAgdGhyb3cgbmV3IEVycm9yKCdab25lIE5vdCBGb3VuZDogJyArIG5hbWUpXG4gIH1cbiAgcmV0dXJuIHtcbiAgICBob3N0TmFtZTogaG9zdE5hbWUsXG4gICAgem9uZU5hbWU6IHpvbmVOYW1lLFxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNyZWF0ZU9yVXBkYXRlQ2xvdWRuc1Jlc291cmNlKFxuICBjbG91ZG5zVXNlcm5hbWU6IHN0cmluZyxcbiAgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsXG4gIG5hbWU6IHN0cmluZyxcbiAgdHlwZTogc3RyaW5nLFxuICB2YWx1ZTogc3RyaW5nLFxuICB0dGxWYWx1ZTogc3RyaW5nLFxuICB6b25lQ2FjaGU6IGFueVxuKSB7XG4gIGNvbnN0IHsgem9uZU5hbWUsIGhvc3ROYW1lIH0gPSBhd2FpdCBhdXRvRGV0ZWN0Q2xvdWRuc0hvc3RBbmRab25lKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCBuYW1lLCB6b25lQ2FjaGUpXG4gIC8vIERvZXMgdGhlIHJlY29yZCBleGlzdD9cbiAgY29uc3QgcmVjb3Jkc1Jlc3BvbnNlID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnR0VUJywgJy9kbnMvcmVjb3Jkcy5qc29uJywge1xuICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgIGhvc3Q6IGhvc3ROYW1lLFxuICAgIHR5cGU6IHR5cGUsXG4gIH0pXG4gIGNvbnN0IGV4aXN0aW5nUmVjb3JkOiBhbnkgPSBPYmplY3QudmFsdWVzKHJlY29yZHNSZXNwb25zZSlbMF1cbiAgaWYgKGV4aXN0aW5nUmVjb3JkPy5ob3N0ID09PSBob3N0TmFtZSAmJiBleGlzdGluZ1JlY29yZD8udHlwZSA9PT0gdHlwZSAmJiBleGlzdGluZ1JlY29yZD8udHRsID09PSB0dGxWYWx1ZSAmJiBleGlzdGluZ1JlY29yZD8ucmVjb3JkID09PSB2YWx1ZSkge1xuICAgIC8vIFJlY29yZCBleGlzdHMgYWxyZWFkeSAtIG5vIGNoYW5nZVxuICAgIGNvbnNvbGUubG9nKCdPSycsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgfSBlbHNlIGlmIChleGlzdGluZ1JlY29yZD8uaWQpIHtcbiAgICAvLyBVcGRhdGUgcmVjb3JkXG4gICAgY29uc29sZS5sb2coJ1VQREFURScsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdQT1NUJywgJy9kbnMvbW9kLXJlY29yZC5qc29uJywge1xuICAgICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgICAncmVjb3JkLWlkJzogZXhpc3RpbmdSZWNvcmQ/LmlkLFxuICAgICAgaG9zdDogaG9zdE5hbWUsXG4gICAgICAncmVjb3JkLXR5cGUnOiB0eXBlLFxuICAgICAgcmVjb3JkOiB2YWx1ZSxcbiAgICAgIHR0bDogdHRsVmFsdWUsXG4gICAgfSlcbiAgICBpZiAocmVzdWx0LnN0YXR1cyA9PT0gJ0ZhaWxlZCcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignTW9kaWZ5IHJlY29yZCBmYWlsZWQ6ICcgKyAocmVzdWx0LnN0YXR1c01lc3NhZ2UgfHwgcmVzdWx0LnN0YXR1c0Rlc2NyaXB0aW9uKSlcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgLy8gQ3JlYXRlIHJlY29yZFxuICAgIGNvbnNvbGUubG9nKCdDUkVBVEUnLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnUE9TVCcsICcvZG5zL2FkZC1yZWNvcmQuanNvbicsIHtcbiAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICAgaG9zdDogaG9zdE5hbWUsXG4gICAgICAncmVjb3JkLXR5cGUnOiB0eXBlLFxuICAgICAgcmVjb3JkOiB2YWx1ZSxcbiAgICAgIHR0bDogdHRsVmFsdWUsXG4gICAgfSlcbiAgICBpZiAocmVzdWx0LnN0YXR1cyA9PT0gJ0ZhaWxlZCcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQWRkIHJlY29yZCBmYWlsZWQ6ICcgKyAocmVzdWx0LnN0YXR1c01lc3NhZ2UgfHwgcmVzdWx0LnN0YXR1c0Rlc2NyaXB0aW9uKSlcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1haW4oKSB7XG4gIGNvbnNvbGUubG9nKCdDbG91RE5TIENsb3VkRm9ybWF0aW9uIFN5bmMgYnkgS2VubmV0aCBGYWxjayA8a2VubnVAY2xvdWRlbi5uZXQ+IChDKSBDbG91ZGVuIE95IDIwMjAtMjAyMycpXG4gIGNvbnN0IGNsb3VkbnNVc2VybmFtZSA9IHByb2Nlc3MuYXJndlsyXVxuICBjb25zdCBjbG91ZG5zUGFzc3dvcmRQYXJhbWV0ZXIgPSBwcm9jZXNzLmFyZ3ZbM11cbiAgY29uc3QgdHRsVmFsdWUgPSBwcm9jZXNzLmFyZ3ZbNF0gfHwgJzMwMCdcbiAgY29uc3Qgc3RhY2tOYW1lID0gcHJvY2Vzcy5hcmd2WzVdIHx8ICcnXG4gIGlmICghY2xvdWRuc1VzZXJuYW1lKSB7XG4gICAgY29uc29sZS5lcnJvcignVXNhZ2U6IGNsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYyA8Y2xvdWRucy11c2VybmFtZT4gPGNsb3VkbnMtcGFzc3dvcmQtcGFyYW1ldGVyLW5hbWU+IFt0dGwgW3N0YWNrTmFtZV1dJylcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuICBpZiAoIWNsb3VkbnNQYXNzd29yZFBhcmFtZXRlcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ1VzYWdlOiBjbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMgPGNsb3VkbnMtdXNlcm5hbWU+IDxjbG91ZG5zLXBhc3N3b3JkLXBhcmFtZXRlci1uYW1lPiBbdHRsIFtzdGFja05hbWVdXScpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cblxuICBjb25zdCBzc20gPSBuZXcgU1NNQ2xpZW50KHt9KVxuICBjb25zdCB6b25lQ2FjaGUgPSB7fVxuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc3NtLnNlbmQoXG4gICAgbmV3IEdldFBhcmFtZXRlckNvbW1hbmQoe1xuICAgICAgTmFtZTogY2xvdWRuc1Bhc3N3b3JkUGFyYW1ldGVyLFxuICAgICAgV2l0aERlY3J5cHRpb246IHRydWUsXG4gICAgfSlcbiAgKVxuICBjb25zdCBjbG91ZG5zUGFzc3dvcmQgPSByZXNwb25zZS5QYXJhbWV0ZXI/LlZhbHVlIHx8ICcnXG5cbiAgY29uc3QgY2xvdWRGb3JtYXRpb24gPSBuZXcgQ2xvdWRGb3JtYXRpb25DbGllbnQoe30pXG4gIGxldCBuZXh0VG9rZW5cbiAgZG8ge1xuICAgIGNvbnN0IHJlc3BvbnNlOiBMaXN0RXhwb3J0c091dHB1dCA9IGF3YWl0IGNsb3VkRm9ybWF0aW9uLnNlbmQoXG4gICAgICBuZXcgTGlzdEV4cG9ydHNDb21tYW5kKHtcbiAgICAgICAgTmV4dFRva2VuOiBuZXh0VG9rZW4sXG4gICAgICB9KVxuICAgIClcbiAgICBmb3IgKGNvbnN0IGV4cG9ydE9iaiBvZiByZXNwb25zZS5FeHBvcnRzIHx8IFtdKSB7XG4gICAgICBpZiAoc3RhY2tOYW1lICYmIGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkICE9PSBzdGFja05hbWUpIHtcbiAgICAgICAgLy8gQ2hlY2sgaWYgdGhlIG5hbWUgcGFydCBvZiB0aGUgSUQgbWF0Y2hlcyBhcm46YXdzOmNsb3VkZm9ybWF0aW9uOmV1LXdlc3QtMTo8eHh4PjpzdGFjay88bmFtZT4vPHh4eD5cbiAgICAgICAgY29uc3QgbSA9IGV4cG9ydE9iai5FeHBvcnRpbmdTdGFja0lkPy5tYXRjaCgvXmFybjpbXjpdKzpjbG91ZGZvcm1hdGlvbjpbXjpdKzpbXjpdKzpzdGFja1xcLyhbXlxcL10rKVxcLy8pXG4gICAgICAgIGlmICghbSB8fCBtWzFdICE9PSBzdGFja05hbWUpIHtcbiAgICAgICAgICAvLyBTdGFjayBJRCBuYW1lIHBhcnQgZGlkbid0IG1hdGNoIGdpdmVuIHN0YWNrTmFtZSwgc28gc2tpcCBpdFxuICAgICAgICAgIGNvbnRpbnVlXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGlmIChleHBvcnRPYmouTmFtZT8ubWF0Y2goL15DbG91RE5TOi8pKSB7XG4gICAgICAgIGNvbnN0IG5hbWVQYXJ0cyA9IGV4cG9ydE9iai5OYW1lLnNwbGl0KCc6JylcbiAgICAgICAgY29uc3QgcmVzb3VyY2VUeXBlID0gbmFtZVBhcnRzWzFdXG4gICAgICAgIGNvbnN0IHJlc291cmNlTmFtZSA9IG5hbWVQYXJ0cy5zbGljZSgyKS5qb2luKCcuJylcbiAgICAgICAgY29uc3QgcmVzb3VyY2VWYWx1ZSA9IGV4cG9ydE9iai5WYWx1ZSFcbiAgICAgICAgYXdhaXQgY3JlYXRlT3JVcGRhdGVDbG91ZG5zUmVzb3VyY2UoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIHJlc291cmNlTmFtZSwgcmVzb3VyY2VUeXBlLCByZXNvdXJjZVZhbHVlLCB0dGxWYWx1ZSwgem9uZUNhY2hlKVxuICAgICAgfVxuICAgIH1cbiAgICBuZXh0VG9rZW4gPSByZXNwb25zZS5OZXh0VG9rZW5cbiAgfSB3aGlsZSAobmV4dFRva2VuKVxufVxuIl19