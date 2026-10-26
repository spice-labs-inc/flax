import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorkspace, section, WorkspaceError } from "./workspace.js";
test("parses shared keys and keeps package sections untyped", () => {
    const ws = parseWorkspace("org: notes-co\ngithub: notes-co\nenvironments: [test, {id: live, label: Live}]\nagents: {budget_usd_per_month: 50}\n", "/tmp/ws");
    assert.equal(ws.org, "notes-co");
    assert.deepEqual(ws.environments, [{ id: "test" }, { id: "live", label: "Live" }]);
    assert.deepEqual(section(ws, "agents"), { budget_usd_per_month: 50 });
    assert.deepEqual(section(ws, "atlas"), {});
});
test("refuses a missing org and duplicate environments", () => {
    assert.throws(() => parseWorkspace("environments: [a]\n", "/tmp/ws"), WorkspaceError);
    assert.throws(() => parseWorkspace("org: x\nenvironments: [a, a]\n", "/tmp/ws"), WorkspaceError);
});
//# sourceMappingURL=workspace.test.js.map