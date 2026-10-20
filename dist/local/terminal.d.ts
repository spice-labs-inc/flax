export declare const SHELLS: readonly ["bash", "zsh", "pwsh"];
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
    completion: {
        bash: string;
        powershell: string;
    };
}
/**
 * A real shell in its own tmux server, typed into the way a person types. A prompt hook in
 * each shell appends the last command's exit status to a file, so the terminal knows when a
 * command has finished, and how, without printing anything a reader would see. Tests and
 * recordings both drive it: a recording only adds pacing and a viewer that types nothing.
 */
export declare class Terminal {
    readonly socket: string;
    readonly session = "scenario";
    readonly keys: Keystroke[];
    private readonly status;
    paced: boolean;
    readonly options: TerminalOptions;
    constructor(options: TerminalOptions);
    private tmux;
    /** Sets up the home as the installers would, starts the shell and waits for its first prompt. */
    start(): Promise<void>;
    private writeRcFiles;
    /** How many prompts the shell has shown, the first included. */
    private statuses;
    private waitForStatus;
    /** Types text, one key at a time and paced like a person when recording, in runs otherwise. */
    type(text: string): Promise<void>;
    /** Presses a key by its tmux name: Tab, Enter, C-c... */
    press(key: string): Promise<void>;
    /**
     * Types a command, presses Enter and waits for the next prompt. A newline in the command is
     * the Enter that continues it (after a trailing backslash), as a person types a long one.
     */
    run(command: string, timeoutMs?: number): Promise<CommandResult>;
    /** Abandons the line being typed, as Ctrl-C does, and waits for the fresh prompt. */
    interrupt(): Promise<void>;
    /** The visible screen. */
    screen(): Promise<string>;
    /** Everything the pane has shown, with wrapped lines joined. */
    history(): Promise<string>;
    /** Clears the screen and its history, out of sight: before a recording starts. */
    clear(): Promise<void>;
    /**
     * The command the recorder's viewer attaches with. It types nothing, since nothing writes to
     * its input, but it is not attached read-only: tmux 3.7 refuses send-keys while a read-only
     * client is attached ("client is read-only").
     */
    attachCommand(): string;
    close(): Promise<void>;
}
/** What a command printed: the history added since `before`, less its own command line(s) and the next prompt. */
export declare function commandOutput(before: string, after: string): string;
