# ClouDNS CloudFormation Sync

Copyright (C) Clouden Oy 2020-2024, author Kenneth Falck <kennu@clouden.net>.

Released under the MIT license.

This tool can be used to autogenerate ClouDNS records for CloudFormation resources like CloudFront distributions and API Gateway domains.

## Installation

    npm install cloudns-cloudformation-sync

## Defining CloudFormation Exports

CloudFormation export name must specify the resource type and record hostname as follows:

    ClouDNS:CNAME:myhost:example:org

CloudFormation export value must specify the record value as-is (for instance, a distribution domain name):

    xxxxxxxxxxxxxx.cloudfront.net

The above example will generate the following record in the ClouDNS zone example.org:

    myhost.example.org CNAME xxxxxxxxxxxxxx.cloudfront.net

Other resource types are also allowed (A, AAAA, ALIAS, etc).

## Command line usage

Use the cloudns-cloudformation-sync command to synchronize ClouDNS records.

    AWS_PROFILE=xxx cloudns-cloudformation-sync <cloudns-username> <cloudns-password-parameter-name> [ttl [stackname...]]

Options:

    AWS_PROFILE=xxx - Specify your AWS profile in ~/.aws/credentials as an environment variable
    <cloudns-username> - ClouDNS API sub-auth-user
    <cloudns-password-parameter-name> - SSM Parameter with the encrypted ClouDNS API password
    [ttl] - Optional TTL for generated records (defaults to 300)
    [stackName...] - Optional CloudFormation stack name(s) to limit the exports to scan (defaults to all stacks)

You can create your ClouDNS API credentials in the ClouDNS management console.
