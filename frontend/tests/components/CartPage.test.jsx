import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CartPage from "../../src/components/CartPage.jsx";
import { createOrder } from "../../src/api/orders.js";

vi.mock("../../src/api/orders.js", () => ({
  createOrder: vi.fn(),
}));

const cart = [{
  id: "p1",
  name: "Cloud Widget",
  price: "10.00",
  image_url: null,
  quantity: 2,
}];

function renderCart(onRefreshPrices = vi.fn(), profile) {
  render(
    <CartPage
      cart={cart}
      setQuantity={() => {}}
      removeItem={() => {}}
      clearCart={() => {}}
      idToken="test-id-token"
      user={{ email: "customer@example.com" }}
      profile={profile}
      onOrderCreated={() => {}}
      onSignIn={() => {}}
      onRefreshPrices={onRefreshPrices}
    />,
  );
}

function completeCashOnDeliveryForm() {
  fireEvent.click(screen.getByLabelText("Cash on delivery"));
  fireEvent.change(screen.getByLabelText("Recipient first name"), { target: { value: "Test" } });
  fireEvent.change(screen.getByLabelText("Recipient last name"), { target: { value: "Customer" } });
  fireEvent.change(screen.getByLabelText("Street address"), { target: { value: "1 Test Street" } });
  fireEvent.change(screen.getByLabelText("City"), { target: { value: "Testville" } });
  fireEvent.change(screen.getByLabelText("Postal code"), { target: { value: "T3 5TT" } });
  fireEvent.change(screen.getByLabelText("Country"), { target: { value: "United Kingdom" } });
  fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+44 7700 900000" } });
}

describe("CartPage price-change checkout protection", () => {
  beforeEach(() => createOrder.mockReset());

  it("sends the price the customer saw with each checkout line", async () => {
    createOrder.mockResolvedValue({ order_id: "order-1" });
    renderCart();
    completeCashOnDeliveryForm();

    fireEvent.click(screen.getByRole("button", { name: "Place order" }));

    await waitFor(() => expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ product_id: "p1", quantity: 2, expected_unit_price: "10.00" }],
      shippingAddress: expect.objectContaining({ recipient_name: "Test Customer" }),
    })));
  });

  it("pre-fills split recipient names from a completed Cognito profile", async () => {
    renderCart(vi.fn(), { givenName: "Asha", familyName: "Perera", email: "asha@example.com" });

    await waitFor(() => expect(screen.getByLabelText("Recipient first name")).toHaveValue("Asha"));
    expect(screen.getByLabelText("Recipient last name")).toHaveValue("Perera");
  });
});
