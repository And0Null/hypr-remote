import { read, run } from "../run";

export type Media = { status: string; artist: string; title: string; player: string };

export async function readMedia(): Promise<Media | null> {
  // A separator no song title will contain.
  const output = await read([
    "playerctl",
    "metadata",
    "--format",
    "{{status}}␟{{artist}}␟{{title}}␟{{playerName}}",
  ]);
  if (!output) return null;
  const [status = "", artist = "", title = "", player = ""] = output.split("␟");
  return { status, artist, title, player };
}

export async function mediaCommand(command: "play-pause" | "next" | "previous" | "pause" | "play") {
  await run(["playerctl", command]);
}
