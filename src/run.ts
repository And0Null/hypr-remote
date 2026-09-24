/**
 * Runs a program with a fixed argv — never through a shell — and collects its
 * output. Everything the phone triggers funnels through here or hypr.ts.
 */
export async function run(
  argv: string[],
  options: { input?: string; timeoutMs?: number; discardOutput?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!Bun.which(argv[0]!)) {
    return { code: 127, stdout: "", stderr: `${argv[0]} is not installed` };
  }

  // Programs that fork a daemon (wl-copy) hand it their stdout, so the pipe
  // never closes. For those, discard output and wait only for the exit.
  const output = options.discardOutput ? "ignore" : "pipe";
  const child = Bun.spawn(argv, {
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: output,
    stderr: output,
    timeout: options.timeoutMs ?? 5000,
  });
  if (options.discardOutput) return { code: await child.exited, stdout: "", stderr: "" };

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Output on success, null on any failure. For reads where "unknown" is fine. */
export async function read(argv: string[]): Promise<string | null> {
  const result = await run(argv);
  return result.code === 0 ? result.stdout : null;
}

export function installed(command: string): boolean {
  return Bun.which(command) !== null;
}

/** Single-quotes a string for /bin/sh. Only used for Hyprland's `exec`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
