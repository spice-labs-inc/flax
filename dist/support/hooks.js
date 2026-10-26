import { After, AfterAll, AfterStep, Before, BeforeStep, setDefaultTimeout, setParallelCanAssign, } from "@cucumber/cucumber";
import { SceneCapture, wantedCaptures } from "../capture/capture.js";
import { config } from "../config.js";
import { SceneRecording } from "../record/media.js";
import { plannedRecording } from "../record/plan.js";
import { scenarioSteps } from "../record/steps.js";
import { currentCaptureDir, currentRecordPlan } from "../run/env.js";
import { touchesMediaType } from "../run/results.js";
import { canRunAlongside } from "../run/tags.js";
import { closeSharedBrowser } from "./world.js";
/**
 * The base hooks: step tracking, the touches attachment, the shared browser, in a record run the
 * recording of each planned scenario, and in a capture run the screenshots of each selected one. A workspace imports this module from its own support
 * file and adds its hooks (fixture teardown, env guards) beside it.
 */
export function installBaseHooks(options = {}) {
    setDefaultTimeout(options.timeoutMs ?? 5 * 60_000);
    setParallelCanAssign(canRunAlongside);
    Before(async function ({ pickle, gherkinDocument }) {
        const dir = currentCaptureDir();
        const tags = pickle.tags.map((t) => t.name);
        if (dir && wantedCaptures(tags, config().capture.tag)) {
            this.capturing = new SceneCapture({
                scenario: {
                    name: pickle.name,
                    uri: pickle.uri,
                    line: pickle.location?.line ?? 0,
                    tags,
                },
                settings: config().capture,
                dir,
                steps: scenarioSteps(pickle, gherkinDocument),
                attach: (body, mediaType) => this.attach(body, mediaType),
            });
            const scenario = { name: pickle.name, uri: pickle.uri, tags };
            const script = await options.captureInitScript?.(scenario, this);
            if (script)
                await this.capturing.addInitScript(script);
            const rewrite = await options.captureRewrite?.(scenario, this);
            if (rewrite)
                this.capturing.addRewrite(rewrite);
        }
        const plan = currentRecordPlan();
        const planned = plan && plannedRecording(plan, pickle.uri, pickle.location?.line);
        if (!plan || !planned)
            return;
        this.recording = new SceneRecording(planned, plan.options, scenarioSteps(pickle, gherkinDocument), plan.dir);
        await this.recording.prepare();
        const script = await options.recordInitScript?.(planned.sidecar);
        if (script)
            this.recording.addInitScript(script);
    });
    // Each touch says which step made it, so a reader can tell what the scenario did with an item.
    BeforeStep(function ({ pickle, pickleStep }) {
        this.step = pickle.steps.findIndex((s) => s.id === pickleStep.id);
        this.recording?.stepStarted(pickleStep.id);
        this.capturing?.stepStarted(pickleStep.id);
    });
    AfterStep(async function ({ pickleStep, result }) {
        this.capturing?.stepFinished();
        await this.recording?.stepFinished(pickleStep.id, result);
    });
    After(async function ({ result }) {
        this.step = undefined;
        await this.recording?.finish(result?.status);
        await this.closePage();
        this.attach(JSON.stringify(this.touches), touchesMediaType());
    });
    AfterAll(async () => {
        await closeSharedBrowser();
    });
}
//# sourceMappingURL=hooks.js.map