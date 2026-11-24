interface Options {
    username: string;
    passwordParameter: string;
    ttl: string;
    stackNames: string[];
    zoneNames: string[];
    prune: boolean;
    forcePrune: boolean;
    maxPrune: number;
    dryRun: boolean;
}
export declare function parseArgs(argv: string[]): Options;
/**
 * The ClouDNS zone a record name belongs to, and its host name within that zone.
 *
 * The most specific zone the account holds wins, the way DNS delegation does: with both example.org
 * and a delegated dev.example.org, www.dev.example.org goes into dev.example.org, because a record
 * written into example.org under that name is never served once the subdomain is delegated. Checked
 * from the full name down to two labels, so a name that is itself a zone gets the apex (empty host).
 */
export declare function autoDetectCloudnsHostAndZone(cloudnsUsername: string, cloudnsPassword: string, name: string, zoneCache: any): Promise<{
    hostName: string;
    zoneName: string;
}>;
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
export declare function parseExportName(exportName: string): {
    resourceType: string;
    resourceName: string;
};
/**
 * Splits an export value into the record and, for MX, its preference: an MX export's value is
 * `<priority> <mail server>`, such as `1 mail.example.org`, as the record is written in a zone file.
 * Every other type's value is the record as-is.
 */
export declare function parseExportValue(exportName: string, resourceType: string, value: string): {
    value: string;
    priority?: string;
};
export declare function main(): Promise<void>;
export {};
