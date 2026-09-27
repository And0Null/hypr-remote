import type { Subprocess } from "bun";

import { installed } from "./run";

/** Which part of the state a change makes stale, as refresh() takes it. */
export type Stale = "fast" | "both";

/**
 * Volume, sound output and media changes, the instant they happen, from two
 * long-lived processes instead of polling. A missing tool just means no events
 * from it; polling still covers it.
 */
export function watchAudioAndMedia(onChange: (stale: Stale) => void) {
  // A volume drag fires dozens of events: report the burst once.
  let pending: ReturnType<typeof setTimeout> | undefined;
  let stale: Stale = "fast";
  const changed = (what: Stale) => {
    if (what === "both") stale = "both";
    clearTimeout(pending);
    pending = setTimeout(() => {
      onChange(stale);
      stale = "fast";
    }, 50);
  };

  let followers: { stop(): void }[] = [];
  return {
    /** Idempotent, so it can be called for every phone that connects. */
    start() {
      if (followers.length > 0) return;
      followers = [
        // "Event 'change' on sink #56". Sink changes are volume and mute; the
        // server changes when the default output does, which the outputs show.
        follow(["pactl", "subscribe"], (line) => {
          if (/ on sink #/.test(line)) changed(line.includes("'change'") ? "fast" : "both");
          // App streams and the microphone.
          else if (/ on (sink-input|source) #/.test(line)) changed("fast");
          // A card changing profile (to HDMI, say) changes the outputs.
          else if (/ on (server|card) #/.test(line)) changed("both");
        }),
        // Prints a line whenever any of these change.
        follow(
          ["playerctl", "--follow", "metadata", "--format", "{{status}}␟{{artist}}␟{{title}}␟{{playerName}}"],
          () => changed("fast"),
        ),
      ];
    },
    stop() {
      for (const follower of followers) follower.stop();
      followers = [];
      clearTimeout(pending);
    },
  };
}

/** Runs argv for as long as it's wanted, calling onLine per line of output. */
function follow(argv: string[], onLine: (line: string) => void) {
  let stopped = !installed(argv[0]!);
  let child: Subprocess<"ignore", "pipe", "ignore"> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;

  async function spawn() {
    if (stopped) return;
    try {
      child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      let buffered = "";
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        // Output means it's healthy, so the next crash restarts quickly again.
        delay = 1000;
        const lines = (buffered + chunk).split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) onLine(line);
      }
      await child.exited;
    } catch {
      // Uninstalled since it started, or killed mid-read: retry either way.
    }
    if (stopped) return;
    // It died on its own (PipeWire restarted, say): back off up to a minute.
    retry = setTimeout(spawn, delay);
    delay = Math.min(delay * 2, 60_000);
  }

  void spawn();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      child?.kill();
    },
  };
}
