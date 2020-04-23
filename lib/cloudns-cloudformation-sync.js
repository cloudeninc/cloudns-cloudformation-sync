"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
const aws_sdk_1 = require("aws-sdk");
const node_fetch_1 = require("node-fetch");
const querystring = require("querystring");
// Load ~/.aws/config
process.env.AWS_SDK_LOAD_CONFIG = '1';
async function cloudnsRestCall(cloudnsUsername, cloudnsPassword, method, relativeUrl, queryOptions) {
    let fullUrl = 'https://api.cloudns.net' + relativeUrl + '?' + querystring.stringify(Object.assign({
        'sub-auth-user': cloudnsUsername,
        'auth-password': cloudnsPassword,
    }, queryOptions || {}));
    const response = await node_fetch_1.default(fullUrl, {
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
    console.log('ClouDNS CloudFormation Sync by Kenneth Falck <kennu@clouden.net> (C) Clouden Oy 2020');
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
    const ssm = new aws_sdk_1.SSM();
    const zoneCache = {};
    const response = await ssm.getParameter({
        Name: cloudnsPasswordParameter,
        WithDecryption: true,
    }).promise();
    const cloudnsPassword = ((_a = response.Parameter) === null || _a === void 0 ? void 0 : _a.Value) || '';
    const cloudFormation = new aws_sdk_1.CloudFormation();
    let nextToken;
    do {
        const response = await cloudFormation.listExports({
            NextToken: nextToken,
        }).promise();
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL2Nsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOztBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F3Qkc7QUFDSCxxQ0FBNkM7QUFDN0MsMkNBQThCO0FBQzlCLDJDQUEwQztBQUUxQyxxQkFBcUI7QUFDckIsT0FBTyxDQUFDLEdBQUcsQ0FBQyxtQkFBbUIsR0FBRyxHQUFHLENBQUE7QUFFckMsS0FBSyxVQUFVLGVBQWUsQ0FBQyxlQUF1QixFQUFFLGVBQXVCLEVBQUUsTUFBYyxFQUFFLFdBQW1CLEVBQUUsWUFBaUI7SUFDckksSUFBSSxPQUFPLEdBQUcseUJBQXlCLEdBQUcsV0FBVyxHQUFHLEdBQUcsR0FBRyxXQUFXLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUM7UUFDaEcsZUFBZSxFQUFFLGVBQWU7UUFDaEMsZUFBZSxFQUFFLGVBQWU7S0FDakMsRUFBRSxZQUFZLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQTtJQUV2QixNQUFNLFFBQVEsR0FBRyxNQUFNLG9CQUFLLENBQUMsT0FBTyxFQUFFO1FBQ3BDLE1BQU0sRUFBRSxNQUFNO1FBQ2QsT0FBTyxFQUFFO1lBQ1AsY0FBYyxFQUFFLGtCQUFrQjtZQUNsQyxRQUFRLEVBQUUsa0JBQWtCO1NBQzdCO0tBQ0YsQ0FBQyxDQUFBO0lBQ0YsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLEVBQUU7UUFDaEIsTUFBTSxTQUFTLEdBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxFQUFFLENBQUE7UUFDdkMsT0FBTyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQUUsUUFBUSxDQUFDLE1BQU0sRUFBRSxRQUFRLENBQUMsVUFBVSxFQUFFLFNBQVMsQ0FBQyxDQUFBO1FBQzVFLE1BQU0sSUFBSSxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUE7S0FD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QyxNQUFNLFlBQVksR0FBRyxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQTtnQkFDakQsTUFBTSxhQUFhLEdBQUcsU0FBUyxDQUFDLEtBQU0sQ0FBQTtnQkFDdEMsTUFBTSw2QkFBNkIsQ0FBQyxlQUFlLEVBQUUsZUFBZSxFQUFFLFlBQVksRUFBRSxZQUFZLEVBQUUsYUFBYSxFQUFFLFFBQVEsRUFBRSxTQUFTLENBQUMsQ0FBQTthQUN0STtTQUNGO1FBQ0QsU0FBUyxHQUFHLFFBQVEsQ0FBQyxTQUFTLENBQUE7S0FDL0IsUUFBUSxTQUFTLEVBQUM7QUFDckIsQ0FBQztBQXhDRCxvQkF3Q0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJlYWQgQVdTIENsb3VkRm9ybWF0aW9uIEV4cG9ydHMgYW5kIGF1dG9nZW5lcmF0ZSBDbG91RE5TIHJlY29yZHMgYmFzZWQgb24gdGhlaXIgbmFtZXMgYW5kIHZhbHVlcy5cbiAqIEtlbm5ldGggRmFsY2sgPGtlbm51QGNsb3VkZW4ubmV0PiAoQykgQ2xvdWRlbiBPeSAyMDIwXG4gKlxuICogVGhpcyB0b29sIGNhbiBiZSB1c2VkIHRvIGF1dG9nZW5lcmF0ZSBDbG91RE5TIHJlY29yZHMgZm9yIENsb3VkRm9ybWF0aW9uIHJlc291cmNlcyBsaWtlXG4gKiBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbnMgYW5kIEFQSSBHYXRld2F5IGRvbWFpbnMuXG4gKlxuICogQ2xvdWRGb3JtYXRpb24gZXhwb3J0IG5hbWUgbXVzdCBzcGVjaWZ5IHRoZSByZXNvdXJjZSB0eXBlIGFuZCByZWNvcmQgaG9zdG5hbWUgYXMgZm9sbG93czpcbiAqIENsb3VETlM6Q05BTUU6bXlob3N0OmV4YW1wbGU6b3JnXG4gKlxuICogQ2xvdWRGb3JtYXRpb24gZXhwb3J0IHZhbHVlIG11c3Qgc3BlY2lmeSB0aGUgcmVjb3JkIHZhbHVlIGFzLWlzIChmb3IgaW5zdGFuY2UsIGEgZGlzdHJpYnV0aW9uIGRvbWFpbiBuYW1lKTpcbiAqIHh4eHh4eHh4eHh4eHh4LmNsb3VkZnJvbnQubmV0XG4gKlxuICogVGhlIGFib3ZlIGV4YW1wbGUgd2lsbCBnZW5lcmF0ZSB0aGUgZm9sbG93aW5nIHJlY29yZCBpbiB0aGUgQ2xvdUROUyB6b25lIGV4YW1wbGUub3JnOlxuICogbXlob3N0LmV4YW1wbGUub3JnIENOQU1FIHh4eHh4eHh4eHh4eHh4LmNsb3VkZnJvbnQubmV0XG4gKlxuICogT3RoZXIgcmVzb3VyY2UgdHlwZXMgYXJlIGFsc28gYWxsb3dlZCAoQSwgQUFBQSwgQUxJQVMsIGV0YykuXG4gKlxuICogQ29tbWFuZCBsaW5lIHVzYWdlOiBBV1NfUFJPRklMRT14eHggdHMtbm9kZSBjbG91ZG5zLWNsb3VkZm9ybWF0aW9uLXN5bmMudHMgPGNsb3VkbnMtdXNlcm5hbWU+IDxjbG91ZG5zLXBhc3N3b3JkLXBhcmFtZXRlci1uYW1lPiBbdHRsXVxuICpcbiAqIEFXU19QUk9GSUxFPXh4eCAtIFNwZWNpZnkgeW91ciBBV1MgcHJvZmlsZSBpbiB+Ly5hd3MvY3JlZGVudGlhbHMgYXMgYW4gZW52aXJvbm1lbnQgdmFyaWFibGVcbiAqIDxjbG91ZG5zLXVzZXJuYW1lPiAtIENsb3VETlMgQVBJIHN1Yi1hdXRoLXVzZXJcbiAqIDxjbG91ZG5zLXBhc3N3b3JkLXBhcmFtZXRlci1uYW1lPiAtIFNTTSBQYXJhbWV0ZXIgd2l0aCB0aGUgZW5jcnlwdGVkIENsb3VETlMgQVBJIHBhc3N3b3JkXG4gKiBbdHRsXSAtIE9wdGlvbmFsIFRUTCBmb3IgZ2VuZXJhdGVkIHJlY29yZHMgKGRlZmF1bHRzIHRvIDMwMClcbiAqL1xuaW1wb3J0IHsgU1NNLCBDbG91ZEZvcm1hdGlvbiB9IGZyb20gJ2F3cy1zZGsnXG5pbXBvcnQgZmV0Y2ggZnJvbSAnbm9kZS1mZXRjaCdcbmltcG9ydCAqIGFzIHF1ZXJ5c3RyaW5nIGZyb20gJ3F1ZXJ5c3RyaW5nJ1xuXG4vLyBMb2FkIH4vLmF3cy9jb25maWdcbnByb2Nlc3MuZW52LkFXU19TREtfTE9BRF9DT05GSUcgPSAnMSdcblxuYXN5bmMgZnVuY3Rpb24gY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZTogc3RyaW5nLCBjbG91ZG5zUGFzc3dvcmQ6IHN0cmluZywgbWV0aG9kOiBzdHJpbmcsIHJlbGF0aXZlVXJsOiBzdHJpbmcsIHF1ZXJ5T3B0aW9uczogYW55KSB7XG4gIGxldCBmdWxsVXJsID0gJ2h0dHBzOi8vYXBpLmNsb3VkbnMubmV0JyArIHJlbGF0aXZlVXJsICsgJz8nICsgcXVlcnlzdHJpbmcuc3RyaW5naWZ5KE9iamVjdC5hc3NpZ24oe1xuICAgICdzdWItYXV0aC11c2VyJzogY2xvdWRuc1VzZXJuYW1lLFxuICAgICdhdXRoLXBhc3N3b3JkJzogY2xvdWRuc1Bhc3N3b3JkLFxuICB9LCBxdWVyeU9wdGlvbnMgfHwge30pKVxuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goZnVsbFVybCwge1xuICAgIG1ldGhvZDogbWV0aG9kLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAnQWNjZXB0JzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgIH1cbiAgfSlcbiAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgIGNvbnN0IGVycm9yVGV4dCA9IGF3YWl0IHJlc3BvbnNlLnRleHQoKVxuICAgIGNvbnNvbGUuZXJyb3IoJ0hUVFAgRXJyb3InLCByZXNwb25zZS5zdGF0dXMsIHJlc3BvbnNlLnN0YXR1c1RleHQsIGVycm9yVGV4dClcbiAgICB0aHJvdyBuZXcgRXJyb3IoZXJyb3JUZXh0KVxuICB9XG4gIHJldHVybiByZXNwb25zZS5qc29uKClcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXV0b0RldGVjdENsb3VkbnNIb3N0QW5kWm9uZShjbG91ZG5zVXNlcm5hbWU6IHN0cmluZywgY2xvdWRuc1Bhc3N3b3JkOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgem9uZUNhY2hlOiBhbnkpIHtcbiAgY29uc3QgbmFtZVBhcnRzID0gbmFtZS5zcGxpdCgnLicpXG5cbiAgLy8gWm9uZSBhbmQgaG9zdCBuYW1lIGZvciB4eHgudGxkXG4gIGNvbnN0IGhvc3ROYW1lMSA9IG5hbWVQYXJ0cy5zbGljZSgwLCBuYW1lUGFydHMubGVuZ3RoLTIpLmpvaW4oJy4nKVxuICBjb25zdCB6b25lTmFtZTEgPSBuYW1lUGFydHMuc2xpY2UobmFtZVBhcnRzLmxlbmd0aC0yKS5qb2luKCcuJylcblxuICAvLyBab25lIGFuZCBob3N0IG5hbWUgZm9yIHh4eC5zdWJ0bGQudGxkXG4gIGNvbnN0IGhvc3ROYW1lMiA9IG5hbWVQYXJ0cy5zbGljZSgwLCBuYW1lUGFydHMubGVuZ3RoLTMpLmpvaW4oJy4nKVxuICBjb25zdCB6b25lTmFtZTIgPSBuYW1lUGFydHMuc2xpY2UobmFtZVBhcnRzLmxlbmd0aC0zKS5qb2luKCcuJylcblxuICAvLyBDaGVjayB3aGljaCB6b25lIGV4aXN0c1xuICBjb25zdCB6b25lUmVzcG9uc2UxID0gem9uZUNhY2hlW3pvbmVOYW1lMV0gfHwgYXdhaXQgY2xvdWRuc1Jlc3RDYWxsKGNsb3VkbnNVc2VybmFtZSwgY2xvdWRuc1Bhc3N3b3JkLCAnR0VUJywgJy9kbnMvZ2V0LXpvbmUtaW5mby5qc29uJywge1xuICAgICdkb21haW4tbmFtZSc6IHpvbmVOYW1lMSxcbiAgfSlcbiAgem9uZUNhY2hlW3pvbmVOYW1lMV0gPSB6b25lUmVzcG9uc2UxXG4gIGNvbnN0IHpvbmVSZXNwb25zZTIgPSB6b25lQ2FjaGVbem9uZU5hbWUyXSB8fCBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdHRVQnLCAnL2Rucy9nZXQtem9uZS1pbmZvLmpzb24nLCB7XG4gICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUyLFxuICB9KVxuICB6b25lQ2FjaGVbem9uZU5hbWUyXSA9IHpvbmVSZXNwb25zZTJcbiAgY29uc3Qgem9uZU5hbWUgPSAoem9uZVJlc3BvbnNlMS5zdGF0dXMgPT09ICcxJyA/IHpvbmVOYW1lMSA6IHpvbmVSZXNwb25zZTIuc3RhdHVzID09PSAnMScgPyB6b25lTmFtZTIgOiAnJylcbiAgY29uc3QgaG9zdE5hbWUgPSAoem9uZVJlc3BvbnNlMS5zdGF0dXMgPT09ICcxJyA/IGhvc3ROYW1lMSA6IHpvbmVSZXNwb25zZTIuc3RhdHVzID09PSAnMScgPyBob3N0TmFtZTIgOiAnJylcbiAgaWYgKCF6b25lTmFtZSkge1xuICAgIC8vIE5laXRoZXIgem9uZSBleGlzdHNcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ1pvbmUgTm90IEZvdW5kOiAnICsgbmFtZSlcbiAgfVxuICByZXR1cm4ge1xuICAgIGhvc3ROYW1lOiBob3N0TmFtZSxcbiAgICB6b25lTmFtZTogem9uZU5hbWUsXG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY3JlYXRlT3JVcGRhdGVDbG91ZG5zUmVzb3VyY2UoY2xvdWRuc1VzZXJuYW1lOiBzdHJpbmcsIGNsb3VkbnNQYXNzd29yZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHR5cGU6IHN0cmluZywgdmFsdWU6IHN0cmluZywgdHRsVmFsdWU6IHN0cmluZywgem9uZUNhY2hlOiBhbnkpIHtcbiAgY29uc3QgeyB6b25lTmFtZSwgaG9zdE5hbWUgfSA9IGF3YWl0IGF1dG9EZXRlY3RDbG91ZG5zSG9zdEFuZFpvbmUoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsIG5hbWUsIHpvbmVDYWNoZSlcbiAgLy8gRG9lcyB0aGUgcmVjb3JkIGV4aXN0P1xuICBjb25zdCByZWNvcmRzUmVzcG9uc2UgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdHRVQnLCAnL2Rucy9yZWNvcmRzLmpzb24nLCB7XG4gICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgJ2hvc3QnOiBob3N0TmFtZSxcbiAgICAndHlwZSc6IHR5cGUsXG4gIH0pXG4gIGNvbnN0IGV4aXN0aW5nUmVjb3JkOiBhbnkgPSBPYmplY3QudmFsdWVzKHJlY29yZHNSZXNwb25zZSlbMF1cbiAgaWYgKGV4aXN0aW5nUmVjb3JkPy5ob3N0ID09PSBob3N0TmFtZSAmJiBleGlzdGluZ1JlY29yZD8udHlwZSA9PT0gdHlwZSAmJiBleGlzdGluZ1JlY29yZD8udHRsID09PSB0dGxWYWx1ZSAmJiBleGlzdGluZ1JlY29yZD8ucmVjb3JkID09PSB2YWx1ZSkge1xuICAgIC8vIFJlY29yZCBleGlzdHMgYWxyZWFkeSAtIG5vIGNoYW5nZVxuICAgIGNvbnNvbGUubG9nKCdPSycsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgfSBlbHNlIGlmIChleGlzdGluZ1JlY29yZD8uaWQpIHtcbiAgICAvLyBVcGRhdGUgcmVjb3JkXG4gICAgY29uc29sZS5sb2coJ1VQREFURScsIG5hbWUsIHR5cGUsIHR0bFZhbHVlLCB2YWx1ZSwgJ1pPTkUnLCB6b25lTmFtZSwgJ0hPU1QnLCBob3N0TmFtZSlcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBjbG91ZG5zUmVzdENhbGwoY2xvdWRuc1VzZXJuYW1lLCBjbG91ZG5zUGFzc3dvcmQsICdQT1NUJywgJy9kbnMvbW9kLXJlY29yZC5qc29uJywge1xuICAgICAgJ2RvbWFpbi1uYW1lJzogem9uZU5hbWUsXG4gICAgICAncmVjb3JkLWlkJzogZXhpc3RpbmdSZWNvcmQ/LmlkLFxuICAgICAgJ2hvc3QnOiBob3N0TmFtZSxcbiAgICAgICdyZWNvcmQtdHlwZSc6IHR5cGUsXG4gICAgICAncmVjb3JkJzogdmFsdWUsXG4gICAgICAndHRsJzogdHRsVmFsdWUsXG4gICAgfSlcbiAgICBpZiAocmVzdWx0LnN0YXR1cyA9PT0gJ0ZhaWxlZCcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvciggJ01vZGlmeSByZWNvcmQgZmFpbGVkOiAnICsgKHJlc3VsdC5zdGF0dXNNZXNzYWdlIHx8IHJlc3VsdC5zdGF0dXNEZXNjcmlwdGlvbikpXG4gICAgfVxuICB9IGVsc2Uge1xuICAgIC8vIENyZWF0ZSByZWNvcmRcbiAgICBjb25zb2xlLmxvZygnQ1JFQVRFJywgbmFtZSwgdHlwZSwgdHRsVmFsdWUsIHZhbHVlLCAnWk9ORScsIHpvbmVOYW1lLCAnSE9TVCcsIGhvc3ROYW1lKVxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGNsb3VkbnNSZXN0Q2FsbChjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgJ1BPU1QnLCAnL2Rucy9hZGQtcmVjb3JkLmpzb24nLCB7XG4gICAgICAnZG9tYWluLW5hbWUnOiB6b25lTmFtZSxcbiAgICAgICdob3N0JzogaG9zdE5hbWUsXG4gICAgICAncmVjb3JkLXR5cGUnOiB0eXBlLFxuICAgICAgJ3JlY29yZCc6IHZhbHVlLFxuICAgICAgJ3R0bCc6IHR0bFZhbHVlLFxuICAgIH0pXG4gICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09ICdGYWlsZWQnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoICdBZGQgcmVjb3JkIGZhaWxlZDogJyArIChyZXN1bHQuc3RhdHVzTWVzc2FnZSB8fCByZXN1bHQuc3RhdHVzRGVzY3JpcHRpb24pKVxuICAgIH1cbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgY29uc29sZS5sb2coJ0Nsb3VETlMgQ2xvdWRGb3JtYXRpb24gU3luYyBieSBLZW5uZXRoIEZhbGNrIDxrZW5udUBjbG91ZGVuLm5ldD4gKEMpIENsb3VkZW4gT3kgMjAyMCcpXG4gIGNvbnN0IGNsb3VkbnNVc2VybmFtZSA9IHByb2Nlc3MuYXJndlsyXVxuICBjb25zdCBjbG91ZG5zUGFzc3dvcmRQYXJhbWV0ZXIgPSBwcm9jZXNzLmFyZ3ZbM11cbiAgY29uc3QgdHRsVmFsdWUgPSBwcm9jZXNzLmFyZ3ZbNF0gfHwgJzMwMCdcbiAgaWYgKCFjbG91ZG5zVXNlcm5hbWUpIHtcbiAgICBjb25zb2xlLmVycm9yKCdVc2FnZTogY2xvdWRucy1jbG91ZGZvcm1hdGlvbi1zeW5jIDxjbG91ZG5zLXVzZXJuYW1lPiA8Y2xvdWRucy1wYXNzd29yZC1wYXJhbWV0ZXItbmFtZT4gW3R0bF0nKVxuICAgIHByb2Nlc3MuZXhpdCgxKVxuICB9XG4gIGlmICghY2xvdWRuc1Bhc3N3b3JkUGFyYW1ldGVyKSB7XG4gICAgY29uc29sZS5lcnJvcignVXNhZ2U6IGNsb3VkbnMtY2xvdWRmb3JtYXRpb24tc3luYyA8Y2xvdWRucy11c2VybmFtZT4gPGNsb3VkbnMtcGFzc3dvcmQtcGFyYW1ldGVyLW5hbWU+IFt0dGxdJylcbiAgICBwcm9jZXNzLmV4aXQoMSlcbiAgfVxuXG4gIGNvbnN0IHNzbSA9IG5ldyBTU00oKVxuICBjb25zdCB6b25lQ2FjaGUgPSB7fVxuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgc3NtLmdldFBhcmFtZXRlcih7XG4gICAgTmFtZTogY2xvdWRuc1Bhc3N3b3JkUGFyYW1ldGVyLFxuICAgIFdpdGhEZWNyeXB0aW9uOiB0cnVlLFxuICB9KS5wcm9taXNlKClcbiAgY29uc3QgY2xvdWRuc1Bhc3N3b3JkID0gcmVzcG9uc2UuUGFyYW1ldGVyPy5WYWx1ZSB8fCAnJ1xuXG4gIGNvbnN0IGNsb3VkRm9ybWF0aW9uID0gbmV3IENsb3VkRm9ybWF0aW9uKClcbiAgbGV0IG5leHRUb2tlblxuICBkbyB7XG4gICAgY29uc3QgcmVzcG9uc2U6IENsb3VkRm9ybWF0aW9uLkxpc3RFeHBvcnRzT3V0cHV0ID0gYXdhaXQgY2xvdWRGb3JtYXRpb24ubGlzdEV4cG9ydHMoe1xuICAgICAgTmV4dFRva2VuOiBuZXh0VG9rZW4sXG4gICAgfSkucHJvbWlzZSgpXG4gICAgZm9yIChjb25zdCBleHBvcnRPYmogb2YgcmVzcG9uc2UuRXhwb3J0cyB8fCBbXSkge1xuICAgICAgaWYgKGV4cG9ydE9iai5OYW1lPy5tYXRjaCgvXkNsb3VETlM6LykpIHtcbiAgICAgICAgY29uc3QgbmFtZVBhcnRzID0gZXhwb3J0T2JqLk5hbWUuc3BsaXQoJzonKVxuICAgICAgICBjb25zdCByZXNvdXJjZVR5cGUgPSBuYW1lUGFydHNbMV1cbiAgICAgICAgY29uc3QgcmVzb3VyY2VOYW1lID0gbmFtZVBhcnRzLnNsaWNlKDIpLmpvaW4oJy4nKVxuICAgICAgICBjb25zdCByZXNvdXJjZVZhbHVlID0gZXhwb3J0T2JqLlZhbHVlIVxuICAgICAgICBhd2FpdCBjcmVhdGVPclVwZGF0ZUNsb3VkbnNSZXNvdXJjZShjbG91ZG5zVXNlcm5hbWUsIGNsb3VkbnNQYXNzd29yZCwgcmVzb3VyY2VOYW1lLCByZXNvdXJjZVR5cGUsIHJlc291cmNlVmFsdWUsIHR0bFZhbHVlLCB6b25lQ2FjaGUpXG4gICAgICB9XG4gICAgfVxuICAgIG5leHRUb2tlbiA9IHJlc3BvbnNlLk5leHRUb2tlblxuICB9IHdoaWxlIChuZXh0VG9rZW4pXG59XG5cbiJdfQ==