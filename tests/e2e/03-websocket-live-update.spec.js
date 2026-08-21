// The two/three-tab WebSocket proof: a new order and a delivery-status
// change both reach an admin's already-open dashboard live, with no reload.
//
// Two admin browser contexts (same dedicated admin account, simulating two
// open tabs) plus one customer context placing a real order. Real network
// latency through EventBridge -> SQS -> the WebSocket push Lambda is
// realistic here, not instant, so the live-update assertions below use a
// longer timeout than Playwright's default rather than assuming synchronous
// delivery.
const { test, expect } = require("./fixtures.js");
const path = require("path");

const SCREENSHOT_DIR = path.join(__dirname, "..", "..", "evidence", "screenshots", "e2e");
const LIVE_UPDATE_TIMEOUT = 20_000;
const PRODUCT_NAME = "Ceylon Breakfast Tea";

test.describe("WebSocket live updates", () => {
  test("a new order and a delivery-status change both reach an open admin dashboard live", async ({
    adminPage: adminA,
    secondAdminPage: adminB,
    customerPage: customer,
  }) => {
    await adminA.goto("/dashboard");
    await adminB.goto("/dashboard");

    await customer.goto("/catalogue");
    const productCard = customer.locator("article", { hasText: PRODUCT_NAME });
    await productCard.getByRole("button", { name: "Add" }).click();
    await customer.goto("/cart");
    await customer.getByLabel("Recipient first name").fill("Playwright");
    await customer.getByLabel("Recipient last name").fill("WebSocket Test");
    await customer.getByLabel("Street address").fill("1 Automated Test Street");
    await customer.getByLabel("City").fill("London");
    await customer.getByLabel("Postal code").fill("SW1A1AA");
    await customer.getByLabel("Country").selectOption({ label: "United Kingdom" });
    await customer.getByLabel("Email").fill("jashok5766+smartretailx-test-customer@gmail.com");
    await customer.getByLabel("Phone number").fill("+447700900123");
    await customer.getByRole("button", { name: "Cash on delivery" }).click();
    await customer.getByRole("button", { name: "Place order" }).click();
    await expect(customer).toHaveURL(/\/orders$/);

    // Neither admin tab has been touched or reloaded since it first opened
    // the dashboard, above.
    await expect(adminA.getByText(PRODUCT_NAME)).toBeVisible({ timeout: LIVE_UPDATE_TIMEOUT });
    await expect(adminB.getByText(PRODUCT_NAME)).toBeVisible({ timeout: LIVE_UPDATE_TIMEOUT });
    await adminA.screenshot({ path: path.join(SCREENSHOT_DIR, "13-websocket-new-order-admin-a.png"), fullPage: true });
    await adminB.screenshot({ path: path.join(SCREENSHOT_DIR, "14-websocket-new-order-admin-b.png"), fullPage: true });

    // Admin A makes the change; Admin B's tab is never reloaded or navigated
    // again from this point on.
    await adminA.goto("/customers");
    await adminA.getByRole("button", { name: "jashok5766+smartretailx-test-customer@gmail.com" }).click();
    await expect(adminA.getByText(PRODUCT_NAME)).toBeVisible();
    await adminA.getByLabel("Delivery status").selectOption("PROCESSING");
    await expect(adminA.getByText(/marked processing/i)).toBeVisible();

    // Admin B's Ready-to-ship list should lose that order on its own.
    await expect(adminB.getByText(PRODUCT_NAME)).not.toBeVisible({ timeout: LIVE_UPDATE_TIMEOUT });
    await adminB.screenshot({ path: path.join(SCREENSHOT_DIR, "15-websocket-delivery-update-admin-b.png"), fullPage: true });
  });
});
