import { Document, Scalar } from "yaml";
import { checkBox, type Box } from "../lib/box.ts";
import { format } from "../lib/format.ts";
import { formatProblem } from "../lib/problem.ts";
import type { Result } from "./release.ts";

export interface ReleasePin {
  box_release: string;
  box_commit: string;
  lbx_sha256: string;
  image: string;
}

/** box.yml pinning a sandbox (lbx) release, refused unless box.yml's own checks accept it. */
export async function releasePinText(
  pin: ReleasePin,
  runId?: string,
): Promise<Result<string>> {
  const box: Box = {
    pinned: true,
    box_release: pin.box_release,
    box_commit: pin.box_commit,
    lbx_sha256: pin.lbx_sha256,
    image: pin.image,
  };
  const { problems } = checkBox(box);
  if (problems.length > 0)
    return { ok: false, error: problems.map(formatProblem).join("; ") };
  const doc = new Document(box);
  for (const key of ["box_release", "box_commit", "lbx_sha256"]) {
    const node = doc.get(key, true);
    if (node instanceof Scalar) node.type = Scalar.QUOTE_DOUBLE;
  }
  const run = runId
    ? `the "Publish image" run ${runId}`
    : `"Publish image"`;
  doc.commentBefore = [
    " The box every job runs in. Schema: schema/box.schema.json.",
    "",
    ` Written by ${run} for sandbox (lbx) release ${pin.box_release}:`,
    " the launcher binary that release attaches, checked against lbx_sha256",
    " before every run, and the agent image built from images/agent/Dockerfile",
    " with the release's entrypoint.",
  ].join("\n");
  return {
    ok: true,
    value: await format(doc.toString({ lineWidth: 0 }), { parser: "yaml" }),
  };
}
