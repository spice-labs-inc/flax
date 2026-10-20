import { PickleStepType } from "@cucumber/messages";

/** The scenario's actions in groups, a group being consecutive actions (When, And) up to the next check. */
export function actionGroups(
  steps: readonly { type?: PickleStepType; text: string }[],
): string[][] {
  const groups: string[][] = [];
  let previous: PickleStepType | undefined;
  for (const step of steps) {
    if (step.type === PickleStepType.ACTION) {
      if (previous !== PickleStepType.ACTION) groups.push([]);
      groups[groups.length - 1]!.push(step.text);
    }
    previous = step.type;
  }
  return groups;
}
