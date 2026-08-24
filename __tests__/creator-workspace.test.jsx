import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("renders generate nav and form by default", () => {
    render(<CreatorWorkspace />);

    expect(screen.getByRole("navigation", { name: "Workspace" })).toBeDefined();
    expect(screen.getByLabelText("Video prompt")).toBeDefined();
    expect(screen.getByText("Narrator voice")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Generate" })).toBeDefined();
    expect(screen.getByText("Subtitle style")).toBeDefined();
    expect(screen.getByText("Video tone")).toBeDefined();
    expect(screen.getByText("Length")).toBeDefined();
    expect(screen.getByText("Aspect ratio")).toBeDefined();
  });

  it("disables the generate button while the prompt is empty", () => {
    render(<CreatorWorkspace />);

    const button = screen.getByRole("button", { name: "Generate AI Video" });
    expect(button.disabled).toBe(true);
  });

  it("shows empty videos library when Videos is selected", () => {
    render(<CreatorWorkspace />);

    fireEvent.click(screen.getByRole("button", { name: /^Videos$/ }));

    expect(
      screen.getByText("Your library — open a card to play and see details.")
    ).toBeDefined();
    expect(screen.getByText("No videos yet.")).toBeDefined();
  });
});
