import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LandingPage from "@/components/LandingPage";

vi.mock("@clerk/nextjs", () => ({
  SignInButton: ({ children }) => children,
}));

describe("LandingPage", () => {
  it("renders the hero heading", () => {
    render(<LandingPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: /Generate Viral Short-Form Videos in Seconds/i,
      })
    ).toBeDefined();
  });

  it("lists all three feature cards", () => {
    render(<LandingPage />);

    expect(screen.getByText("1080p Cloud Rendering")).toBeDefined();
    expect(screen.getByText("AI Kinetic Captions")).toBeDefined();
    expect(screen.getByText("Dynamic Pexels Integration")).toBeDefined();
  });

  it("offers sign-in entry points", () => {
    render(<LandingPage />);

    expect(
      screen.getByRole("button", { name: "Start Creating Free" })
    ).toBeDefined();
  });
});