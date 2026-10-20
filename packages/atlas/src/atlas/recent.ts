// `## recent`: the newest 5 lines, each `- <YYYY-MM-DD>: PR #N (merge <sha7>) <text>`,
// checked against the merged PRs on the repo's default branch (merge date in
// America/Los_Angeles). One paginated list call per repo.

import { execFileSync } from 'node:child_process';
import { section, type Doc } from './doc.ts';
import { config } from '../config.ts';

export const KEEP = 5;

/** Automation PRs that never make a recent line: release pin bumps (app-gitops) and dependency bumps. */
const NOISE_TITLE = () => new RegExp(config().docs.recentNoise, 'i');

export interface MergedPr {
  number: number;
  mergedAt: string;
  sha: string;
  title: string;
  bot: boolean;
}

const laFormat = () => new Intl.DateTimeFormat('en-CA', { timeZone: config().site.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
export const laDate = (iso: string): string => laFormat().format(new Date(iso));

export function listMerged(repo: string, base: string): MergedPr[] {
  const jq = '.[] | select(.merged_at != null) | {n: .number, m: .merged_at, s: .merge_commit_sha, t: .title, u: .user.login, ut: .user.type}';
  const out = execFileSync('gh', ['api', '--paginate', `repos/${repo}/pulls?state=closed&base=${encodeURIComponent(base)}&per_page=100`, '--jq', jq], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 << 20,
  });
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((p) => ({ number: p.n, mergedAt: p.m, sha: String(p.s ?? ''), title: String(p.t ?? '').replace(/\s+/g, ' ').trim(), bot: p.ut === 'Bot' || /\[bot\]$/.test(p.u ?? '') }));
}

export interface RecentLine {
  raw: string;
  date?: string;
  pr?: number;
  mergeSha?: string;
  shas: string[];
  leftovers: string[];
  rest: string;
  /** The head (date, PR, shas) parsed cleanly, so the line can be rewritten. */
  clean: boolean;
}

const SHA = /^`?([0-9a-f]{7,40})`?$/;

export function parseLine(raw: string): RecentLine {
  const line: RecentLine = { raw, shas: [], leftovers: [], rest: raw.replace(/^-\s*/, ''), clean: false };
  const m = raw.match(/^- (\d{4}-\d{2}-\d{2})(?:[ T]\d\d:\d\d(?::\d\d)?(?:\s*UTC|Z)?)?/);
  if (!m) return line;
  line.date = m[1];
  let p = m[0].length;
  const s = raw;
  for (;;) {
    const sep = s.slice(p).match(/^[\s,:]*/)![0];
    const at = p + sep.length;
    const tail = s.slice(at);
    let t: RegExpMatchArray | null;
    if ((t = tail.match(/^(?:PR\s*)?#(\d+)\b/)) && line.pr === undefined) {
      line.pr = Number(t[1]);
    } else if ((t = tail.match(/^`?([0-9a-f]{7,40})`?(?=[\s,:;)]|$)/))) {
      line.shas.push(t[1]);
    } else if ((t = tail.match(/^\(([^()]*)\)/))) {
      const parts = t[1].split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean);
      const useful = parts.some((x) => /^merge\s+`?[0-9a-f]{7,40}`?/.test(x) || SHA.test(x) || /^(?:PR\s*)?#\d+$/.test(x));
      if (!useful) break;
      for (const x of parts) {
        let mm: RegExpMatchArray | null;
        if ((mm = x.match(/^merge\s+`?([0-9a-f]{7,40})`?$/))) line.mergeSha = mm[1];
        else if ((mm = x.match(SHA))) line.shas.push(mm[1]);
        else if ((mm = x.match(/^(?:PR\s*)?#(\d+)$/)) && line.pr === undefined) line.pr = Number(mm[1]);
        else line.leftovers.push(x);
      }
    } else break;
    p = at + t[0].length;
  }
  const rest = s.slice(p).replace(/^[\s,]*:?\s*/, '');
  line.rest = rest;
  line.clean = line.pr !== undefined && rest.length > 0;
  return line;
}

export const render = (date: string, pr: number, sha: string, leftovers: string[], rest: string): string =>
  `- ${date}: PR #${pr} (merge ${[sha.slice(0, 7), ...leftovers].join(', ')}) ${rest}`.trimEnd();

export interface RecentReport {
  doc: string;
  error?: string;
  wrongDate: string[];
  wrongSha: string[];
  missingSha: string[];
  unknownPr: string[];
  reformat: number;
  noPr: number;
  dropped: number;
  added: string[];
  before: string;
  after: string;
}

export function reviseRecent(doc: Doc, prs: MergedPr[]): RecentReport {
  const s = section(doc, 'recent');
  const body = s ? s.body : '';
  const rep: RecentReport = { doc: doc.name, wrongDate: [], wrongSha: [], missingSha: [], unknownPr: [], reformat: 0, noPr: 0, dropped: 0, added: [], before: body, after: body };
  const byNum = new Map(prs.map((p) => [p.number, p]));
  const lines = body.split('\n').filter((l) => l.trim() && l.trim().toLowerCase() !== 'none');
  const kept: { date: string; text: string; pr?: number }[] = [];
  for (const raw of lines) {
    if (/^- Older entries: /.test(raw)) {
      rep.dropped++;
      continue;
    }
    const l = parseLine(raw);
    if (l.pr === undefined || !l.date) {
      rep.noPr++;
      kept.push({ date: l.date ?? raw.match(/^- (\d{4}-\d{2})\b/)?.[1] ?? '', text: raw });
      continue;
    }
    const pr = byNum.get(l.pr);
    if (!pr) {
      rep.unknownPr.push(`#${l.pr}`);
      kept.push({ date: l.date, text: raw, pr: l.pr });
      continue;
    }
    const date = laDate(pr.mergedAt);
    const sha7 = pr.sha.slice(0, 7);
    if (l.date !== date) rep.wrongDate.push(`#${l.pr} ${l.date} -> ${date}`);
    const hasMerge = l.mergeSha !== undefined ? pr.sha.startsWith(l.mergeSha) : l.shas.some((x) => pr.sha.startsWith(x));
    if (l.mergeSha !== undefined && !hasMerge) rep.wrongSha.push(`#${l.pr} ${l.mergeSha} -> ${sha7}`);
    else if (!hasMerge) rep.missingSha.push(`#${l.pr} -> ${sha7}`);
    const others = l.shas.filter((x) => !pr.sha.startsWith(x));
    const text = l.clean ? render(date, l.pr, pr.sha, [...others.map((x) => `commit ${x}`), ...l.leftovers], l.rest) : raw;
    if (l.clean && text !== raw) rep.reformat++;
    kept.push({ date: l.clean ? date : l.date, text, pr: l.pr });
  }
  const newest = kept.map((k) => k.date).filter(Boolean).sort().pop();
  const mentioned = new Set(kept.map((k) => k.pr).filter((n): n is number => n !== undefined));
  const maxPr = Math.max(0, ...mentioned);
  const fresh = prs
    .filter((p) => !p.bot && !NOISE_TITLE().test(p.title) && !mentioned.has(p.number))
    .filter((p) => {
      if (newest === undefined) return true;
      const d = laDate(p.mergedAt);
      return d > newest || (d === newest && p.number > maxPr);
    })
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .slice(0, KEEP);
  const added = fresh.map((p) => ({ date: laDate(p.mergedAt), text: render(laDate(p.mergedAt), p.number, p.sha, [], p.title), pr: p.number }));
  rep.added = added.map((a) => a.text);
  const all = [...added, ...kept].map((k, i) => ({ ...k, i })).sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.i - b.i);
  rep.dropped += Math.max(0, all.length - KEEP);
  const final = all.slice(0, KEEP).map((k) => k.text);
  rep.after = `${final.length ? final.join('\n') : 'none'}\n\n`;
  return rep;
}

export function applyRecent(doc: Doc, after: string): string {
  const s = section(doc, 'recent');
  if (!s) throw new Error(`${doc.file}: no ## recent`);
  const body = s.end === doc.text.length ? after.replace(/\n+$/, '\n') : after;
  return doc.text.slice(0, s.bodyStart) + body + doc.text.slice(s.end);
}

export function changed(rep: RecentReport): boolean {
  const norm = (x: string) => x.replace(/\n+$/, '');
  return norm(rep.before) !== norm(rep.after);
}
