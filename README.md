# ClouDNS CloudFormation Sync

Copyright (C) Clouden Oy 2020-2026, author Kenneth Falck <kennu@clouden.net>.

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

    AWS_PROFILE=xxx cloudns-cloudformation-sync -u <username> -p <password-parameter> [options]

Options:

    -u, --username <name>           ClouDNS API sub-auth-user
    -p, --password-parameter <ssm>  SSM parameter holding the encrypted ClouDNS API password
    -t, --ttl <seconds>             TTL for generated records (defaults to 300)
    -s, --stack <name>              Limit to this CloudFormation stack; repeatable
    -z, --zone <name>               Also scan this zone when pruning; repeatable
        --prune                     Delete managed records whose export is gone
        --force-prune               Also prune when no exports were found; requires --zone
        --max-prune <n>             Most records one run may delete (defaults to 10)
    -n, --dry-run                   Report what would change without changing it
    -h, --help                      Show help
    -V, --version                   Show the version

    AWS_PROFILE=xxx - Specify your AWS profile in ~/.aws/credentials as an environment variable

You can create your ClouDNS API credentials in the ClouDNS management console.

The positional form from 1.x still works, so existing scripts do not need changing:

    AWS_PROFILE=xxx cloudns-cloudformation-sync <username> <password-parameter> [ttl [stackname...]]

## Record ownership

Every record this tool writes carries a ClouDNS record note naming the tool, the stack whose export
produced it, and that export:

    managed-by=cloudns-cloudformation-sync stack=my-stack export=ClouDNS:CNAME:myhost:example:org

The note is what makes deletion safe. A zone usually holds records nobody here created, and without
a marker there is no way to tell an orphan left by a deleted export from something added by hand.
Records without the marker are never touched.

Notes are stamped on every sync, so records created by earlier versions are adopted the next time
they are seen — there is nothing separate to run. Adoption is safe because a record is only stamped
when an export currently claims it, and the tool is already overwriting that record's value.

## Pruning

Pruning is opt-in, and scoped to the stacks named with `--stack` so that syncing one stack never
deletes another's records.

    --prune        delete managed records whose export is gone, but only if this run found exports
    --force-prune  also prune when no exports were found, for a genuine teardown

The distinction matters. An empty export set is far more often a mistyped `--stack` or a failed AWS
call than an instruction to empty the zone, so `--prune` alone refuses to act on one. `--force-prune`
is the deliberate version and requires an explicit `--zone`, because with no exports there is nothing
to infer a zone from. Both are capped by `--max-prune`, and `--dry-run` shows what would go.

A `--stack` that matched no exports is a warning normally and an error when pruning: at that point
"no exports" and "delete everything" look identical, and the tool should not guess.

## Verification

Writes are read back and compared, so the log reports what the zone holds rather than what the tool
intended. Note that this confirms the stored record only: ClouDNS resolves ALIAS targets on its own
schedule, so what the zone *serves* can lag a changed ALIAS record considerably. After repointing an
ALIAS, check with `dig` against the zone's nameservers before assuming the change is live.
