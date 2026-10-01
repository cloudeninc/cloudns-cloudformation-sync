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
 * Turns an export name into the record it describes: ClouDNS:<type>:<host labels...>.
 *
 * DKIM is the one form that is not a record type. An export name may only hold letters, digits,
 * colons and hyphens, and a DKIM record lives under `_domainkey`, which no export name can spell.
 * So ClouDNS:DKIM:<selector>:example:org stands for the CNAME <selector>._domainkey.example.org -
 * the shape SES Easy DKIM asks for, three of them per domain.
 */
export declare function parseExportName(exportName: string): {
    resourceType: string;
    resourceName: string;
};
export declare function main(): Promise<void>;
export {};
