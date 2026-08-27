import { describe, expect, it } from "vitest";
import {
  RETENTION_DAYS,
  retentionCutoff,
  sweepExpiredVideos,
} from "../worker/pipeline/retention.js";

describe("retentionCutoff", () => {
  it("is 14 days before the given instant", () => {
    expect(RETENTION_DAYS).toBe(14);
    expect(retentionCutoff(new Date("2026-08-27T12:00:00Z"))).toBe(
      "2026-08-13T12:00:00.000Z"
    );
  });
});

function makeSupabaseChatty(result = { error: null }) {
  const calls = [];
  const chain = {
    from: (t) => { calls.push(["from", t]); return chain; },
    update: (patch) => { calls.push(["update", patch]); return chain; },
    eq: (c, v) => { calls.push(["eq", c, v]); return chain; },
    not: (c, op, v) => { calls.push(["not", c, op, v]); return chain; },
    lt: (c, v) => { calls.push(["lt", c, v]); return result; },
  };
  return { supabase: chain, calls };
}

describe("sweepExpiredVideos", () => {
  it("marks done rows past retention as expired with nulled URLs", async () => {
    const { supabase, calls } = makeSupabaseChatty();
    const now = new Date("2026-08-27T12:00:00Z");

    await expect(sweepExpiredVideos(supabase, now)).resolves.toBeUndefined();

    expect(calls.find(([k]) => k === "from")[1]).toBe("videos");

    const update = calls.find(([k]) => k === "update")[1];
    expect(update.status).toBe("expired");
    expect(update.video_url).toBeNull();
    expect(update.thumbnail_url).toBeNull();

    expect(calls.find(([k]) => k === "eq")[2]).toBe("done");
    expect(calls.find(([k]) => k === "not")[1]).toBe("video_url");
    expect(calls.find(([k]) => k === "lt")[1]).toBe("created_at");
    expect(calls.find(([k]) => k === "lt")[2]).toBe("2026-08-13T12:00:00.000Z");
  });

  it("throws when the update fails", async () => {
    const { supabase } = makeSupabaseChatty({ error: { message: "boom" } });
    await expect(
      sweepExpiredVideos(supabase, new Date("2026-08-27T12:00:00Z"))
    ).rejects.toMatchObject({ message: "boom" });
  });
});
