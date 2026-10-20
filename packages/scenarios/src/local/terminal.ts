import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SHELLS = ["bash", "zsh", "pwsh"] as const;
export type Shell = (typeof SHELLS)[number];

/** A key as it was pressed, with when (ms since the epoch) and the bytes it sends. */
export interface Keystroke {
  at: number;
  data: string;
}

/** What a finished command did: its exit status and what it printed. */
export interface CommandResult {
  rc: number;
  output: string;
}

export interface TerminalOptions {
  shell: Shell;
  cols: number;
  rows: number;
  /** The sandbox: the shell's home, where scenarios keep their files. */
  home: string;
  /** The command under test: a wrapper script to install on the PATH, under `wrapperName`. */
  wrapper: string;
  wrapperName: string;
  /** Variables the shell starts with, besides HOME and PATH (the image name and the like). */
  env: Record<string, string>;
  /** Completion scripts generated once per run: bash/zsh's and PowerShell's. */
  completion: { bash: string; powershell: string };
}

// tmux key names to the bytes they send, for the keystroke record.
const KEY_BYTES: Record<string, string> = {
  Tab: "\t",
  Enter: "\r",
  Escape: "\u001b",
  BSpace: "\u007f",
};

const keyBytes = (key: string): string =>
  KEY_BYTES[key] ??
  (/^C-[a-z]$/.test(key) ? String.fromCharCode(key.charCodeAt(2) - 96) : key);

let servers = 0;

/**
 * A real shell in its own tmux server, typed into the way a person types. A prompt hook in
 * each shell appends the last command's exit status to a file, so the terminal knows when a
 * command has finished, and how, without printing anything a reader would see. Tests and
 * recordings both drive it: a recording only adds pacing and a viewer that types nothing.
 */
export class Terminal {
  readonly socket = `flax-${process.pid}-${++servers}`;
  readonly session = "scenario";
  readonly keys: Keystroke[] = [];
  private readonly status: string;
  paced = false;

  readonly options: TerminalOptions;

  constructor(options: TerminalOptions) {
    this.options = options;
    this.status = join(options.home, ".scenario-status");
  }

  private tmux(...args: string[]): Promise<{ stdout: string }> {
    return exec("tmux", ["-L", this.socket, ...args], { maxBuffer: 64 << 20 });
  }

  /** Sets up the home as the installers would, starts the shell and waits for its first prompt. */
  async start(): Promise<void> {
    const { home, shell } = this.options;
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await copyFile(this.options.wrapper, join(bin, this.options.wrapperName));
    await chmod(join(bin, this.options.wrapperName), 0o755);
    await writeFile(this.status, "");
    await this.writeRcFiles();
    const conf = join(home, ".scenario-tmux.conf");
    await writeFile(conf, "set -g history-limit 50000\nset -g status off\n");
    const env = {
      ...this.options.env,
      HOME: home,
      PATH: [bin, process.env["PATH"] ?? "/usr/bin:/bin"].join(":"),
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      SCENARIO_STATUS: this.status,
    };
    const exports = Object.entries(env)
      .map(([k, v]) => `${k}=${shq(v)}`)
      .join(" ");
    await exec("tmux", [
      "-L",
      this.socket,
      "-f",
      conf,
      "new-session",
      "-d",
      "-s",
      this.session,
      "-x",
      String(this.options.cols),
      "-y",
      String(this.options.rows),
      "-c",
      home,
      `env -i ${exports} ${launch(shell, home)}`,
    ]);
    await this.waitForStatus(0, 30_000);
  }

