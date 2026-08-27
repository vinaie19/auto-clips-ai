import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeVideoListCursor } from "@/lib/video-history-pagination.js";

const { auth, ensureUserProfile } = vi.hoisted(() => ({
  auth: vi.fn(),
  ensureUserProfile: vi.fn(),
}));

const listCalls = [];
let listResult = { data: [], error: null };
let countResult = { count: 0, error: null };
let supabaseMode = "firstPage";

function makeListChain() {
  const chain = {
    from: (table) => {
      listCalls.push(["from", table]);
      return chain;
    },
    select: (columns, opts) => {
      listCalls.push(["select", columns, opts]);
      return chain;
    },
    eq: (column, value) => {
      listCalls.push(["eq", column, value]);
      return chain;
    },
    order: (column, opts) => {
      listCalls.push(["order", column, opts]);
      return chain;
    },
    limit: (n) => {
      listCalls.push(["limit", n]);
      return chain;
    },
    or: (filter) => {
      listCalls.push(["or", filter]);
      return Promise.resolve(listResult);
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve(listResult).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

function makeCountChain() {
  return {
    from: () => ({
      select: (_columns, opts) => {
        listCalls.push(["countSelect", opts]);
        return {
          eq: () => Promise.resolve(countResult),
        };
      },
    }),
  };
}

vi.mock("@clerk/nextjs/server", () => ({
  auth,
}));

vi.mock("@/lib/user-credits", () => ({
  ensureUserProfile,
}));

vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => {
    if (supabaseMode === "cursorPage") {
      return makeListChain();
    }

    let call = 0;
    return {
      from: (table) => {
        call += 1;
        listCalls.push(["from", table, call]);
        if (call === 1) return makeListChain().from(table);
        return makeCountChain().from(table);
      },
    };
  },
}));

import { GET } from "@/app/api/videos/route";

function makeRequest(url = "http://localhost/api/videos") {
  return new Request(url);
}

describe("GET /api/videos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCalls.length = 0;
    supabaseMode = "firstPage";
    auth.mockResolvedValue({ userId: "user_123" });
    ensureUserProfile.mockResolvedValue(undefined);
    listResult = {
      data: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          prompt: "First clip",
          created_at: "2026-08-27T12:00:00.000Z",
          payload: { aspectRatio: "9:16", visualStyle: "realistic" },
        },
      ],
      error: null,
    };
    countResult = { count: 47, error: null };
  });

  it("returns the first page with totalCount", async () => {
    const response = await GET(makeRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.totalCount).toBe(47);
    expect(json.videos).toHaveLength(1);
    expect(json.videos[0]).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      aspectRatio: "9:16",
      visualStyle: "realistic",
    });
    expect(json.nextCursor).toBeNull();
    expect(listCalls.some((call) => call[0] === "countSelect")).toBe(true);
    expect(listCalls.find((call) => call[0] === "limit")[1]).toBe(25);
  });

  it("returns a next page without totalCount when cursor is provided", async () => {
    supabaseMode = "cursorPage";
    const lastRow = {
      id: "22222222-2222-2222-2222-222222222222",
      prompt: "Older clip",
      created_at: "2026-08-26T12:00:00.000Z",
      payload: {},
    };
    listResult = {
      data: Array.from({ length: 25 }, (_, i) => ({
        id: `00000000-0000-0000-0000-${String(i + 30).padStart(12, "0")}`,
        prompt: `Clip ${i}`,
        created_at: `2026-08-${String(10 - i).padStart(2, "0")}T12:00:00.000Z`,
        payload: {},
      })),
      error: null,
    };
    const cursor = encodeVideoListCursor(lastRow);

    const response = await GET(
      makeRequest(`http://localhost/api/videos?cursor=${encodeURIComponent(cursor)}`)
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.totalCount).toBeUndefined();
    expect(json.videos).toHaveLength(24);
    expect(json.nextCursor).toBeTruthy();
    expect(listCalls.some((call) => call[0] === "countSelect")).toBe(false);
    expect(listCalls.some((call) => call[0] === "or")).toBe(true);
  });

  it("rejects invalid cursor values", async () => {
    const response = await GET(
      makeRequest("http://localhost/api/videos?cursor=!!!")
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Invalid cursor.");
  });

  it("requires auth", async () => {
    auth.mockResolvedValue({ userId: null });
    const response = await GET(makeRequest());
    expect(response.status).toBe(401);
  });
});
