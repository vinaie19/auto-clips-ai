import { expect, test } from "@playwright/test";

test("landing page renders the hero for signed-out visitors", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /Generate Viral Short-Form Videos in Seconds/i,
    })
  ).toBeVisible();

  await expect(
    page.getByRole("button", { name: "Start Creating Free" })
  ).toBeVisible();
});