import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import CreatorWorkspace, {
  checkoutSettlementGranted,
} from "@/components/CreatorWorkspace";

vi.mock("@clerk/nextjs", () => ({
  SignInButton: ({ children }) => children,
  UserButton: () => null,
  useAuth: () => ({ userId: "user_test" }),
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

describe("checkoutSettlementGranted", () => {
  it("waits for credits to increase even when the user is already premium", () => {
    expect(
      checkoutSettlementGranted({ beforeCredits: 0, currentCredits: 0 })
    ).toBe(false);
    expect(
      checkoutSettlementGranted({ beforeCredits: 0, currentCredits: 30 })
    ).toBe(true);
  });

  it("does not treat an unloaded balance as a successful grant", () => {
    expect(
      checkoutSettlementGranted({ beforeCredits: null, currentCredits: 30 })
    ).toBe(false);
    expect(
      checkoutSettlementGranted({ beforeCredits: undefined, currentCredits: 30 })
    ).toBe(false);
  });
});

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
