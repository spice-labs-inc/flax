import { PickleStepType } from "@cucumber/messages";
/** The scenario's actions in groups, a group being consecutive actions (When, And) up to the next check. */
export declare function actionGroups(steps: readonly {
    type?: PickleStepType;
    text: string;
}[]): string[][];
