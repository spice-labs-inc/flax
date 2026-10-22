import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
const PAGE_COMPONENT = /^\+page(@[^.]*)?\.svelte$/;
const PAGE_UNIVERSAL = /^\+page\.(ts|js)$/;
const PAGE_SERVER = /^\+page\.server\.(ts|js)$/;
const SERVER = /^\+server\.(ts|js)$/;
const HTTP_METHODS = [
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "fallback",
];
export function isSpecFile(path) {
    return /\.(spec|test)\.[jt]s$/.test(path);
}
/** Index just past the string, template, comment or bracketed group starting at `i`, else `i + 1`. */
export function skip(text, i) {
    const c = text[i];
    if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < text.length && text[j] !== c)
            j += text[j] === "\\" ? 2 : 1;
        return j + 1;
    }
    if (c === "`") {
        let j = i + 1;
        while (j < text.length && text[j] !== "`") {
            if (text[j] === "\\")
                j += 2;
            else if (text[j] === "$" && text[j + 1] === "{")
                j = skip(text, j + 1);
            else
                j++;
        }
        return j + 1;
    }
    if (c === "/" && text[i + 1] === "/") {
        const nl = text.indexOf("\n", i);
        return nl < 0 ? text.length : nl + 1;
    }
    if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        return end < 0 ? text.length : end + 2;
    }
    const close = c === "{" ? "}" : c === "(" ? ")" : c === "[" ? "]" : undefined;
    if (close) {
        let j = i + 1;
        while (j < text.length && text[j] !== close)
            j = skip(text, j);
        return j + 1;
    }
    return i + 1;
}
/** The text between the bracket at `open` and its match. */
export function bracketed(text, open) {
    return text.slice(open + 1, skip(text, open) - 1);
}
export function splitTopLevel(text) {
    const parts = [];
    let start = 0;
    let i = 0;
    while (i < text.length) {
        if (text[i] === ",") {
            parts.push(text.slice(start, i));
            start = i + 1;
            i++;
        }
        else
            i = skip(text, i);
    }
    parts.push(text.slice(start));
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}
/** `text` without the line and block comments it starts with. */
export function stripLeadingComments(text) {
    return text.replace(/^(?:\s*(?:\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/))+\s*/, "");
}
/** Keys of an object literal body: `a: ...`, `"b": ...`, `c() {}`, `async d() {}`, shorthand `e`. */
export function objectKeys(body) {
    const keys = [];
    for (const raw of splitTopLevel(body)) {
        const entry = stripLeadingComments(raw);
        if (entry.startsWith("..."))
            continue;
        const m = /^(?:async\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))/.exec(entry);
        const key = m?.[1] ?? m?.[2] ?? m?.[3];
        if (key)
            keys.push(key);
    }
    return keys;
}
/** Names a module exports, with the module each re-export comes from. */
export function moduleExports(text) {
    const out = [];
    for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
        if (m[1])
            out.push({ name: m[1] });
    }
    for (const m of text.matchAll(/export\s+(?:const|let|var)\s*\{/g)) {
        for (const part of splitTopLevel(bracketed(text, m.index + m[0].length - 1))) {
            const target = part
                .replace(/^\.\.\./, "")
                .split(":")
                .pop()
                ?.split("=")[0]
                ?.trim();
            if (target && IDENT.test(target))
                out.push({ name: target });
        }
    }
    for (const m of text.matchAll(/export\s*\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?/g)) {
        for (const spec of (m[1] ?? "").split(",")) {
            const name = spec
                .trim()
                .split(/\s+as\s+/)
                .pop()
                ?.trim();
            if (!name || name.startsWith("type "))
                continue;
            out.push(m[2] ? { name, from: m[2] } : { name });
        }
    }
    return out;
}
export function formActions(text) {
    const m = /(?:export\s+)?const\s+actions\b[^=]*=\s*\{/.exec(text);
    if (!m)
        return [];
    return objectKeys(bracketed(text, m.index + m[0].length - 1));
}
function unescapeSegment(seg) {
    return seg.replace(/\[([xu])\+([0-9a-fA-F]+)\]/g, (_, _k, hex) => String.fromCodePoint(parseInt(hex, 16)));
}
/** Splits a route id into its URL pattern, groups and params, following SvelteKit's routing rules; `keepMatchers` keeps `[name=matcher]` in the pattern. */
export function parseRouteId(routeId, keepMatchers = false) {
    const groups = [];
    const params = [];
    const segments = [];
    for (const seg of routeId.split("/").filter((s) => s.length > 0)) {
        const group = /^\((.+)\)$/.exec(seg);
        if (group?.[1]) {
            groups.push(group[1]);
            continue;
        }
        const url = unescapeSegment(seg).replace(/\[(\[)?(\.\.\.)?([A-Za-z_$][\w$]*)(?:=([A-Za-z_$][\w$]*))?\]?\]/g, (_, optional, rest, name, matcher) => {
            const kind = optional ? "optional" : rest ? "rest" : "required";
            params.push(matcher ? { name, kind, matcher } : { name, kind });
            const p = keepMatchers && matcher ? `${name}=${matcher}` : name;
            return optional ? `[[${p}]]` : rest ? `[...${p}]` : `[${p}]`;
        });
        segments.push(url);
    }
    return { path: `/${segments.join("/")}`, groups, params };
}
/** A route id or `resolve()` target as a URL pattern: matchers dropped, groups dropped. */
export function urlPattern(target) {
    const q = target.search(/[?#]/);
    const [path, tail] = q < 0 ? [target, ""] : [target.slice(0, q), target.slice(q)];
    return parseRouteId(path).path + tail;
}
function redirectTargets(text) {
    const out = [];
    const re = /(?:\bredirect\(\s*\d+\s*,|\bgoto\()\s*(?:resolve\(\s*)?(["'`])([^"'`]+)\1/g;
    for (const m of text.matchAll(re))
        if (m[2])
            out.push(urlPattern(m[2]));
    return [...new Set(out)];
}
/** Every page and endpoint under `routesDir`. Layouts, error pages and other files are not routes. */
export function parseRoutes(files, routesDir = "src/routes") {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const dirs = new Map();
    for (const f of files) {
        if (!f.path.startsWith(`${routesDir}/`) || isSpecFile(f.path))
            continue;
        const dir = posix.dirname(f.path);
        const base = posix.basename(f.path);
        if (![PAGE_COMPONENT, PAGE_UNIVERSAL, PAGE_SERVER, SERVER].some((re) => re.test(base)))
            continue;
        dirs.set(dir, [...(dirs.get(dir) ?? []), f]);
    }
    const routes = [];
    for (const [dir, dirFiles] of dirs) {
        const routeId = `/${posix.relative(routesDir, dir)}`;
        const { path, groups, params } = parseRouteId(routeId);
        const route = { routeId, path, dir, groups, params };
        const find = (re) => dirFiles.find((f) => re.test(posix.basename(f.path)));
        const component = find(PAGE_COMPONENT);
        const universal = find(PAGE_UNIVERSAL);
        const server = find(PAGE_SERVER);
        if (component || universal || server) {
            const uExports = universal ? moduleExports(universal.text) : [];
            const sExports = server ? moduleExports(server.text) : [];
            let redirectsTo = [];
            if (!component && universal) {
                const reexport = uExports.find((e) => e.name === "load" && e.from);
                const target = reexport?.from
                    ? byPath.get(posix.join(dir, reexport.from))
                    : undefined;
                redirectsTo = redirectTargets(universal.text + (target ? `\n${target.text}` : ""));
            }
            route.page = {
                files: [component, universal, server]
                    .filter((f) => f !== undefined)
                    .map((f) => f.path),
                component: component !== undefined,
                load: uExports.some((e) => e.name === "load"),
                serverLoad: sExports.some((e) => e.name === "load"),
                actions: server ? formActions(server.text) : [],
                redirectsTo,
            };
        }
        const endpoint = find(SERVER);
        if (endpoint) {
            const names = new Set(moduleExports(endpoint.text).map((e) => e.name));
            route.endpoint = {
                file: endpoint.path,
                methods: HTTP_METHODS.filter((m) => names.has(m)),
            };
        }
        routes.push(route);
    }
    const byUrl = new Map();
    for (const r of routes)
        byUrl.set(r.path, [...(byUrl.get(r.path) ?? []), r]);
    for (const same of byUrl.values()) {
        if (same.length < 2)
            continue;
        for (const r of same)
            r.path = parseRouteId(r.routeId, true).path;
    }
    return routes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
/**
 * The nav section a URL belongs to: its first fully static segment after the app base,
 * skipping params. Landing and redirect routes with no such segment group as "landing".
 */
export function sectionOf(path, appBase = "app") {
    const segs = path.split("/").filter((s) => s.length > 0);
    const rest = segs[0] === appBase ? segs.slice(1) : segs;
    return rest.find((s) => !s.includes("[")) ?? "landing";
}
export function routeItems(routes, ctx) {
    const items = [];
    const s = ctx.surface;
    for (const r of routes) {
        const section = sectionOf(r.path, ctx.appBase);
        const area = ctx.sectionLabel?.(section) ?? section;
        const common = {
            routeId: r.routeId,
            section,
            ...(r.groups.length > 0 ? { groups: r.groups } : {}),
            ...(r.params.length > 0 ? { params: r.params } : {}),
            ...ctx.routeDetails?.(r),
        };
        if (r.page) {
            const p = r.page;
            items.push({
                id: `${s}:route:${r.path}`,
                label: p.component ? `Page ${r.path}` : `Redirect ${r.path}`,
                surface: s,
                area,
                envs: [...ctx.envs],
                seen: [ctx.seen(p.files[0] ?? r.dir)],
                details: {
                    files: p.files,
                    component: p.component,
                    load: p.load,
                    serverLoad: p.serverLoad,
                    ...(p.actions.length > 0 ? { actions: p.actions } : {}),
                    ...(p.redirectsTo.length > 0 ? { redirectsTo: p.redirectsTo } : {}),
                    ...common,
                },
            });
            for (const name of p.actions) {
                const file = p.files.find((f) => PAGE_SERVER.test(posix.basename(f))) ?? r.dir;
                items.push({
                    id: `${s}:action:${r.path}?/${name}`,
                    label: name === "default"
                        ? `Default form action on ${r.path}`
                        : `Form action ${name} on ${r.path}`,
                    surface: s,
                    area,
                    parent: `${s}:route:${r.path}`,
                    envs: [...ctx.envs],
                    seen: [ctx.seen(file)],
                    details: { file, ...common },
                });
            }
        }
        if (r.endpoint) {
            for (const method of r.endpoint.methods) {
                const m = method === "fallback" ? "*" : method;
                items.push({
                    id: `${s}:endpoint:${m} ${r.path}`,
                    label: `${m === "*" ? "Any other method" : m} ${r.path}`,
                    surface: s,
                    area,
                    envs: [...ctx.envs],
                    seen: [ctx.seen(r.endpoint.file)],
                    details: { file: r.endpoint.file, ...common },
                });
            }
        }
    }
    return items;
}
const IDENT = /^[A-Za-z_$][\w$]*$/;
function templateValue(tpl) {
    let out = "";
    let i = 1;
    while (i < tpl.length - 1) {
        if (tpl[i] === "$" && tpl[i + 1] === "{") {
            out += "*";
            i = skip(tpl, i + 1);
        }
        else
            out += tpl[i++];
    }
    return out;
}
/** Svelte attribute text with each `{...}` interpolation, nested braces included, as `*`. */
function interpolated(text) {
    let out = "";
    let i = 0;
    while (i < text.length) {
        if (text[i] === "{") {
            out += "*";
            i = skip(text, i);
        }
        else
            out += text[i++];
    }
    return out;
}
const isWhole = (expr) => skip(expr, 0) === expr.length;
/** A `?` that is not part of `?.` or `??`. */
function isQuestion(expr, i) {
    const next = expr[i + 1];
    return !(next === "?" || (next === "." && !/\d/.test(expr[i + 2] ?? "")));
}
/** The `?` and `:` of a top-level conditional expression, if `expr` is one. */
function ternary(expr) {
    let q = -1;
    let depth = 0;
    for (let i = 0; i < expr.length;) {
        const c = expr[i];
        if (c === "?") {
            if (!isQuestion(expr, i)) {
                i += 2;
                continue;
            }
            if (q < 0)
                q = i;
            else
                depth++;
            i++;
        }
        else if (c === ":" && q >= 0) {
            if (depth === 0)
                return [q, i];
            depth--;
            i++;
        }
        else
            i = skip(expr, i);
    }
    return undefined;
}
/** Top-level parts of `expr` between occurrences of `ops`. */
function splitOps(expr, ops) {
    const parts = [];
    let start = 0;
    for (let i = 0; i < expr.length;) {
        const op = ops.find((o) => expr.startsWith(o, i));
        if (op) {
            parts.push(expr.slice(start, i).trim());
            i += op.length;
            start = i;
        }
        else
            i = skip(expr, i);
    }
    parts.push(expr.slice(start).trim());
    return parts;
}
/** The test ids a JS expression can produce: literal parts as written, anything else `*` (dynamic). */
function expressionValues(expr) {
    const e = expr.trim();
    const t = ternary(e);
    if (t)
        return [
            ...expressionValues(e.slice(t[0] + 1, t[1])),
            ...expressionValues(e.slice(t[1] + 1)),
        ];
    const alternatives = splitOps(e, ["||", "??"]);
    if (alternatives.length > 1)
        return alternatives.flatMap(expressionValues);
    const conjuncts = splitOps(e, ["&&"]);
    if (conjuncts.length > 1)
        return expressionValues(conjuncts.at(-1) ?? "");
    if (e.startsWith("(") && isWhole(e))
        return expressionValues(e.slice(1, -1));
    let value = "";
    let dynamic = false;
    for (const part of splitOps(e, ["+"])) {
        const c = part[0];
        if ((c === '"' || c === "'") && isWhole(part))
            value += part.slice(1, -1);
        else if (c === "`" && isWhole(part)) {
            value += templateValue(part);
            dynamic ||= part.includes("${");
        }
        else {
            value += "*";
            dynamic = true;
        }
    }
    value = value.replace(/\*+/g, "*");
    return [
        value === "*" ? { value, dynamic, expression: e } : { value, dynamic },
    ];
}
/** The test ids an attribute value can take: `"x"`, `"a-{b}"`, `{"x"}`, `{`a-${b}`}`, `{c ? "x" : "y"}`, `{"a-" + b}`. */
function valuesOf(raw) {
    const quote = raw[0];
    if (quote === '"' || quote === "'") {
        const inner = raw.slice(1, -1);
        return [{ value: interpolated(inner), dynamic: inner.includes("{") }];
    }
    const expr = raw.startsWith("{") ? raw.slice(1, -1).trim() : raw.trim();
    if (IDENT.test(expr))
        return { forwarded: expr };
    return expressionValues(expr);
}
/** Raw attribute values for every `name=` in the text: quoted, balanced `{...}`, or unquoted (returned quoted). */
function attributeValues(text, name) {
    const out = [];
    const escaped = name.replace(/[-$]/g, (c) => `\\${c}`);
    const re = new RegExp(`(?<![\\w$-])${escaped}\\s*=\\s*`, "g");
    for (const m of text.matchAll(re)) {
        const start = m.index + m[0].length;
        const c = text[start];
        if (c === '"' || c === "'" || c === "{") {
            out.push(text.slice(start, skip(text, start)));
            continue;
        }
        if (!/\s/.test(text[m.index - 1] ?? ""))
            continue;
        let j = start;
        while (j < text.length &&
            !/[\s>"'`=<\]]/.test(text[j] ?? "") &&
            !(text[j] === "/" && text[j + 1] === ">"))
            j = text[j] === "{" ? skip(text, j) : j + 1;
        if (j > start)
            out.push(`"${text.slice(start, j)}"`);
    }
    return out;
}
/** Object-literal `"data-testid": <expr>` values in script code, up to the next top-level comma or brace. */
function objectKeyValues(text) {
    const out = [];
    for (const m of text.matchAll(/["']data-testid["']\s*:\s*/g)) {
        let i = m.index + m[0].length;
        const start = i;
        while (i < text.length &&
            text[i] !== "," &&
            text[i] !== "}" &&
            text[i] !== "\n")
            i = skip(text, i);
        out.push(`{${text.slice(start, i).trim()}}`);
    }
    return out;
}
/**
 * Every data-testid in the given source files (spec files skipped). Ids a component takes
 * through a prop (`data-testid={testid}`) are resolved at the places that pass the prop.
 */
export function findTestIds(files) {
    const src = files.filter((f) => !isSpecFile(f.path) && /\.(svelte|ts|js)$/.test(f.path));
    const hits = [];
    const forwarded = [];
    const add = (raw, file, via) => {
        const v = valuesOf(raw);
        if ("forwarded" in v) {
            if (via)
                hits.push({
                    value: "*",
                    dynamic: true,
                    file,
                    via,
                    expression: v.forwarded,
                });
            else
                forwarded.push({ prop: v.forwarded, file });
        }
        else {
            for (const x of v)
                hits.push({ ...x, file, ...(via ? { via } : {}) });
        }
    };
    for (const f of src) {
        const raws = f.path.endsWith(".svelte")
            ? attributeValues(f.text, "data-testid")
            : [];
        for (const raw of [...raws, ...objectKeyValues(f.text)])
            add(raw, f.path);
    }
    for (const { prop, file } of forwarded) {
        const before = hits.length;
        const component = posix.basename(file);
        for (const f of src) {
            if (f.path === file ||
                !f.path.endsWith(".svelte") ||
                !f.text.includes(component))
                continue;
            for (const raw of attributeValues(f.text, prop))
                add(raw, f.path, file);
        }
        if (hits.length === before)
            hits.push({ value: "*", dynamic: true, file, expression: prop });
    }
    return hits;
}
/** Where a file lives, for grouping: the route URL for files under the routes dir, else its lib dir. */
export function fileArea(path, routesDir = "src/routes") {
    if (path.startsWith(`${routesDir}/`)) {
        const dir = posix.dirname(path);
        return dir === routesDir
            ? "/"
            : parseRouteId(`/${posix.relative(routesDir, dir)}`).path;
    }
    const rel = path.replace(/^src\//, "");
    const parts = rel.split("/");
    return parts.length > 2 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? rel);
}
export const NAVIGATION_AREA = "Navigation";
export const SHARED_AREA = "Shared across sections";
export const UNUSED_AREA = "Not used by any page";
/** Repo files a module imports through `$lib/...` or a relative specifier (type-only imports skipped). */
function importedFiles(f, byPath) {
    const out = [];
    for (const m of f.text.matchAll(/(?:\bimport\s+(?!type\b)(?:[^'";]*?\bfrom\s*)?|\bexport\s+(?!type\b)[^'";]*?\bfrom\s*|\bimport\(\s*)["']([^"']+)["']/g)) {
        const spec = m[1] ?? "";
        const base = spec.startsWith("$lib/")
            ? posix.join("src/lib", spec.slice("$lib/".length))
            : spec.startsWith(".")
                ? posix.join(posix.dirname(f.path), spec)
                : undefined;
        if (base === undefined)
            continue;
        const hit = [
            base,
            `${base}.ts`,
            `${base}.js`,
            `${base}/index.ts`,
            `${base}/index.js`,
        ].find((p) => byPath.has(p));
        if (hit)
            out.push(hit);
    }
    return out;
}
/**
 * For each file, the product sections whose pages render it, following imports from route files:
 * a +page file gives its route's section; a +layout or +error file gives its own section, or
 * "Navigation" for the app-wide chrome above every section.
 */
export function fileSections(files, label, routesDir = "src/routes", appBase = "app") {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const graph = new Map(files.map((f) => [f.path, importedFiles(f, byPath)]));
    const reached = new Map();
    for (const f of files) {
        if (!f.path.startsWith(`${routesDir}/`) || isSpecFile(f.path))
            continue;
        const base = posix.basename(f.path);
        const chrome = /^\+(layout|error)\b/.test(base);
        if (!chrome && !/^\+page\b/.test(base))
            continue;
        const section = sectionOf(fileArea(f.path, routesDir), appBase);
        const name = chrome && section === "landing" ? NAVIGATION_AREA : label(section);
        const stack = [f.path];
        const visited = new Set();
        for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
            if (visited.has(p))
                continue;
            visited.add(p);
            reached.set(p, (reached.get(p) ?? new Set()).add(name));
            stack.push(...(graph.get(p) ?? []));
        }
    }
    return new Map([...reached].map(([p, s]) => [p, [...s].sort()]));
}
/**
 * For each file, the route items whose +page files render it, following imports: the page a
 * component belongs to. Layouts and error pages are left out, so app-wide chrome belongs to no page.
 */
export function fileRoutes(files, routes, surface) {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const graph = new Map(files.map((f) => [f.path, importedFiles(f, byPath)]));
    const reached = new Map();
    for (const r of routes) {
        if (!r.page)
            continue;
        const id = `${surface}:route:${r.path}`;
        const stack = r.page.files.filter((p) => byPath.has(p));
        const visited = new Set();
        for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
            if (visited.has(p))
                continue;
            visited.add(p);
            reached.set(p, (reached.get(p) ?? new Set()).add(id));
            stack.push(...(graph.get(p) ?? []));
        }
    }
    return new Map([...reached].map(([p, s]) => [p, [...s].sort()]));
}
/** "data-health" as "Data health". */
export function sentenceCase(section) {
    const words = section.replace(/[-_]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}
export function testIdItems(hits, ctx) {
    const byValue = new Map();
    for (const h of hits)
        byValue.set(h.value, [...(byValue.get(h.value) ?? []), h]);
    const items = [];
    for (const [value, group] of byValue) {
        const files = [
            ...new Set(group.flatMap((h) => (h.via ? [h.file, h.via] : [h.file]))),
        ].sort();
        const callers = [...new Set(group.map((h) => h.file))].sort();
        const areas = [...new Set(callers.map((f) => fileArea(f)))];
        const sections = ctx.fileSections
            ? [
                ...new Set(callers.flatMap((f) => ctx.fileSections?.get(f) ?? [])),
            ].sort()
            : undefined;
        const area = sections === undefined
            ? (areas[0] ?? "unknown")
            : sections.length > 1
                ? SHARED_AREA
                : (sections[0] ?? UNUSED_AREA);
        const via = [
            ...new Set(group.flatMap((h) => (h.via ? [h.via] : []))),
        ].sort();
        const expressions = [
            ...new Set(group.flatMap((h) => (h.expression ? [h.expression] : []))),
        ];
        const dynamic = group.some((h) => h.dynamic);
        const pages = [
            ...new Set(callers.flatMap((f) => ctx.fileRoutes?.get(f) ?? [])),
        ].sort();
        items.push({
            id: `${ctx.surface}:testid:${value}`,
            label: `Test id ${value}`,
            surface: ctx.surface,
            area,
            ...(pages.length === 1 ? { parent: pages[0] } : {}),
            envs: [...ctx.envs],
            seen: [ctx.seen(callers[0] ?? "")],
            details: {
                files,
                occurrences: group.length,
                dynamic,
                ...(sections === undefined
                    ? areas.length > 1
                        ? { areas }
                        : {}
                    : sections.length > 1
                        ? { sections }
                        : {}),
                ...(via.length > 0 ? { via } : {}),
                ...(pages.length > 1 ? { usedBy: pages } : {}),
                ...(expressions.length > 0 ? { expressions } : {}),
            },
        });
    }
    return items;
}
/** Every .svelte/.ts/.js file under `dir/sub`, paths relative to `dir`. */
export async function readSources(dir, sub = "src") {
    const entries = await readdir(join(dir, sub), {
        recursive: true,
        withFileTypes: true,
    });
    const files = [];
    for (const e of entries) {
        if (!e.isFile() || !/\.(svelte|ts|js)$/.test(e.name))
            continue;
        const abs = join(e.parentPath, e.name);
        files.push({
            path: relative(dir, abs).split(sep).join("/"),
            text: await readFile(abs, "utf8"),
        });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}
//# sourceMappingURL=sveltekit.js.map