/**
 * The timeline from a recording's events. `origin` is the video's first frame on the events'
 * clock, or the scenario's start when nothing was filmed; times before it (setup before the
 * page opened) come out negative.
 */
export function buildTimeline(input) {
    const rel = (at) => Math.round(at - input.origin);
    const terminals = [];
    const entry = (s) => {
        const mine = input.events.filter((e) => e.step === s.id);
        const start = mine.find((e) => e.type === "step-start");
        const end = mine.find((e) => e.type === "step-end");
        const screen = mine.find((e) => e.type === "screen");
        const commands = mine.flatMap((e) => e.type === "terminal"
            ? [
                {
                    command: e.command,
                    ...(e.cwd !== undefined ? { cwd: e.cwd } : {}),
                    exitCode: e.exitCode,
                    startMs: rel(e.start),
                    endMs: rel(e.end),
                    output: e.chunks.map((c) => ({ atMs: rel(c.at), text: c.text })),
                },
            ]
            : []);
        const own = !s.background;
        const [first, ...more] = commands;
        if (own && first) {
            const override = input.terminal?.find((t) => t.at === s.index);
            terminals.push({
                index: s.index,
                ...first,
                ...(override?.display !== undefined
                    ? { display: override.display }
                    : {}),
                ...(override && override.preface.length > 0
                    ? { preface: override.preface }
                    : {}),
                ...(more.length > 0 ? { more } : {}),
            });
        }
        return {
            index: s.index,
            keyword: s.keyword,
            text: s.text,
            hidden: s.background || input.hidden.has(s.index),
            highlight: own && input.highlighted.has(s.index),
            startMs: start ? rel(start.at) : null,
            endMs: end ? rel(end.at) : null,
            status: end?.type === "step-end" ? end.status : "skipped",
            ...(end?.type === "step-end" && end.error !== undefined
                ? { error: end.error }
                : {}),
            actions: mine.flatMap((e) => e.type === "action"
                ? [
                    {
                        kind: e.kind,
                        atMs: rel(e.at),
                        ...(e.box ? { box: e.box } : {}),
                    },
                ]
                : []),
            screen: own && screen?.type === "screen" ? screen.file : null,
            terminal: own && first ? `terminal/${s.index}.json` : null,
        };
    };
    return {
        timeline: {
            id: input.id,
            scenario: input.scenario,
            feature: input.feature,
            startedAt: new Date(input.originWallMs).toISOString(),
            status: input.status,
            video: input.video,
            viewport: input.viewport,
            scale: input.scale,
            steps: input.steps.filter((s) => !s.background).map(entry),
            background: input.steps.filter((s) => s.background).map(entry),
        },
        terminals,
    };
}
/**
 * A terminal scene as an asciicast v2 recording: the preface and then the command (its display
 * form when the sidecar gives one) typed at the recording's pace after a `$ ` prompt, the output
 * chunks at their times after the command started, and the closing prompt.
 */
export function terminalCast(scene, pace, size = { cols: 100, rows: 30 }) {
    const events = [];
    let t = 0;
    const at = (ms) => Math.round(ms) / 1000;
    const typeLine = (line) => {
        events.push([at(t), "o", "$ "]);
        for (const ch of line) {
            t += pace.typeMsPerChar;
            events.push([at(t), "o", ch]);
        }
        t += pace.afterActionMs / 2;
        events.push([at(t), "o", "\r\n"]);
    };
    const lines = [];
    for (const line of scene.preface ?? []) {
        typeLine(line);
        lines.push(`$ ${line}`);
    }
    for (const [i, c] of [scene, ...(scene.more ?? [])].entries()) {
        const shown = i === 0 ? (scene.display ?? c.command) : c.command;
        typeLine(shown);
        lines.push(`$ ${shown}`);
        const started = t;
        for (const chunk of c.output) {
            t = Math.max(t, started + chunk.atMs - c.startMs);
            events.push([at(t), "o", chunk.text.replace(/\r?\n/g, "\r\n")]);
            lines.push(...chunk.text.split("\n"));
        }
        t = Math.max(t, started + c.endMs - c.startMs);
        const last = c.output.at(-1)?.text ?? "";
        if (last !== "" && !last.endsWith("\n"))
            events.push([at(t), "o", "\r\n"]);
    }
    events.push([at(t), "o", "$ "]);
    const width = Math.max(size.cols, ...lines.map((l) => l.length));
    return ([
        JSON.stringify({
            version: 2,
            width: Math.min(width, 240),
            height: size.rows,
            idle_time_limit: 2,
        }),
        ...events.map((e) => JSON.stringify(e)),
    ].join("\n") + "\n");
}
//# sourceMappingURL=timeline.js.map