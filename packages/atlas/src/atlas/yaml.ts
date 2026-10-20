// A small YAML reader for the subset the atlas generators read (frontmatter, flow files,
// kustomization.yml): block mappings, block and flow sequences, plain and quoted
// scalars, comments. Anything else throws, so an unknown layout fails loudly.

export type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

interface Line {
  indent: number;
  text: string;
  n: number;
}

function stripComment(s: string): string {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function scalar(raw: string, n: number): Yaml {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (/^"(.*)"$/.test(s)) return JSON.parse(s);
  if (/^'(.*)'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^[|>&*!{]/.test(s)) throw new Error(`yaml line ${n}: unsupported construct "${s.slice(0, 20)}"`);
  return s;
}

function flowSeq(raw: string, n: number): Yaml[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  const out: Yaml[] = [];
  let cur = '';
  let q = '';
  for (const c of inner) {
    if (q) {
      cur += c;
      if (c === q) q = '';
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === '[' || c === '{') throw new Error(`yaml line ${n}: nested flow collections are not supported`);
    else if (c === ',') {
      if (cur.trim()) out.push(scalar(cur, n));
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(scalar(cur, n));
  return out;
}

export function parseYaml(text: string): Yaml {
  const lines: Line[] = [];
  const src = text.split('\n');
  for (let i = 0; i < src.length; i++) {
    const t = stripComment(src[i]);
    if (!t.trim() || t.trim() === '---') continue;
    if (/\t/.test(t.match(/^\s*/)![0])) throw new Error(`yaml line ${i + 1}: tab indentation`);
    lines.push({ indent: t.match(/^ */)![0].length, text: t.trim(), n: i + 1 });
  }
  // Join multi-line flow sequences into one line.
  const joined: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = { ...lines[i] };
    const open = (s: string) => (s.match(/\[/g) ?? []).length - (s.match(/\]/g) ?? []).length;
    const valuePart = l.text.includes(': ') || l.text.endsWith(':') ? l.text.slice(l.text.indexOf(':') + 1) : l.text;
    if (/^\s*\[/.test(valuePart) || l.text.startsWith('[') || /^- \[/.test(l.text)) {
      while (open(l.text) > 0 && i + 1 < lines.length) l.text += ' ' + lines[++i].text;
    }
    joined.push(l);
  }
  let pos = 0;
  function block(indent: number): Yaml {
    const first = joined[pos];
    if (!first || first.indent < indent) return null;
    if (first.text.startsWith('- ') || first.text === '-') return seq(first.indent);
    if (first.text.startsWith('[')) {
      pos++;
      return flowSeq(first.text, first.n);
    }
    return map(first.indent);
  }
  function value(rest: string, l: Line, childIndent: number): Yaml {
    if (rest === '') {
      const next = joined[pos];
      if (next && (next.indent > l.indent || (next.indent === l.indent && next.text.startsWith('- ')))) return block(next.indent);
      return null;
    }
    if (rest.startsWith('[')) return flowSeq(rest, l.n);
    if (/^[|>][-+]?$/.test(rest)) {
      // Block scalar: its lines are everything indented deeper (comments already dropped).
      const parts: string[] = [];
      while (pos < joined.length && joined[pos].indent > l.indent) parts.push(joined[pos++].text);
      return parts.join('\n');
    }
    void childIndent;
    return scalar(rest, l.n);
  }
  function map(indent: number): Yaml {
    const out: { [k: string]: Yaml } = {};
    while (pos < joined.length && joined[pos].indent === indent && !joined[pos].text.startsWith('- ')) {
      const l = joined[pos++];
      const m = l.text.match(/^("[^"]+"|'[^']+'|[^:]+?):(?:\s+(.*))?$/);
      if (!m) throw new Error(`yaml line ${l.n}: expected "key: value", got "${l.text.slice(0, 40)}"`);
      const key = String(scalar(m[1], l.n));
      out[key] = value((m[2] ?? '').trim(), l, indent + 1);
    }
    if (pos < joined.length && joined[pos].indent > indent) throw new Error(`yaml line ${joined[pos].n}: unexpected indentation`);
    return out;
  }
  function seq(indent: number): Yaml {
    const out: Yaml[] = [];
    while (pos < joined.length && joined[pos].indent === indent && (joined[pos].text.startsWith('- ') || joined[pos].text === '-')) {
      const l = joined[pos++];
      const rest = l.text.replace(/^-\s*/, '');
      if (/^[^"'[\s][^:]*:(\s|$)/.test(rest)) {
        // A mapping item: re-read this line's remainder as the first key at a deeper indent.
        const inner = indent + (l.text.length - rest.length);
        joined.splice(pos, 0, { indent: inner, text: rest, n: l.n });
        out.push(map(inner));
      } else out.push(value(rest, l, indent + 1));
    }
    return out;
  }
  const result = block(0);
  if (pos < joined.length) throw new Error(`yaml line ${joined[pos].n}: could not read "${joined[pos].text.slice(0, 40)}"`);
  return result;
}
