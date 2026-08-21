// Admin journey: sign in, edit a product, adjust its stock, view the
// customer/order list, change a delivery status.
//
// Depends on 01-customer-journey having already placed the COD order this
// test updates the delivery status of — Playwright's default alphabetical
// file order (with fullyParallel/workers set to 1 in the config) is what
// guarantees 01 runs before 02, not anything explicit in this file.
const { test, expect } = require("./fixtures.js");
const path = require("path");

const SCREENSHOT_DIR = path.join(__dirname, "..", "..", "evidence", "screenshots", "e2e");
const PRODUCT_NAME = "Highland Roast Coffee Beans";

test.describe("Admin journey", () => {
  test("sign in, edit product, adjust stock, update a delivery status", async ({ adminPage: page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "07-admin-dashboard.png"), fullPage: true });

    await page.goto("/admin");
    const productRow = page.locator("tr", { hasText: PRODUCT_NAME });
    await expect(productRow).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "08-admin-products.png"), fullPage: true });

    await productRow.getByRole("button", { name: "Edit" }).click();
    const modal = page.getByRole("dialog");
    await expect(modal.getByRole("heading", { name: `Edit ${PRODUCT_NAME}` })).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "09-admin-edit-product.png"), fullPage: true });
    await modal.getByRole("button", { name: "Save product" }).click();
    await expect(page.getByText("Product saved.")).toBeVisible();

    await productRow.getByRole("button", { name: "Stock" }).click();
    await page.getByLabel("Units to add").fill("5");
    await page.getByRole("button", { name: "Add stock" }).click();
    await expect(page.getByText(`Added 5 units to ${PRODUCT_NAME}.`)).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "10-admin-stock-updated.png"), fullPage: true });

    await page.goto("/customers");
    await expect(page.getByRole("heading", { name: "Customers & orders" })).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "11-admin-customers-orders.png"), fullPage: true });

    // Substring match on the group's own toggle button — its accessible name
    // is built from the customer's email, phone and order count.
    await page.getByRole("button", { name: "jashok5766+smartretailx-test-customer@gmail.com" }).click();

    // The dedicated test customer has exactly this one order once the group
    // is expanded, so the delivery-status control on the page is unambiguous
    // without needing to match the order itself — CustomerGroup/OrderRow
    // never displays the recipient name, only order id/items/total/status.
    await expect(page.getByText(PRODUCT_NAME)).toBeVisible();
    await page.getByLabel("Delivery status").selectOption("PROCESSING");
    await expect(page.getByText(/marked processing/i)).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "12-admin-delivery-status-updated.png"), fullPage: true });
  });
});