  private async writeRcFiles(): Promise<void> {
    const { home, completion } = this.options;
    const prompt = {
      bash: `PS1='\\[\\e[34m\\]\\w\\[\\e[0m\\] \\[\\e[32m\\]❯\\[\\e[0m\\] '`,
      zsh: `PROMPT='%F{blue}%~%f %F{green}❯%f '; RPROMPT=''`,
    };
    // bash and zsh load the same completion script, zsh through bashcompinit, as the installer
    // sets them up; the shims stand in for the bash-completion package a plain system lacks.
    const shims = [
      "if ! type _init_completion >/dev/null 2>&1; then",
      '  _init_completion() { COMPREPLY=(); cur="${COMP_WORDS[COMP_CWORD]}"; prev="${COMP_WORDS[COMP_CWORD-1]}"; words=("${COMP_WORDS[@]}"); cword=$COMP_CWORD; return 0; }',
      "fi",
      "type _filedir >/dev/null 2>&1 || _filedir() { :; }",
    ].join("\n");
    await writeFile(
      join(home, ".bashrc"),
      [
        "bind 'set bell-style none' 2>/dev/null",
        shims,
        `[ -f ${shq(completion.bash)} ] && source ${shq(completion.bash)}`,
        prompt.bash,
        `PROMPT_COMMAND='printf "%s\\n" "$?" >> "$SCENARIO_STATUS"'`,
        "",
      ].join("\n"),
    );
    await mkdir(join(home, ".zdotdir"), { recursive: true });
    await writeFile(
      join(home, ".zdotdir", ".zshrc"),
      [
        "unsetopt PROMPT_SP 2>/dev/null",
        "setopt NO_BEEP",
        "autoload -U +X compinit && compinit -u 2>/dev/null",
        "autoload -U +X bashcompinit && bashcompinit 2>/dev/null",
        shims,
        `[ -f ${shq(completion.bash)} ] && source ${shq(completion.bash)}`,
        prompt.zsh,
        'precmd() { print -r -- $? >> "$SCENARIO_STATUS" }',
        "",
      ].join("\n"),
    );
    // PowerShell: a plain editor (no predictions, no bell), the prompt ~-relative even where
    // macOS reports /var as /private/var, and the status from $? or the native exit code.
    await writeFile(
      join(home, ".scenario-profile.ps1"),
      [
        "Set-PSReadLineOption -PredictionSource None -BellStyle None",
        '$__h = [System.IO.Path]::GetFullPath($HOME).TrimEnd("/"); $__homes = @($__h, "/private$__h")',
        "function prompt {",
        "  $ok = $?; $rc = if ($ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }; $global:LASTEXITCODE = 0",
        "  Add-Content -LiteralPath $env:SCENARIO_STATUS -Value $rc",
        '  $p = $PWD.ProviderPath; foreach ($h in $__homes) { if ($p -eq $h -or $p.StartsWith("$h/")) { $p = "~" + $p.Substring($h.Length); break } }',
        '  "$([char]27)[34m$p$([char]27)[0m $([char]27)[32m❯$([char]27)[0m "',
        "}",
        `if (Test-Path ${psq(completion.powershell)}) { . ${psq(completion.powershell)} }`,
        "",
      ].join("\n"),
    );
  }

  /** How many prompts the shell has shown, the first included. */
  private async statuses(): Promise<string[]> {
    const text = await readFile(this.status, "utf8").catch(() => "");
    return text.split("\n").filter((l) => l.trim() !== "");
  }

