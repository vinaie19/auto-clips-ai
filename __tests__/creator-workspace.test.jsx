import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CreatorWorkspace from "@/components/CreatorWorkspace";

vi.mock("@clerk/nextjs", () => ({
  SignInButton: ({ children }) => children,
  UserButton: () => null,
}));

function mockApiResponses() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ videos: [] }),
      })
    )
  );
}

describe("CreatorWorkspace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockApiResponses();
  });

  it("renders the video prompt form", () => {
    render(<CreatorWorkspace />);

    expect(screen.getByLabelText("Video prompt")).toBeDefined();
    expect(screen.getByText("Subtitle style theme")).toBeDefined();
    expect(screen.getByText("Video tone")).toBeDefined();
  });

  it("disables the generate button while the prompt is empty", () => {
    render(<CreatorWorkspace />);

    const button = screen.getByRole("button", { name: "Generate AI Video" });
    expect(button).toBeDefined();
    expect(button.disabled).toBe(true);
  });

  it("shows an empty history state", () => {
    render(<CreatorWorkspace />);

    expect(screen.getByText("History log")).toBeDefined();
    expect(
      screen.getByText("No renders yet — generate your first clip above.")
    ).toBeDefined();
  });
});