import { read, run } from "../run";

export const CLIPBOARD_LIMIT = 100_000;

export async function setClipboard(text: string) {
  await run(["wl-copy"], { input: text, discardOutput: true });
}

/** Text only; an image on the clipboard reads as empty rather than as bytes. */
export async function getClipboard(): Promise<string> {
  const text = await read(["wl-paste", "--no-newline", "--type", "text/plain"]);
  return (text ?? "").slice(0, CLIPBOARD_LIMIT);
}
