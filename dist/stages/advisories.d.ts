import type { AdvisoryRecord } from '../model/types.ts';
import type { Stage } from '../pipeline/machine.ts';
export interface AdvisoryResult {
    /** component id -> the advisory ids it carries */
    byComponent: Record<string, string[]>;
    /** every advisory named above, once */
    catalogue: Record<string, AdvisoryRecord>;
    /** The instant the capture speaks about, or undefined when there is none. */
    asOf?: string;
    complete?: boolean;
}
export declare const advisories: Stage;
