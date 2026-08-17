import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ProductCard from "./ProductCard.jsx";
import { fetchStock } from "../api/inventory.js";

// The real network call (api/inventory.js -> api/http.js -> fetch) is
// replaced entirely — a component test proves the COMPONENT's behaviour
// given a response, not that the real backend is reachable. That's what
// the backend's own integration tests and the manual live testing already
// cover.
vi.mock("../api/inventory.js", () => ({
  fetchStock: vi.fn(),
}));

const product = {
  id: "p1",
  name: "Cloud Widget",
  description: "A widget in the cloud.",
  price: "19.99",
  category: "Widgets",
  image_url: null,
};

describe("ProductCard", () => {
  beforeEach(() => {
    fetchStock.mockReset();
  });

  it("enables Add and shows no badge when stock is available", async () => {
    fetchStock.mockResolvedValue({ available_quantity: 5, reserved_quantity: 0 });
    render(<ProductCard product={product} onSelect={() => {}} onAddToCart={() => {}} idToken={null} />);

    await waitFor(() => expect(screen.getByText("Add")).toBeEnabled());
    expect(screen.queryByText("Out of stock")).not.toBeInTheDocument();
  });

  it("disables Add and shows the out-of-stock badge when available quantity is zero", async () => {
    fetchStock.mockResolvedValue({ available_quantity: 0, reserved_quantity: 0 });
    render(<ProductCard product={product} onSelect={() => {}} onAddToCart={() => {}} idToken={null} />);

    await waitFor(() => expect(screen.getByText("Add")).toBeDisabled());
    expect(screen.getAllByText("Out of stock").length).toBeGreaterThan(0);
  });

  it("treats a 404 (no inventory record at all) the same as zero stock", async () => {
    fetchStock.mockRejectedValue({ status: 404 });
    render(<ProductCard product={product} onSelect={() => {}} onAddToCart={() => {}} idToken={null} />);

    await waitFor(() => expect(screen.getByText("Add")).toBeDisabled());
  });

  it("does NOT mark it out of stock on a transient error (e.g. a 500)", async () => {
    fetchStock.mockRejectedValue({ status: 500 });
    render(<ProductCard product={product} onSelect={() => {}} onAddToCart={() => {}} idToken={null} />);

    // Give the rejected promise a tick to settle, then confirm nothing changed.
    await waitFor(() => expect(fetchStock).toHaveBeenCalled());
    expect(screen.getByText("Add")).toBeEnabled();
    expect(screen.queryByText("Out of stock")).not.toBeInTheDocument();
  });

  it("clicking Add calls onAddToCart and does not also open the product (stopPropagation)", async () => {
    fetchStock.mockResolvedValue({ available_quantity: 5, reserved_quantity: 0 });
    const onAddToCart = vi.fn();
    const onSelect = vi.fn();
    render(<ProductCard product={product} onSelect={onSelect} onAddToCart={onAddToCart} idToken={null} />);

    await waitFor(() => expect(screen.getByText("Add")).toBeEnabled());
    fireEvent.click(screen.getByText("Add"));

    expect(onAddToCart).toHaveBeenCalledWith(product);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking the card itself opens the product", async () => {
    fetchStock.mockResolvedValue({ available_quantity: 5, reserved_quantity: 0 });
    const onSelect = vi.fn();
    render(<ProductCard product={product} onSelect={onSelect} onAddToCart={() => {}} idToken={null} />);

    fireEvent.click(screen.getByRole("button", { name: /Cloud Widget/ }));

    expect(onSelect).toHaveBeenCalledWith("p1");
  });
});
