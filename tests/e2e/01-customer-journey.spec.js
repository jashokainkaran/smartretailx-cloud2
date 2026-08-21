// Customer journey: sign in, browse, add to basket, complete a
// cash-on-delivery checkout, see it on My Orders, open the profile page.
// Deliberately COD, not card — a real charge attempt against the mock
// payment provider isn't needed to prove the journey works, and COD is the
// simpler, safer default for a repeatable test.
const { test, expect } = require("./fixtures.js");
const path = require("path");

const SCREENSHOT_DIR = path.join(__dirname, "..", "..", "evidence", "screenshots", "e2e");
const PRODUCT_NAME = "Highland Roast Coffee Beans";

test.describe("Customer journey", () => {
  test("sign in, browse, checkout by COD, view order, open profile", async ({ customerPage: page }) => {
    await page.goto("/");

    // A test account with an incomplete Cognito profile is redirected here
    // before it can do anything else — fill it in if that happens, so the
    // rest of the journey isn't blocked by account setup, not app behaviour.
    if (page.url().includes("/complete-profile")) {
      await page.getByLabel("First name").fill("Playwright");
      await page.getByLabel("Last name").fill("Customer");
      await page.getByRole("button", { name: "Save and continue" }).click();
    }

    await page.goto("/catalogue");
    await expect(page.getByText(PRODUCT_NAME)).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01-catalogue.png"), fullPage: true });

    const productCard = page.locator("article", { hasText: PRODUCT_NAME });
    await productCard.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(`${PRODUCT_NAME} added to cart`)).toBeVisible();

    await page.goto("/cart");
    await expect(page.getByText(PRODUCT_NAME, { exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-basket.png"), fullPage: true });

    await page.getByLabel("Recipient first name").fill("Playwright");
    await page.getByLabel("Recipient last name").fill("Test Customer");
    await page.getByLabel("Street address").fill("1 Automated Test Street");
    await page.getByRole("textbox", { name: "City" }).fill("London");
    await page.getByLabel("Postal code").fill("SW1A1AA");
    await page.getByLabel("Country").selectOption({ label: "United Kingdom" });
    await page.getByLabel("Email").fill("jashok5766+smartretailx-test-customer@gmail.com");
    await page.getByLabel("Phone number").fill("+447700900123");
    await page.getByText("Cash on delivery", { exact: true }).click();

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-checkout-form-filled.png"), fullPage: true });
    await page.getByRole("button", { name: "Place order" }).click();

    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByText("Order placed!")).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04-order-confirmation.png"), fullPage: true });

    await page.goto("/profile");
    await expect(page.getByRole("heading", { name: "My Profile" })).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05-profile.png"), fullPage: true });

    await page.getByRole("button", { name: "Edit profile" }).click();
    await expect(page.getByLabel("First name")).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "06-profile-edit-open.png"), fullPage: true });
  });
});
