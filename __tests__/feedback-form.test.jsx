import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import FeedbackForm from "@/components/FeedbackForm";

describe("FeedbackForm", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("opens a modal from the floating button and submits", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, id: "fb-1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<FeedbackForm />);

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Feedback$/i }));
    expect(screen.getByRole("dialog")).toBeDefined();

    fireEvent.change(screen.getByLabelText(/^Email$/i), {
      target: { value: "creator@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/^Phone$/i), {
      target: { value: "+15551234567" },
    });
    fireEvent.change(screen.getByLabelText(/^Message$/i), {
      target: { value: "Captions look great on dark B-roll." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send feedback/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/feedback",
        expect.objectContaining({
          method: "POST",
        })
      );
    });

    expect(
      await screen.findByRole("heading", { name: /We got your message/i })
    ).toBeDefined();
  });

  it("shows an error when the API rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "A valid email is required." }),
      })
    );

    render(<FeedbackForm />);
    fireEvent.click(screen.getByRole("button", { name: /^Feedback$/i }));

    fireEvent.change(screen.getByLabelText(/^Email$/i), {
      target: { value: "bad" },
    });
    fireEvent.change(screen.getByLabelText(/^Phone$/i), {
      target: { value: "+15551234567" },
    });
    fireEvent.change(screen.getByLabelText(/^Message$/i), {
      target: { value: "Hello there" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send feedback/i }));

    expect(await screen.findByRole("alert")).toMatchObject({
      textContent: expect.stringMatching(/valid email/i),
    });
  });
});
