import { describe, expect, test } from "bun:test";

import { imageType, MEDIA_FORMAT, parseMedia } from "../src/features/media";

const line = (...fields: string[]) => fields.join("␟");

describe("parseMedia", () => {
  test("asks playerctl for every field it reads", () => {
    expect(MEDIA_FORMAT.split("␟")).toHaveLength(7);
  });

  test("reads times in seconds and keeps the art address apart", () => {
    const { media, artUrl } = parseMedia(
      line("Playing", "Artist", "Song", "spotify", "83500000", "230000000", "https://i.scdn.co/image/ab"),
    );
    expect(media).toEqual({
      status: "Playing",
      artist: "Artist",
      title: "Song",
      player: "spotify",
      position: 83.5,
      length: 230,
    });
    expect(artUrl).toBe("https://i.scdn.co/image/ab");
  });

  test("leaves times null when the player doesn't give them", () => {
    const { media } = parseMedia(line("Paused", "", "Video", "firefox", "", "", ""));
    expect(media.position).toBeNull();
    expect(media.length).toBeNull();
  });

  test("treats a length of 0 as unknown, but a position of 0 as the start", () => {
    const { media } = parseMedia(line("Playing", "", "Stream", "mpv", "0", "0", ""));
    expect(media.position).toBe(0);
    expect(media.length).toBeNull();
  });
});

describe("imageType", () => {
  const bytes = (...values: number[]) => new Uint8Array(values);
  const text = (value: string) => new TextEncoder().encode(value);

  test("recognises the image types players use", () => {
    expect(imageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe("image/png");
    expect(imageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(imageType(text("GIF89a"))).toBe("image/gif");
    expect(imageType(text("RIFF1234WEBPVP8 "))).toBe("image/webp");
  });

  test("rejects anything else, whatever it's named", () => {
    expect(imageType(text("-----BEGIN OPENSSH PRIVATE KEY-----"))).toBeNull();
    expect(imageType(text("<svg xmlns"))).toBeNull();
    expect(imageType(bytes())).toBeNull();
  });
});
