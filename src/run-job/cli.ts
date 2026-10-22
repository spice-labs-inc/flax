import { workspaceRoot } from "../lib/workspace.ts";
import { parseArgs } from "node:util";
import { parseRevisionTarget } from "../revise/prepare.ts";
import { AUTO } from "../lib/job.ts";
import { mediaInputsOn } from "../lib/media.ts";
import { collectInputFlags } from "./collect-inputs.ts";
import { runJob } from "./run.ts";

const usage =
  "usage: flax agents run-job <name> [--workspace <dir>] [--stub] [--preflight] [--model <id>] [--thinking <level>] [--scratch <dir>] [--out <dir>] [--revise <owner/name#number>] [--part <id> [--media-out <dir>] [--edition-heap <size>]] [--media-parts <dir>] [--unlist-only] [--review-model <id> [--review-thinking <level>]] [--replay <run id>] [--media-model <id>] [--media-input <name>=<true|false>]... [--collect-input <name>=<value>]... [--find-ledger | --ledger-in <dir> --ledger-out <dir>] [--env <env> [--reason <text>] [--find-previous | --previous <dir> --results-out <dir>]]";

let parsed;
try {
  parsed = parseArgs({
    options: {
      workspace: { type: "string" },
      stub: { type: "boolean", default: false },
      preflight: { type: "boolean", default: false },
      model: { type: "string" },
      thinking: { type: "string" },
      scratch: { type: "string" },
      out: { type: "string" },
      revise: { type: "string" },
      part: { type: "string" },
      "media-out": { type: "string" },
      "media-parts": { type: "string" },
      "edition-heap": { type: "string" },
      "unlist-only": { type: "boolean", default: false },
      "review-model": { type: "string" },
      "review-thinking": { type: "string" },
      replay: { type: "string" },
      "media-model": { type: "string" },
      "media-input": { type: "string", multiple: true },
      "collect-input": { type: "string", multiple: true },
      env: { type: "string" },
      reason: { type: "string" },
      "find-previous": { type: "boolean", default: false },
      previous: { type: "string" },
      "results-out": { type: "string" },
      "find-ledger": { type: "boolean", default: false },
      "ledger-in": { type: "string" },
      "ledger-out": { type: "string" },
    },
    allowPositionals: true,
  });
  if (parsed.positionals.length !== 1) throw new Error(usage);
  mediaInputsOn(parsed.values["media-input"] ?? []);
  collectInputFlags(parsed.values["collect-input"] ?? []);
  const replay = parsed.values.replay;
  if (replay !== undefined && replay !== "" && !/^[1-9]\d{0,19}$/.test(replay))
    throw new Error(`--replay takes a workflow run id, not "${replay}"`);
  const target = parsed.values.revise;
  if (
    target !== undefined &&
    target !== "" &&
    parseRevisionTarget(target) === undefined
  )
    throw new Error(`--revise takes owner/name#number, not "${target}"`);
} catch (err) {
  const message = (err as Error).message;
  console.error(message === usage ? usage : `${message}\n${usage}`);
  process.exit(2);
}

const { values, positionals } = parsed;
const inputsOn = mediaInputsOn(values["media-input"] ?? []);
const collectInputs = collectInputFlags(values["collect-input"] ?? []);
const result = await runJob({
  root: workspaceRoot(values.workspace),
  name: positionals[0]!,
  stub: values.stub,
  preflight: values.preflight,
  // A workflow run nobody picked a model or level for passes an empty value, or auto.
  ...(values.model === undefined || values.model === "" || values.model === AUTO
    ? {}
    : { model: values.model }),
  ...(values.thinking === undefined ||
  values.thinking === "" ||
  values.thinking === AUTO
    ? {}
    : { thinking: values.thinking }),
  ...(values.scratch === undefined ? {} : { scratch: values.scratch }),
  ...(values.out === undefined ? {} : { out: values.out }),
  // A workflow run that revises nothing passes an empty value.
  ...(values.revise === undefined || values.revise === ""
    ? {}
    : { revise: parseRevisionTarget(values.revise)! }),
  ...(values.part === undefined ? {} : { part: values.part }),
  ...(values["media-out"] === undefined
    ? {}
    : { mediaOut: values["media-out"] }),
  ...(values["media-parts"] === undefined
    ? {}
    : { mediaParts: values["media-parts"] }),
  // A workflow run nobody gave a heap passes no flag; an empty value means the same.
  ...(values["edition-heap"] === undefined || values["edition-heap"] === ""
    ? {}
    : { editionHeap: values["edition-heap"] }),
  ...(values["unlist-only"] ? { unlistOnly: true } : {}),
  // A workflow run nobody picked a second check model, level or replay for passes an empty value, or auto.
  ...(values["review-model"] === undefined ||
  values["review-model"] === "" ||
  values["review-model"] === AUTO
    ? {}
    : { reviewModel: values["review-model"] }),
  ...(values["review-thinking"] === undefined ||
  values["review-thinking"] === "" ||
  values["review-thinking"] === AUTO
    ? {}
    : { reviewThinking: values["review-thinking"] }),
  ...(values.replay === undefined || values.replay === ""
    ? {}
    : { replay: Number(values.replay) }),
  ...(values.env === undefined ? {} : { targetEnv: values.env }),
  ...(values["find-previous"] ? { findPrevious: true } : {}),
  ...(values.previous === undefined ? {} : { previous: values.previous }),
  ...(values["results-out"] === undefined
    ? {}
    : { resultsOut: values["results-out"] }),
  ...(values["find-ledger"] ? { findLedger: true } : {}),
  ...(values["ledger-in"] === undefined
    ? {}
    : { ledgerIn: values["ledger-in"] }),
  ...(values["ledger-out"] === undefined
    ? {}
    : { ledgerOut: values["ledger-out"] }),
  // A run started by hand with no reason, or a scheduled run, passes no flag; an empty value means the same.
  ...(values.reason === undefined || values.reason === ""
    ? {}
    : { reason: values.reason }),
  ...(values["media-model"] === undefined ||
  values["media-model"] === "" ||
  values["media-model"] === AUTO
    ? {}
    : { mediaModel: values["media-model"] }),
  ...(inputsOn.length === 0 ? {} : { mediaInputs: inputsOn }),
  // A scheduled run passes each collect input empty, which leaves it out.
  ...(Object.keys(collectInputs).length === 0 ? {} : { collectInputs }),
});
for (const line of result.messages)
  (result.ok ? console.log : console.error)(line);
process.exit(result.ok ? 0 : 1);
