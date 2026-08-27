import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIDEO_PAGE_SIZE,
  MAX_VIDEO_PAGE_SIZE,
  decodeVideoListCursor,
  encodeVideoListCursor,
  paginateVideoRows,
  parseVideoListLimit,
  videoListCursorFilter,
} from "@/lib/video-history-pagination.js";

describe("parseVideoListLimit", () => {
  it("defaults to 24", () => {
    expect(parseVideoListLimit(null)).toBe(DEFAULT_VIDEO_PAGE_SIZE);
    expect(parseVideoListLimit("")).toBe(24);
  });

  it("caps at 48", () => {
    expect(parseVideoListLimit("100")).toBe(MAX_VIDEO_PAGE_SIZE);
  });

  it("rejects invalid values", () => {
    expect(parseVideoListLimit("0")).toBe(24);
    expect(parseVideoListLimit("abc")).toBe(24);
  });
});

describe("video list cursor", () => {
  it("round-trips created_at and id", () => {
    const row = {
      created_at: "2026-08-27T12:00:00.000Z",
      id: "11111111-1111-1111-1111-111111111111",
    };
    const cursor = encodeVideoListCursor(row);
    expect(decodeVideoListCursor(cursor)).toEqual(row);
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeVideoListCursor("not-valid")).toThrow(/Invalid cursor/);
    expect(() =>
      decodeVideoListCursor(
        Buffer.from(JSON.stringify({ created_at: "x" }), "utf8").toString(
          "base64url"
        )
      )
    ).toThrow(/Invalid cursor/);
  });

  it("builds a stable PostgREST filter", () => {
    expect(
      videoListCursorFilter({
        created_at: "2026-08-27T12:00:00.000Z",
        id: "22222222-2222-2222-2222-222222222222",
      })
    ).toBe(
      "created_at.lt.2026-08-27T12:00:00.000Z,and(created_at.eq.2026-08-27T12:00:00.000Z,id.lt.22222222-2222-2222-2222-222222222222)"
    );
  });
});

describe("paginateVideoRows", () => {
  it("returns nextCursor when more rows exist", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      created_at: `2026-08-${String(27 - i).padStart(2, "0")}T12:00:00.000Z`,
      prompt: `Clip ${i}`,
      payload: { aspectRatio: "9:16" },
    }));

    const { videos, nextCursor } = paginateVideoRows(rows, 24);
    expect(videos).toHaveLength(24);
    expect(nextCursor).toBeTruthy();
    expect(decodeVideoListCursor(nextCursor)).toEqual({
      created_at: videos[23].created_at,
      id: videos[23].id,
    });
  });

  it("returns null nextCursor on the last page", () => {
    const rows = [
      {
        id: "11111111-1111-1111-1111-111111111111",
        created_at: "2026-08-27T12:00:00.000Z",
        prompt: "Only one",
        payload: {},
      },
    ];
    const { videos, nextCursor } = paginateVideoRows(rows, 24);
    expect(videos).toHaveLength(1);
    expect(nextCursor).toBeNull();
  });
});
