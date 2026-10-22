// Stand-ins: text a recording shows in place of run-specific values (a
// generated account name, a test address, an id), so a video or screenshot
// shows stable, presentable text. The mechanism is generic; the rule sets
// come from the caller. One rule set applies in two places: in the browser,
// as a script that rewrites the page's text before it paints and whenever it
// changes, and to text shown outside a page (a terminal transcript, a
// caption) through the same function.

/** One replacement: a literal `text` or a regular expression `pattern`, and what each match becomes. */
export type StandInRule =
  | { text: string; with: string; ignoreCase?: boolean }
  | {
      pattern: string;
      /** Regular expression flags besides g, which is always on. */
      flags?: string;
      /** May refer to groups as $1 or $<name>. */
      with: string;
    };

/** A named list of rules, applied in order. */
export interface StandInRules {
  name?: string;
  rules: StandInRule[];
  /** CSS selector of elements whose text the page script never touches. Default: script, style, noscript and textarea. */
  skip?: string;
}

/** The rules as [source, flags, replacement] triples, literal text escaped and its replacement taken as is. */
export type CompiledRules = [string, string, string][];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Checks every rule and compiles it to a regular expression triple; throws on an empty match or a bad pattern. */
export function compileStandIns(rules: StandInRules): CompiledRules {
  return rules.rules.map((r, i) => {
    const where = `stand-in rule ${i + 1}${rules.name ? ` of ${rules.name}` : ""}`;
    if ("pattern" in r) {
      const flags = [...new Set(`g${r.flags ?? ""}`)].join("");
      let re: RegExp;
      try {
        re = new RegExp(r.pattern, flags);
      } catch (e) {
        throw new Error(`${where}: ${(e as Error).message}`);
      }
      if (re.test(""))
        throw new Error(`${where}: the pattern matches empty text`);
      return [r.pattern, flags, r.with];
    }
    if (r.text === "") throw new Error(`${where}: empty text`);
    return [
      escapeRe(r.text),
      r.ignoreCase ? "gi" : "g",
      r.with.replace(/\$/g, "$$$$"),
    ];
  });
}

/**
 * `text` with every compiled rule applied in order. Runs in the page too, as
 * its source text: it must use nothing from outside its own body.
 */
export function replaceStandIns(text: string, compiled: CompiledRules): string {
  let out = text;
  for (const [source, flags, replacement] of compiled)
    out = out.replace(new RegExp(source, flags), replacement);
  return out;
}

/** `text` with the rule set's stand-ins, for text shown outside a page. */
export function standInText(text: string, rules: StandInRules): string {
  return replaceStandIns(text, compileStandIns(rules));
}

/**
 * Every string in a JSON value (a terminal transcript, say) with the rule
 * set's stand-ins; keys and other values are kept.
 */
export function standInValue<T>(value: T, rules: StandInRules): T {
  const compiled = compileStandIns(rules);
  const walk = (v: unknown): unknown =>
    typeof v === "string"
      ? replaceStandIns(v, compiled)
      : Array.isArray(v)
        ? v.map(walk)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return walk(value) as T;
}

const DEFAULT_SKIP = "script,style,noscript,textarea";

/**
 * The page script for a browser context's init scripts: rewrites every text
 * node and every input's value (never the focused one or a password) before
 * the page paints, and again whenever the page changes. Attributes and the
 * URL are never touched. A node rewritten once is rewritten again from its
 * real text, so a replacement never applies twice.
 */
export function standInScript(rules: StandInRules): string {
  const compiled = compileStandIns(rules);
  return `(() => {
  const replace = ${replaceStandIns.toString()};
  const compiled = ${JSON.stringify(compiled)};
  const SKIP = ${JSON.stringify(rules.skip ?? DEFAULT_SKIP)};
  const written = new WeakMap();
  const fix = (node, value) => {
    if (!value) return value;
    const seen = written.get(node);
    const real = seen && seen.shown === value ? seen.real : value;
    const next = replace(real, compiled);
    if (next !== real) written.set(node, { real, shown: next });
    else written.delete(node);
    return next;
  };
  const fixText = (node) => {
    const parent = node.parentElement;
    if (parent && parent.closest(SKIP)) return;
    const next = fix(node, node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  };
  const fixInputs = () => {
    for (const el of document.querySelectorAll("input,textarea")) {
      if (el === document.activeElement || el.type === "password") continue;
      const next = fix(el, el.value);
      if (next !== el.value) el.value = next;
    }
  };
  const scan = (root) => {
    if (root.nodeType === 3) return fixText(root);
    if (root.nodeType === 1 && root.closest(SKIP)) return;
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeType === 3) fixText(n);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") fixText(r.target);
      else for (const n of r.addedNodes) scan(n);
    }
    fixInputs();
  }).observe(document, { childList: true, subtree: true, characterData: true });
  document.addEventListener("focusout", () => setTimeout(fixInputs, 0), true);
  if (document.readyState !== "loading") scan(document);
  else document.addEventListener("DOMContentLoaded", () => scan(document));
})();`;
}

/** Anything that takes init scripts, as a Playwright BrowserContext or Page does. */
export interface InitScriptTarget {
  addInitScript(script: string): Promise<unknown>;
}

/** Applies the rule set to every page the context opens from now on. */
export async function applyStandIns(
  target: InitScriptTarget,
  rules: StandInRules,
): Promise<void> {
  await target.addInitScript(standInScript(rules));
}