  private async waitForStatus(
    seen: number,
    timeoutMs: number,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.statuses();
      if (s.length > seen) return Number(s[s.length - 1]);
      await sleep(100);
    }
    throw new Error(
      `the shell showed no prompt within ${Math.round(timeoutMs / 1000)}s; the screen:\n${await this.screen()}`,
    );
  }

  /** Types text, one key at a time and paced like a person when recording, in runs otherwise. */
  async type(text: string): Promise<void> {
    const lines = text.split("\n");
    for (const [i, line] of lines.entries()) {
      if (i > 0) {
        // A newline is the Enter that continues a long command after its backslash.
        await this.press("Enter");
        if (this.paced) await sleep(300);
      }
      const pieces = this.paced ? [...line] : runs(line);
      for (const piece of pieces) {
        const at = Date.now();
        for (const ch of piece) this.keys.push({ at, data: ch });
        await this.tmux(
          "send-keys",
          "-t",
          this.session,
          "-l",
          tmuxLiteral(piece),
        );
        if (this.paced) await sleep(80 + Math.floor(Math.random() * 101));
      }
    }
  }

  /** Presses a key by its tmux name: Tab, Enter, C-c... */
  async press(key: string): Promise<void> {
    this.keys.push({ at: Date.now(), data: keyBytes(key) });
    await this.tmux("send-keys", "-t", this.session, key);
  }

  /**
   * Types a command, presses Enter and waits for the next prompt. A newline in the command is
   * the Enter that continues it (after a trailing backslash), as a person types a long one.
   */
  async run(command: string, timeoutMs = 60_000): Promise<CommandResult> {
    const seen = (await this.statuses()).length;
    const before = await this.history();
    await this.type(command);
    if (this.paced) await sleep(400);
    await this.press("Enter");
    const rc = await this.waitForStatus(seen, timeoutMs);
    return { rc, output: commandOutput(before, await this.history()) };
  }

  /** Abandons the line being typed, as Ctrl-C does, and waits for the fresh prompt. */
  async interrupt(): Promise<void> {
    const seen = (await this.statuses()).length;
    await this.press("C-c");
    await this.waitForStatus(seen, 10_000);
  }

  /** The visible screen. */
  async screen(): Promise<string> {
    return (await this.tmux("capture-pane", "-p", "-t", this.session)).stdout;
  }

  /** Everything the pane has shown, with wrapped lines joined. */
  async history(): Promise<string> {
    return (
      await this.tmux("capture-pane", "-p", "-J", "-S", "-", "-t", this.session)
    ).stdout;
  }

  /** Clears the screen and its history, out of sight: before a recording starts. */
  async clear(): Promise<void> {
    await this.run("clear");
    await this.tmux("clear-history", "-t", this.session);
  }

  /**
   * The command the recorder's viewer attaches with. It types nothing, since nothing writes to
   * its input, but it is not attached read-only: tmux 3.7 refuses send-keys while a read-only
   * client is attached ("client is read-only").
   */
  attachCommand(): string {
    return `tmux -u -L ${this.socket} attach-session -f ignore-size -t ${this.session}`;
  }

  async close(): Promise<void> {
    await this.tmux("kill-server").catch(() => undefined);
  }
}

/** What a command printed: the history added since `before`, less its own command line(s) and the next prompt. */
export function commandOutput(before: string, after: string): string {
  const old = before.replace(/\n+$/, "");
  const prefix = old.slice(0, old.lastIndexOf("\n") + 1);
  const added = after.startsWith(prefix) ? after.slice(prefix.length) : after;
  const lines = added.replace(/\n+$/, "").split("\n");
  // The command line itself, and any continuation lines a long command took.
  let start = 1;
  while (start < lines.length && /^\s*> /.test(lines[start] ?? "")) start++;
  // The prompt the command ended at.
  let end = lines.length;
  while (end > start && /❯\s*$/.test(lines[end - 1] ?? "")) end--;
  return lines.slice(start, end).join("\n");
}

function launch(shell: Shell, home: string): string {
  switch (shell) {
    case "bash":
      return `bash --noprofile --rcfile ${shq(join(home, ".bashrc"))} -i`;
    case "zsh":
      return `ZDOTDIR=${shq(join(home, ".zdotdir"))} zsh -o NO_GLOBAL_RCS -i`;
    case "pwsh":
      return `pwsh -NoLogo -NoProfile -NoExit -Command ${shq(`. ${join(home, ".scenario-profile.ps1")}`)}`;
  }
}

/** Text in runs for send-keys, each `;` on its own: tmux takes a bare `;` argument as a command separator. */
function runs(text: string): string[] {
  return text.split(/(;)/).filter((p) => p !== "");
}

/** A piece of text as send-keys -l takes it literally. */
function tmuxLiteral(piece: string): string {
  return piece === ";" ? "\\;" : piece;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;
