import { hyprJson, type Monitor } from "../hypr";

/**
 * A small JPEG of one monitor, for the phone's live preview. Scaled down hard:
 * it's a glance at the screen, and it's fetched every couple of seconds.
 */
export async function captureMonitor(name: string): Promise<ArrayBuffer | null> {
  const monitors = await hyprJson<Monitor[]>("monitors");
  // Only a monitor that exists; the name never reaches grim otherwise.
  if (!monitors?.some((monitor) => monitor.name === name)) return null;

  const child = Bun.spawn(["grim", "-o", name, "-s", "0.4", "-t", "jpeg", "-q", "60", "-"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5000,
  });
  const [bytes, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
  return code === 0 ? bytes : null;
}
