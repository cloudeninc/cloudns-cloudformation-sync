"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = void 0;
/**
 * Read AWS CloudFormation Exports and autogenerate ClouDNS records based on their names and values.
 * Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2023
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
const client_ssm_1 = require("@aws-sdk/client-ssm");
const client_cloudformation_1 = require("@aws-sdk/client-cloudformation");
const node_fetch_1 = require("node-fetch");
const querystring = require("querystring");
// Load ~/.aws/config
process.env.AWS_SDK_LOAD_CONFIG = '1';
async function cloudnsRestCall(cloudnsUsername, cloudnsPassword, method, relativeUrl, queryOptions) {
    let fullUrl = 'https://api.cloudns.net' + relativeUrl + '?' + querystring.stringify(Object.assign({
        'sub-auth-user': cloudnsUsername,
        'auth-password': cloudnsPassword,
    }, queryOptions || {}));
    // console.log('Note: Calling', fullUrl)
    const response = await (0, node_fetch_1.default)(fullUrl, {
        method: method,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }
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
    const zoneResponse1 = zoneCache[zoneName1] || await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/get-zone-info.json', {
        'domain-name': zoneName1,
    });
    zoneCache[zoneName1] = zoneResponse1;
    const zoneResponse2 = zoneCache[zoneName2] || await cloudnsRestCall(cloudnsUsername, cloudnsPassword, 'GET', '/dns/get-zone-info.json', {
        'domain-name': zoneName2,
    });
    zoneCache[zoneName2] = zoneResponse2;
    // console.log('Note: Response for host', hostName1, 'in zone', zoneName1, ':', zoneResponse1)
    // console.log('Note: Response for host', hostName2, 'in zone', zoneName2, ':', zoneResponse2)
    const zoneName = (zoneResponse1.status === '1' ? zoneName1 : zoneResponse2.status === '1' ? zoneName2 : '');
    const hostName = (zoneResponse1.status === '1' ? hostName1 : zoneResponse2.status === '1' ? hostName2 : '');
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
        'host': hostName,
        'type': type,
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
            'host': hostName,
            'record-type': type,
            'record': value,
            'ttl': ttlValue,
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
            'host': hostName,
            'record-type': type,
            'record': value,
            'ttl': ttlValue,
        });
        if (result.status === 'Failed') {
            throw new Error('Add record failed: ' + (result.statusMessage || result.statusDescription));
        }
    }
}
async function main() {
    var _a, _b;
    console.log('ClouDNS CloudFormation Sync by Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2023');
    const cloudnsUsername = process.argv[2];
    const cloudnsPasswordParameter = process.argv[3];
    const ttlValue = process.argv[4] || '300';
    if (!cloudnsUsername) {
        console.error('Usage: cloudns-cloudformation-sync <cloudns-username> <cloudns-password-parameter-name> [ttl]');
        process.exit(1);
    }
    if (!cloudnsPasswordParameter) {
        console.error('Usage: cloudns-cloudformation-sync <cloudns-username> <cloudns-password-parameter-name> [ttl]');
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
            if ((_b = exportObj.Name) === null || _b === void 0 ? void 0 : _b.match(/^ClouDNS:/)) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBd0JHO0FBQ0gsb0RBQW9FO0FBQ3BFLDBFQUE0RztBQUM1RywyQ0FBOEI7QUFDOUIsMkNBQTBDO0FBRTFDLHFCQUFxQjtBQUNyQixPQUFPLENBQUMsR0FBRyxDQUFDLG1CQUFtQixHQUFHLEdBQUcsQ0FBQTtBQUVyQyxLQUFLLFVBQVUsZUFBZSxDQUFDLGVBQXVCLEVBQUUsZUFBdUIsRUFBRSxNQUFjLEVBQUUsV0FBbUIsRUFBRSxZQUFpQjtJQUNySSxJQUFJLE9BQU8sR0FBRyx5QkFBeUIsR0FBRyxXQUFXLEdBQUcsR0FBRyxHQUFHLFdBQVcsQ0FBQyxTQUFTLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQztRQUNoRyxlQUFlLEVBQUUsZUFBZTtRQUNoQyxlQUFlLEVBQUUsZUFBZTtLQUNqQyxFQUFFLFlBQVksSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFBO0lBRXZCLHdDQUF3QztJQUV4QyxNQUFNLFFBQVEsR0FBRyxNQUFNLElBQUEsb0JBQUssRUFBQyxPQUFPLEVBQUU7UUFDcEMsTUFBTSxFQUFFLE1BQU07UUFDZCxPQUFPLEVBQUU7WUFDUCxjQUFjLEVBQUUsa0JBQWtCO1lBQ2xDLFFBQVEsRUFBRSxrQkFBa0I7U0FDN0I7S0FDRixDQUFDLENBQUE7SUFDRixJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsRUFBRTtRQUNoQixNQUFNLFNBQVMsR0FBRyxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQTtRQUN2QyxPQUFPLENBQUMsS0FBSyxDQUFDLFlBQVksRUFBRSxRQUFRLENBQUMsTUFBTSxFQUFFLFFBQVEsQ0FBQyxVQUFVLEVBQUUsU0FBUyxDQUFDLENBQUE7UUFDNUUsTUFBTSxJ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TSxTQUFTLEdBQUcsU0FBUyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUE7Z0JBQzNDLE1BQU0sWUFBWSxHQUFHLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQTtnQkFDakMsTUFBTSxZQUFZLEdBQUcsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUE7Z0JBQ2pELE1BQU0sYUFBYSxHQUFHLFNBQVMsQ0FBQyxLQUFNLENBQUE7Z0JBQ3RDLE1BQU0sNkJBQTZCLENBQUMsZUFBZSxFQUFFLGVBQWUsRUFBRSxZQUFZLEVBQUUsWUFBWSxFQUFFLGFBQWEsRUFBRSxRQUFRLEVBQUUsU0FBUyxDQUFDLENBQUE7YUFDdEk7U0FDRjtRQUNELFNBQVMsR0FBRyxRQUFRLENBQUMsU0FBUyxDQUFBO0tBQy9CLFFBQVEsU0FBUyxFQUFDO0FBQ3JCLENBQUM7QUF4Q0Qsb0JBd0NDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZWFkIEFXUyBDbG91ZEZvcm1hdGlvbiBFeHBvcnRzIGFuZCBhdXRvZ2VuZXJhdGUgQ2xvdUROUyByZWNvcmRzIGJhc2VkIG9uIHRoZWlyIG5hbWVzIGFuZCB2YWx1ZXMuXG4gKiBLZW5uZXRoIEZhbGNrIDxrZW5udUBjbG91ZGVuLm5ldD4gKEMpIENsb3VkZW4gT3kgMjAyM1xuICpcbiAqIFRoaXMgdG9vbCBjYW4gYmUgdXNlZCB0byBhdXRvZ2VuZXJhdGUgQ2xvdUROUyByZWNvcmRzIGZvciBDbG91ZEZvcm1hdGlvbiByZXNvdXJjZXMgbGlrZVxuICogQ2xvdWRGcm9udCBkaXN0cmlidXRpb25zIGFuZCBBUEkgR2F0ZXdheSBkb21haW5zLlxuICpcbiAqIENsb3VkRm9ybWF0aW9uIGV4cG9ydCBuYW1lIG11c3Qgc3BlY2lmeSB0aGUgcmVzb3VyY2UgdHlwZSBhbmQgcmVjb3JkIGhvc3RuYW1lIGFzIGZvbGxvd3M6XG4gKiBDbG91RE5TOkNOQU1FOm15aG9zdDpleGFtcGxlOm9yZ1xuICpcbiAqIENsb3VkRm9ybWF0aW9uIGV4cG9ydCB2YWx1ZSBtdXN0IHNwZWNpZnkgdGhlIHJlY29yZCB2YWx1ZSBhcy1pcyAoZm9yIGluc3RhbmNlLCBhIGRpc3RyaWJ1dGlvbiBkb21haW4gbmFtZSk6XG4gKiB4eHh4eHh4eHh4eHh4eC5jbG91ZGZyb250Lm5ldFxuICpcbiAqIFRoZSBhYm92ZSBleGFtcGxlIHdpbGwgZ2VuZXJhdGUgdGhlIGZvbGxvd2luZyByZWNvcmQgaW4gdGhlIENsb3VETlMgem9uZSBleGFtcGxlLm9yZzpcbiAqIG15aG9zdC5leGFtcGxlLm9yZyBDTkFNRSB4eHh4eHh4eHh4eHh4eC5jbG91ZGZyb250Lm5ldFxuICpcbiAqIE90aGVyIHJlc291cmNlIHR5cGVzIGFyZSBhbHNvIGFsbG93ZWQgKEEsIEFBQUEsIEFMSUFTLCBldGMpLlxuICpcbiAqIENvbW1hbmQgbGluZSB1c2FnZTogQVdTX1BST0ZJTEU9eHh4IHRzLW5vZGUgY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLnRzIDxjbG91ZG5zLXVzZXJuYW1lPiA8Y2xvdWRucy1wYXNzd29yZC1wYXJhbWV0ZXItbmFtZT4gW3R0bF1cbiAqXG4gKiBBV1NfUFJPRklMRT14eHggLSBTcGVjaWZ5IHlvdXIgQVdTIHByb2ZpbGUgaW4gfi8uYXdzL2NyZWRlbnRpYWxzIGFzIGFuIGVudmlyb25tZW50IHZhcmlhYmxlXG4gKiA8Y2xvdWRucy11c2VybmFtZT4gLSBDbG91RE5TIEFQSSBzdWItYXV0aC11c2VyXG4gKiA8Y2xvdWRucy1wYXNzd29yZC1wYXJhbWV0ZXItbmFtZT4gLSBTU00gUGFyYW1ldGVyIHdpdGggdGhlIGVuY3J5cHRlZCBDbG91RE5TIEFQSSBwYXNzd29yZFxuICogW3R0bF0gLSBPcHRpb25hbCBUVEwgZm9yIGdlbmVyYXRlZCByZWNvcmRzIChkZWZhdWx0cyB0byAzMDApXG4gKi9cbmltcG9ydCB7IFNTTUNsaWVudCwgR2V0UGFyYW1ldGVyQ29tbWFuZCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1zc20nXG5pbXBvcnQgeyBDbG91ZEZvcm1hdGlvbkNsaWVudCwgTGlzdEV4cG9ydHNDb21tYW5kLCBMaXN0RXhwb3J0c091dHB1dCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1jbG91ZGZvcm1hdGlvbidcbmltcG9ydCBmZXRjaCBmcm9tICdub2RlLWZldGNoJ1xuaW1wb3J0ICogYXMgcXVlcnlzdHJpbmcgZnJvbSAncXVlcnlzdHJpbmcnXG5cbi8vIExvYWQgfi8uYXdzL2NvbmZpZ1xucHJvY2Vzcy5lbnYuQVdTX1NES19MT0FEX0NPTkZJRyA9ICcxJ1xuXG5hc3luYyBmdW5jdGlvbiBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCBtZXRob2Q6IHN0cmluZywgcmVsYXRpdmVVcmw6IHN0cmluZywgcXVlcnlPcHRpb25zOiBhbnkpIHtcbiAgbGV0IGZ1bGxVcmwgPSAnaHR0cHM6Ly9hcGkuY2xvdWRucy5uZXQnICsgcmVsYXRpdmVVcmwgKyAnPycgKyBxdWVyeXN0cmluZy5zdHJpbmdpZnkoT2JqZWN0LmFzc2lnbih7XG4gICAgJ3N1Yi1hdXRoLXVzZXInOiBjbG91ZG5zVXNlcm5hbWUsXG4gICAgJ2F1dGgtcGFzc3dvcmQnOiBjbG91ZG5zUGFzc3dvcmQsXG4gIH0sIHF1ZXJ5T3B0aW9ucyB8fCB7fSkpXG5cbiAgLy8gY29uc29sZS5sb2coJ05vdGU6IENhbGxpbmcnLCBmdWxsVXJsKVxuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goZnVsbFVybCwge1xuICAgIG1ldGhvZDogbWV0aG9kLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgIH1cbiAgfSlcbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKVxuICAgIGNvbnNvbGUuZXJyb3IoJ0hUVFAgRXJyb3InLCByZXNwb25zZS5zdGF0dXMsIHJlc3BvbnNlLnN0YXR1c1RleHQsIGVycm9yVGV4dClcbiAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JUZXh0KVxuICB9XG4gIHJldHVybiByZXNwb25zZS5qc29uKClcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXV0b0RldGVjdENsb3VkbnNIb3N0QW5kWm9uZShjbG91ZG5zVXNlcm5hbWU6IHN0cmluZywgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgem9uZUNhY2hlOiBhbnkpIHtcbiAgY29uc3QgbmFtZVBhcnRzID0gbmFtZS5zcGxpdCgnLicpXG5cbiAgLy8gWm9uZSBhbmQgaG9zdCBuYW1lIGZvciB4eHgudGxkXG4gIGNvbnN0IGhvc3ROYW1lMSA9IG5hbWVQYXJ0cy5zbGljZSgwLCBuYW1lUGFydHMubGVuZ3RoLTIpLmpvaW4oJy4nKVxuICBjb25zdCB6b25lTmFtZTEgPSBuYW1lUGFydHMuc2xpY2UobmFtZVBhcnRzLmxlbmd0aC0yKS5qb2luKCcuJylcblxuICAvLyBab25lIGFuZCBob3N0IG5hbWUgZm9yIHh4eC5zdWJ0bGQudGxkXG4gIGNvbnN0IGhvc3ROYW1lMiA9IG5hbWVQYXJ0cy5zbGljZSgwLCBuYW1lUGFydHMubGVuZ3RoLTMpLmpvaW4oJy4nKVxuICBjb25zdCB6b25lTmFtZTIgPSBuYW1lUGFydHMuc2xpY2UobmFtZVBhcnRzLmxlbmd0aC0zKS5qb2luKCcuJylcblxuICAvLyBDaGVjayB3aGljaCB6b25lIGV4aXN0c1xuICBjb25zdCB6b25lUmVzcG9uc2UxID0gem9uZUNhY2hlW3pvbmVOYW1lMV0gfHwgYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnR0VUJywgJy9kbnMvZ2V0LXpvbmUtaW5mby5qc29uJywge1xuICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lMSxcbiAgfSlcbiAgem9uZUNhY2hlW3pvbmVOYW1lMV0gPSB6b25lUmVzcG9uc2UxXG4gIGNvbnN0IHpvbmVSZXNwb25zZTIgPSB6b25lQ2FjaGVbem9uZU5hbWUyXSB8fCBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdHRVQnLCAnL2Rucy9nZXQtem9uZS1pbmZvLmpzb24nLCB7XG4gICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUyLFxuICB9KVxuICB6b25lQ2FjaGVbem9uZU5hbWUyXSA9IHpvbmVSZXNwb25zZTJcblxuICAvLyBjb25zb2xlLmxvZygnTm90ZTogUmVzcG9uc2UgZm9yIGhvc3QnLCBob3N0TmFtZTEsICdpbiB6b25lJywgem9uZU5hbWUxLCAnOicsIHpvbmVSZXNwb25zZTEpXG4gIC8vIGNvbnNvbGUubG9nKCdOb3RlOiBSZXNwb25zZSBmb3IgaG9zdCcsIGhvc3ROYW1lMiwgJ2luIHpvbmUnLCB6b25lTmFtZTIsICc6Jywgem9uZVJlc3BvbnNlMilcblxuICBjb25zdCB6b25lTmFtZSA9ICh6b25lUmVzcG9uc2UxLnN0YXR1cyA9PT0gJzEnID8gem9uZU5hbWUxIDogem9uZVJlc3BvbnNlMi5zdGF0dXMgPT09ICcxJyA/IHpvbmVOYW1lMiA6ICcnKVxuICBjb25zdCBob3N0TmFtZSA9ICh6b25lUmVzcG9uc2UxLnN0YXR1cyA9PT0gJzEnID8gaG9zdE5hbWUxIDogem9uZVJlc3BvbnNlMi5zdGF0dXMgPT09ICcxJyA/IGhvc3ROYW1lMiA6ICcnKVxuICBpZiAoIXpvbmVOYW1lKSB7XG4gICAgLy8gTmVpdGhlciB6b25lIGV4aXN0c1xuICAgIHRocm93IG5ldyBFcnJvcignWm9uZSBOb3QgRm91bmQ6ICcgKyBuYW1lKVxuICB9XG4gIHJldHVybiB7XG4gICAgaG9zdE5hbWU6IGhvc3ROYW1lLFxuICAgIHpvbmVOYW1lOiB6b25lTmFtZSxcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjcmVhdGVPclVwZGF0ZUNsb3VkbnNSZXNvdXJjZShjbG91ZG5zVXNlcm5hbWU6IHN0cmluZywgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgdHlwZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nLCB0dGxWYWx1ZTogc3RyaW5nLCB6b25lQ2FjaGU6IGFueSkge1xuICBjb25zdCB7IHpvbmVOYW1lLCBob3N0TmFtZSB9ID0gYXdhaXQgYXV0b0RldGVjdENsb3VkbnNIb3N0QW5kWm9uZShjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgbmFtZSwgem9uZUNhY2hlKVxuICAvLyBEb2VzIHRoZSByZWNvcmQgZXhpc3Q/XG4gIGNvbnN0IHJlY29yZHNSZXNwb25zZSA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ0dFVCcsICcvZG5zL3JlY29yZHMuanNvbicsIHtcbiAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAnaG9zdCc6IGhvc3ROYW1lLFxuICAgICd0eXBlJzogdHlwZSxcbiAgfSlcbiAgY29uc3QgZXhpc3RpbmdSZWNvcmQ6IGFueSA9IE9iamVjdC52YWx1ZXMocmVjb3Jkc1Jlc3BvbnNlKVswXVxuICBpZiAoZXhpc3RpbmdSZWNvcmQ/Lmhvc3QgPT09IGhvc3ROYW1lICYmIGV4aXN0aW5nUmVjb3JkPy50eXBlID09PSB0eXBlICYmIGV4aXN0aW5nUmVjb3JkPy50dGwgPT09IHR0bFZhbHVlICYmIGV4aXN0aW5nUmVjb3JkPy5yZWNvcmQgPT09IHZhbHVlKSB7XG4gICAgLy8gUmVjb3JkIGV4aXN0cyBhbHJlYWR5IC0gbm8gY2hhbmdlXG4gICAgY29uc29sZS5sb2coJ09LJywgbmFtZSwgdHlwZSwgdHRsVmFsdWUsIHZhbHVlLCAnWk9ORScsIHpvbmVOYW1lLCAnSE9TVCcsIGhvc3ROYW1lKVxuICB9IGVsc2UgaWYgKGV4aXN0aW5nUmVjb3JkPy5pZCkge1xuICAgIC8vIFVwZGF0ZSByZWNvcmRcbiAgICBjb25zb2xlLmxvZygnVVBEQVRFJywgbmFtZSwgdHlwZSwgdHRsVmFsdWUsIHZhbHVlLCAnWk9ORScsIHpvbmVOYW1lLCAnSE9TVCcsIGhvc3ROYW1lKVxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ1BPU1QnLCAnL2Rucy9tb2QtcmVjb3JkLmpzb24nLCB7XG4gICAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAgICdyZWNvcmQtaWQnOiBleGlzdGluZ1JlY29yZD8uaWQsXG4gICAgICAnaG9zdCc6IGhvc3ROYW1lLFxuICAgICAgJ3JlY29yZC10eXBlJzogdHlwZSxcbiAgICAgICdyZWNvcmQnOiB2YWx1ZSxcbiAgICAgICd0dGwnOiB0dGxWYWx1ZSxcbiAgICB9KVxuICAgIGlmIChyZXN1bHQuc3RhdHVzID09PSAnRmFpbGVkJykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCAnTW9kaWZ5IHJlY29yZCBmYWlsZWQ6ICcgKyAocmVzdWx0LnN0YXR1c01lc3NhZ2UgfHwgcmVzdWx0LnN0YXR1c0Rlc2NyaXB0aW9uKSlcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgLy8gQ3JlYXRlIHJlY29yZFxuICAgIGNvbnNvbGUubG9nKCdDUkVBVEUnLCBuYW1lLCB0eXBlLCB0dGxWYWx1ZSwgdmFsdWUsICdaT05FJywgem9uZU5hbWUsICdIT1NUJywgaG9zdE5hbWUpXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnUE9TVCcsICcvZG5zL2FkZC1yZWNvcmQuanNvbicsIHtcbiAgICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lLFxuICAgICAgJ2hvc3QnOiBob3N0TmFtZSxcbiAgICAgICdyZWNvcmQtdHlwZSc6IHR5cGUsXG4gICAgICAncmVjb3JkJzogdmFsdWUsXG4gICAgICAndHRsJzogdHRsVmFsdWUsXG4gICAgfSlcbiAgICBpZiAocmVzdWx0LnN0YXR1cyA9PT0gJ0ZhaWxlZCcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvciggJ0FkZCByZWNvcmQgZmFpbGVkOiAnICsgKHJlc3VsdC5zdGF0dXNNZXNzYWdlIHx8IHJlc3VsdC5zdGF0dXNEZXNjcmlwdGlvbikpXG4gICAgfVxuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtYWluKCkge1xuICBjb25zb2xlLmxvZygnQ2xvdUROUyBDbG91ZEZvcm1hdGlvbiBTeW5jIGJ5IEtlbm5ldGggRmFsY2sgPGtlbm51QGNsb3VkZW4ubmV0PiAoQykgQ2xvdWRlbiBPeSAyMDIzJylcbiAgY29uc3QgY2xvdWRuc1VzZXJuYW1lID0gcHJvY2Vzcy5hcmd2WzJdXG4gIGNvbnN0IGNsb3VkbnNQYXNzd29yZFBhcmFtZXRlciA9IHByb2Nlc3MuYXJndlszXVxuICBjb25zdCB0dGxWYWx1ZSA9IHByb2Nlc3MuYXJndls0XSB8fCAnMzAwJ1xuICBpZiAoIWNsb3VkbnNVc2VybmFtZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoJ1VzYWdlOiBjbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMgPGNsb3VkbnMtdXNlcm5hbWU+IDxjbG91ZG5zLXBhc3N3b3JkLXBhcmFtZXRlci1uYW1lPiBbdHRsXScpXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cbiAgaWYgKCFjbG91ZG5zUGFzc3dvcmRQYXJhbWV0ZXIpIHtcbiAgICBjb25zb2xlLmVycm9yKCdVc2FnZTogY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jIDxjbG91ZG5zLXVzZXJuYW1lPiA8Y2xvdWRucy1wYXNzd29yZC1wYXJhbWV0ZXItbmFtZT4gW3R0bF0nKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG5cbiAgY29uc3Qgc3NtID0gbmV3IFNTTUNsaWVudCh7fSlcbiAgY29uc3Qgem9uZUNhY2hlID0ge31cblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHNzbS5zZW5kKG5ldyBHZXRQYXJhbWV0ZXJDb21tYW5kKHtcbiAgICBOYW1lOiBjbG91ZG5zUGFzc3dvcmRQYXJhbWV0ZXIsXG4gICAgV2l0aERlY3J5cHRpb246IHRydWUsXG4gIH0pKVxuICBjb25zdCBjbG91ZG5zUGFzc3dvcmQgPSByZXNwb25zZS5QYXJhbWV0ZXI/LlZhbHVlIHx8ICcnXG5cbiAgY29uc3QgY2xvdWRGb3JtYXRpb24gPSBuZXcgQ2xvdWRGb3JtYXRpb25DbGllbnQoe30pXG4gIGxldCBuZXh0VG9rZW5cbiAgZG8ge1xuICAgIGNvbnN0IHJlc3BvbnNlOiBMaXN0RXhwb3J0c091dHB1dCA9IGF3YWl0IGNsb3VkRm9ybWF0aW9uLnNlbmQobmV3IExpc3RFeHBvcnRzQ29tbWFuZCh7XG4gICAgICBOZXh0VG9rZW46IG5leHRUb2tlbixcbiAgICB9KSlcbiAgICBmb3IgKGNvbnN0IGV4cG9ydE9iaiBvZiByZXNwb25zZS5FeHBvcnRzIHx8IFtdKSB7XG4gICAgICBpZiAoZXhwb3J0T2JqLk5hbWU/Lm1hdGNoKC9eQ2xvdUROUzovKSkge1xuICAgICAgICBjb25zdCBuYW1lUGFydHMgPSBleHBvcnRPYmouTmFtZS5zcGxpdCgnOicpXG4gICAgICAgIGNvbnN0IHJlc291cmNlVHlwZSA9IG5hbWVQYXJ0c1sxXVxuICAgICAgICBjb25zdCByZXNvdXJjZU5hbWUgPSBuYW1lUGFydHMuc2xpY2UoMikuam9pbignLicpXG4gICAgICAgIGNvbnN0IHJlc291cmNlVmFsdWUgPSBleHBvcnRPYmouVmFsdWUhXG4gICAgICAgIGF3YWl0IGNyZWF0ZU9yVXBkYXRlQ2xvdWRuc1Jlc291cmNlKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCByZXNvdXJjZU5hbWUsIHJlc291cmNlVHlwZSwgcmVzb3VyY2VWYWx1ZSwgdHRsVmFsdWUsIHpvbmVDYWNoZSlcbiAgICAgIH1cbiAgICB9XG4gICAgbmV4dFRva2VuID0gcmVzcG9uc2UuTmV4dFRva2VuXG4gIH0gd2hpbGUgKG5leHRUb2tlbilcbn1cblxuIl19