import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/feedback/route";

const insertSingle = vi.fn();
const insertSelect = vi.fn(() => ({ single: insertSingle }));
const insert = vi.fn(() => ({ select: insertSelect }));
const from = vi.fn(() => ({ insert }));

vi.mock("@/lib/supabase-admin", () => ({
  getSupabaseAdmin: () => ({ from }),
}));

function makeRequest(body) {
  return new Request("http://localhost/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertSingle.mockResolvedValue({ data: { id: "fb-1" }, error: null });
  });

  it("stores a valid submission", async () => {
    const response = await POST(
      makeRequest({
        email: "  creator@example.com ",
        phone: " +1 555 123 4567 ",
        message: " Love the captions ",
      })
    );
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json).toEqual({ ok: true, id: "fb-1" });
    expect(from).toHaveBeenCalledWith("feedback");
    expect(insert).toHaveBeenCalledWith({
      email: "creator@example.com",
      phone: "+1 555 123 4567",
      message: "Love the captions",
    });
  });

  it("rejects invalid email", async () => {
    const response = await POST(
      makeRequest({
        email: "not-an-email",
        phone: "+15551234567",
        message: "Hello",
      })
    );

    expect(response.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });
});
