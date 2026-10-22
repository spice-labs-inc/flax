import { config } from "../config.js";
import { SURFACES, isRecord } from "../lib/types.js";
const vocab = () => config().vocabulary;
const PERSONA_TYPES = {
    get length() {
        return vocab().personaTypes.length;
    },
    includes: (v) => vocab().personaTypes.includes(v),
    join: (s) => vocab().personaTypes.join(s),
};
const EDITIONS = {
    includes: (v) => vocab().editions.length === 0 || vocab().editions.includes(v),
    join: (s) => vocab().editions.join(s),
};
const STAGES = {
    includes: (v) => vocab().stages.includes(v),
    join: (s) => vocab().stages.join(s),
};
const STATION_KINDS = {
    includes: (v) => vocab().stationKinds.includes(v),
    join: (s) => vocab().stationKinds.join(s),
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PERSONA_ID = /^[a-z][a-z0-9-]*$/;
const STATION_KEY = /^[a-z][A-Za-z0-9]*$/;
/** Persona file fields, in the order every persona file keeps them. */
export const PERSONA_FIELDS = [
    { key: "id", type: "string", required: "always", pattern: PERSONA_ID },
    { key: "name", type: "string", required: "always" },
    { key: "type", type: "string", enum: PERSONA_TYPES },
    { key: "summary", type: "string", required: "always" },
    { key: "who", type: "string", required: "always" },
    { key: "titles", type: "strings", required: "designed" },
    { key: "goals", type: "strings", required: "designed" },
    { key: "needs", type: "strings", required: "designed" },
    { key: "consumes", type: "string", required: "designed" },
    {
        key: "prize",
        type: "object",
        fields: [
            { key: "quote", type: "string", optional: true, required: "always" },
            { key: "test", type: "string", required: "always" },
        ],
    },
    {
        key: "journey",
        type: "object",
        fields: [
            { key: "name", type: "string", required: "designed" },
            { key: "steps", type: "strings", required: "designed" },
        ],
    },
    { key: "friction", type: "strings", required: "designed" },
    { key: "antiGoals", type: "strings", required: "designed" },
    { key: "surfaces", type: "strings", required: "designed" },
    { key: "neverTouches", type: "strings" },
    {
        key: "editions",
        type: "strings",
        ...(config().vocabulary.editions.length
            ? { required: "designed" }
            : {}),
        enum: EDITIONS,
    },
    { key: "fixtureRole", type: "string", required: "always" },
    {
        key: "tensions",
        type: "objects",
        fields: [
            { key: "with", type: "string", required: "always" },
            { key: "conflict", type: "string", required: "always" },
            { key: "rule", type: "string", required: "always" },
        ],
    },
    {
        key: "evidence",
        type: "objects",
        required: "always",
        fields: [
            { key: "claim", type: "string", required: "always" },
            { key: "source", type: "string", required: "always" },
            { key: "date", type: "string", pattern: DATE },
            { key: "assumption", type: "boolean" },
        ],
    },
    {
        key: "sources",
        type: "objects",
        required: "always",
        fields: [
            { key: "title", type: "string", required: "always" },
            { key: "date", type: "string", pattern: DATE },
            { key: "where", type: "string", required: "always" },
        ],
    },
];
export const STATION_FIELDS = [
    { key: "key", type: "string", pattern: STATION_KEY },
    { key: "name", type: "string", required: "always" },
    { key: "stage", type: "string", enum: STAGES },
    { key: "kind", type: "string", enum: STATION_KINDS },
    { key: "match", type: "strings" },
];
const STATIONS_FILE_FIELDS = [
    {
        key: "stations",
        type: "objects",
        required: "always",
        fields: STATION_FIELDS,
    },
];
export const JOURNEY_FIELDS = [
    { key: "persona", type: "string", pattern: PERSONA_ID },
    { key: "stations", type: "strings", required: "always" },
];
/** The text rules from the config, compiled once. */
function textRules() {
    return config().textRules.map((r) => ({
        pattern: new RegExp(r.pattern, "giu"),
        message: r.message,
    }));
}
/** Wording rules over the whole file text, comments included. */
export function checkText(path, text) {
    const errors = [];
    for (const rule of textRules()) {
        for (const m of text.matchAll(rule.pattern)) {
            const line = text.slice(0, m.index).split("\n").length;
            errors.push(`${path}:${line}: ${rule.message}`);
        }
    }
    return errors;
}
/** Why a matcher is malformed, or null when it is well formed. */
export function matcherProblem(matcher) {
    const colon = matcher.indexOf(":");
    const surface = colon < 0 ? "" : matcher.slice(0, colon);
    if (!SURFACES.includes(surface))
        return `matcher "${matcher}" does not start with a surface name (${SURFACES.join(", ")})`;
    const anyMethod = config().matchers.apiPath && anyMethodPrefix(surface, matcher);
    const rest = anyMethod
        ? matcher.slice(anyMethod.length)
        : matcher.slice(colon + 1);
    if (anyMethod && !rest.startsWith("/"))
        return `matcher "${matcher}": the any-method form is "${surface}:* /path"`;
    if (rest.length === 0 || rest === "*")
        return `matcher "${matcher}" matches a whole surface; name the items`;
    if (rest.slice(0, -1).includes("*"))
        return `matcher "${matcher}": "*" is allowed only at the end`;
    return null;
}
function checkFields(value, fields, where, designed, errors, allowExtra = false) {
    if (!isRecord(value)) {
        errors.push(`${where}: expected a mapping`);
        return;
    }
    const known = fields.map((f) => f.key);
    if (!allowExtra)
        for (const k of Object.keys(value))
            if (!known.includes(k))
                errors.push(`${where}: unknown field "${k}"`);
    const present = Object.keys(value).filter((k) => known.includes(k));
    const expected = known.filter((k) => k in value);
    if (present.join() !== expected.join())
        errors.push(`${where}: fields out of order; expected ${expected.join(", ")}`);
    for (const f of fields) {
        const at = `${where}.${f.key}`;
        const v = value[f.key];
        if (v === undefined) {
            if (!(f.type === "string" && f.optional))
                errors.push(`${at}: missing`);
            continue;
        }
        const mustFill = "required" in f &&
            (f.required === "always" || (f.required === "designed" && designed));
        switch (f.type) {
            case "string":
                if (typeof v !== "string") {
                    errors.push(`${at}: expected text`);
                    break;
                }
                if (mustFill && v.trim() === "")
                    errors.push(`${at}: empty`);
                if (f.enum && !f.enum.includes(v))
                    errors.push(`${at}: "${v}" is not one of ${f.enum.join(", ")}`);
                if (f.pattern && !f.pattern.test(v))
                    errors.push(`${at}: "${v}" does not match ${f.pattern.source}`);
                if (f.pattern === DATE && DATE.test(v) && !validDate(v))
                    errors.push(`${at}: "${v}" is not a real date`);
                break;
            case "strings":
                if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
                    errors.push(`${at}: expected a list of text`);
                    break;
                }
                if (mustFill && v.length === 0)
                    errors.push(`${at}: empty`);
                v.forEach((s, i) => {
                    if (s.trim() === "")
                        errors.push(`${at}[${i}]: empty`);
                    if (f.enum && !f.enum.includes(s))
                        errors.push(`${at}[${i}]: "${s}" is not one of ${f.enum.join(", ")}`);
                });
                break;
            case "boolean":
                if (typeof v !== "boolean")
                    errors.push(`${at}: expected true or false`);
                break;
            case "object":
                checkFields(v, f.fields, at, designed, errors);
                break;
            case "objects":
                if (!Array.isArray(v)) {
                    errors.push(`${at}: expected a list`);
                    break;
                }
                if (mustFill && v.length === 0)
                    errors.push(`${at}: empty`);
                v.forEach((o, i) => checkFields(o, f.fields, `${at}[${i}]`, designed, errors));
                break;
        }
    }
}
function validDate(s) {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}
function baseName(path) {
    return path.slice(path.lastIndexOf("/") + 1);
}
function duplicates(values) {
    return [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
}
/** Checks every rule; `dataset` holds only the files that passed their own structural checks. */
export function validateDataset(files) {
    const errors = [];
    const warnings = [];
    const dataset = { personas: [], stations: [], journeys: [] };
    const pathOf = new Map();
    const structural = (file, fields, designed, allowExtra = false) => {
        errors.push(...checkText(file.path, file.text));
        if (file.parseError !== undefined) {
            errors.push(`${file.path}: ${file.parseError}`);
            return false;
        }
        const before = errors.length;
        const data = file.data;
        checkFields(data, fields, file.path, isRecord(data) && designed(data), errors, allowExtra);
        if (allowExtra && isRecord(data))
            for (const key of config().personaRequiredFields) {
                const v = data[key];
                if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0))
                    errors.push(`${file.path}.${key}: missing (required by the config)`);
            }
        return errors.length === before;
    };
    for (const file of files.personas) {
        const ok = structural(file, PERSONA_FIELDS, (d) => d["type"] !== "negative", true);
        if (!ok)
            continue;
        const p = file.data;
        if (baseName(file.path) !== `${p.id}.yml`)
            errors.push(`${file.path}: file name must be ${p.id}.yml`);
        pathOf.set(p, file.path);
        dataset.personas.push(p);
    }
    if (files.stations) {
        const file = files.stations;
        if (structural(file, STATIONS_FILE_FIELDS, () => true)) {
            const stations = file.data.stations;
            stations.forEach((s, i) => {
                const at = `${file.path}.stations[${i}] (${s.key})`;
                if (s.kind === "surface" && s.match.length === 0)
                    errors.push(`${at}: a surface station needs at least one matcher`);
                for (const m of s.match) {
                    const problem = matcherProblem(m);
                    if (problem)
                        errors.push(`${at}: ${problem}`);
                }
                for (const m of duplicates(s.match))
                    errors.push(`${at}: matcher "${m}" listed twice`);
            });
            for (const k of duplicates(stations.map((s) => s.key)))
                errors.push(`${file.path}: station "${k}" defined twice`);
            dataset.stations = stations;
        }
    }
    else if (files.journeys.length > 0) {
        errors.push("journeys/stations.yml: missing; journeys reference its stations");
    }
    for (const file of files.journeys) {
        if (!structural(file, JOURNEY_FIELDS, () => true))
            continue;
        const j = file.data;
        if (baseName(file.path) !== `${j.persona}.yml`)
            errors.push(`${file.path}: file name must be ${j.persona}.yml`);
        pathOf.set(j, file.path);
        dataset.journeys.push(j);
    }
    const personaIds = dataset.personas.map((p) => p.id);
    for (const id of duplicates(personaIds))
        errors.push(`personas: id "${id}" used by more than one file`);
    const personaById = new Map(dataset.personas.map((p) => [p.id, p]));
    for (const p of dataset.personas) {
        p.tensions.forEach((t, i) => {
            if (t.with === p.id)
                errors.push(`${pathOf.get(p)}.tensions[${i}]: a tension with itself`);
            else if (!personaById.has(t.with))
                errors.push(`${pathOf.get(p)}.tensions[${i}]: unknown persona "${t.with}"`);
        });
    }
    const stationKeys = new Set(dataset.stations.map((s) => s.key));
    for (const id of duplicates(dataset.journeys.map((j) => j.persona)))
        errors.push(`journeys: more than one journey for persona "${id}"`);
    for (const j of dataset.journeys) {
        const at = pathOf.get(j) ?? "journeys";
        const p = personaById.get(j.persona);
        if (!p)
            errors.push(`${at}: unknown persona "${j.persona}"`);
        else if (p.type === "negative")
            errors.push(`${at}: "${j.persona}" is a negative persona; it has no journey`);
        j.stations.forEach((k, i) => {
            if (!stationKeys.has(k))
                errors.push(`${at}.stations[${i}]: unknown station "${k}"`);
        });
        for (const k of duplicates(j.stations))
            errors.push(`${at}: station "${k}" listed twice`);
    }
    const used = new Set(dataset.journeys.flatMap((j) => j.stations));
    for (const s of dataset.stations)
        if (!used.has(s.key))
            warnings.push(`journeys/stations.yml: station "${s.key}" is on no journey`);
    const withJourney = new Set(dataset.journeys.map((j) => j.persona));
    for (const p of dataset.personas)
        if (p.type !== "negative" && !withJourney.has(p.id))
            warnings.push(`${pathOf.get(p)}: no journey yet`);
    return { errors, warnings, dataset };
}
/** `<surface>:* ` when the surface is a service and the matcher uses the any-method form. */
export function anyMethodPrefix(surface, matcher) {
    const prefix = `${surface}:* `;
    const service = config().surfaces.some((s) => s.name === surface && s.role === "service");
    return service && matcher.startsWith(prefix) ? prefix : undefined;
}
//# sourceMappingURL=schema.js.map