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
export declare function main(): Promise<void>;
export {};
