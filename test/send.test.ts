import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveUpload } from "../src/features/send";

// Never the real ~/Downloads.
const dir = mkdtempSync(join(tmpdir(), "hypr-remote-send-"));

/** A real request body, as Bun.serve hands it over. */
async function upload(name: string, body: string | Uint8Array<ArrayBuffer>, limit = 1_000_000) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    maxRequestBodySize: 10_000_000,
    fetch: async (request) => Response.json(await saveUpload(name, request.body, limit, dir)),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`, { method: "POST", body });
    return (await response.json()) as string | null;
  } finally {
    server.stop();
  }
}

describe("saveUpload", () => {
  test("writes small and large files to Downloads", async () => {
    expect(await upload("note.txt", "hello")).toBe("note.txt");
    expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("hello");
    const big = new Uint8Array(3_000_000).fill(7);
    expect(await upload("big.bin", big, 5_000_000)).toBe("big.bin");
    expect(readFileSync(join(dir, "big.bin")).length).toBe(3_000_000);
  });

  test("never overwrites, and strips paths from names", async () => {
    expect(await upload("note.txt", "again")).toBe("note (2).txt");
    expect(await upload("../../etc/passwd", "x")).toBe("passwd");
  });

  test("refuses a file over the limit and leaves nothing behind", async () => {
    expect(await upload("huge.bin", new Uint8Array(2_000_000), 1_000_000)).toBeNull();
    expect(() => readFileSync(join(dir, "huge.bin"))).toThrow();
  });
});
