import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminPanel from "../../src/components/AdminPanel.jsx";
import { createProduct, fetchAdminProducts, setProductActive } from "../../src/api/products.js";
import { addStock, fetchStock, fetchStockBatch } from "../../src/api/inventory.js";

vi.mock("../../src/api/products.js", () => ({
  createProduct: vi.fn(),
  fetchAdminProducts: vi.fn(),
  setProductActive: vi.fn(),
  updateProduct: vi.fn(),
  uploadProductImage: vi.fn(),
}));
vi.mock("../../src/api/inventory.js", () => ({
  addStock: vi.fn(),
  fetchStock: vi.fn(),
  fetchStockBatch: vi.fn(),
}));
vi.mock("../../src/components/OrdersPage.jsx", () => ({
  StatusBadge: ({ status }) => <span>{status}</span>,
}));

const products = [
  {
    id: "p1",
    name: "Active lamp",
    description: "Active product",
    price: "12.00",
    category: "Home",
    image_url: "",
    active: true,
  },
  {
    id: "p2",
    name: "Archived vase",
    description: "Inactive product",
    price: "18.00",
    category: "Home",
    image_url: "",
    active: false,
  },
];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe("AdminPanel inventory loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAdminProducts.mockResolvedValue({ items: products, next_cursor: null });
    fetchStockBatch.mockResolvedValue([
      { product_id: "p1", available_quantity: 7, reserved_quantity: 0 },
      { product_id: "p2", available_quantity: 0, reserved_quantity: 0 },
    ]);
    setProductActive.mockResolvedValue({ ...products[1], active: true });
  });

  it("loads all visible stock levels with one batch request", async () => {
    render(<AdminPanel idToken="test-token" />);

    await waitFor(() => expect(screen.getByText("Active lamp")).toBeInTheDocument());
    expect(fetchStockBatch).toHaveBeenCalledTimes(1);
    expect(fetchStockBatch).toHaveBeenCalledWith(["p1", "p2"], "test-token");
    expect(fetchStock).not.toHaveBeenCalled();
    expect(screen.getByText("Active lamp").closest("tr")).toHaveTextContent("7");
    expect(screen.getByText("Archived vase").closest("tr")).toHaveTextContent("0");
  });

  it("updates activation locally without reloading products or stock", async () => {
    const user = userEvent.setup();
    render(<AdminPanel idToken="test-token" />);
    await waitFor(() => expect(screen.getByText("Archived vase")).toBeInTheDocument());

    const row = screen.getByText("Archived vase").closest("tr");
    await user.click(within(row).getByRole("button", { name: "Activate" }));

    await waitFor(() => expect(setProductActive).toHaveBeenCalledWith("p2", true, "test-token"));
    expect(screen.getByText("Archived vase").closest("tr")).toHaveTextContent("ACTIVE");
    expect(fetchAdminProducts).toHaveBeenCalledTimes(1);
    expect(fetchStockBatch).toHaveBeenCalledTimes(1);
  });

  it("prevents a product form from being submitted twice while saving", async () => {
    const user = userEvent.setup();
    const pendingCreate = deferred();
    createProduct.mockReturnValueOnce(pendingCreate.promise);
    render(<AdminPanel idToken="test-token" />);
    await waitFor(() => expect(screen.getByText("Active lamp")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add product" }));
    await user.type(screen.getByLabelText("Name"), "New mug");
    await user.type(screen.getByLabelText("Category"), "Home");
    await user.type(screen.getByLabelText("Price"), "9.99");
    await user.type(screen.getByLabelText("Description"), "A new ceramic mug");

    const submit = screen.getByRole("button", { name: "Create product" });
    await user.click(submit);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Saving…" }));
    expect(createProduct).toHaveBeenCalledTimes(1);

    pendingCreate.resolve({ id: "new-product" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Saving…" })).not.toBeInTheDocument());
  });

  it("prevents stock from being added twice while a restock is running", async () => {
    const user = userEvent.setup();
    const pendingRestock = deferred();
    fetchStock.mockResolvedValue({ product_id: "p1", available_quantity: 7, reserved_quantity: 0 });
    addStock.mockReturnValueOnce(pendingRestock.promise);
    render(<AdminPanel idToken="test-token" />);
    await waitFor(() => expect(screen.getByText("Active lamp")).toBeInTheDocument());

    const row = screen.getByText("Active lamp").closest("tr");
    await user.click(within(row).getByRole("button", { name: "Stock" }));
    const addButton = await screen.findByRole("button", { name: "Add stock" });
    await user.click(addButton);
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Adding…" }));
    expect(addStock).toHaveBeenCalledTimes(1);

    pendingRestock.resolve({ product_id: "p1", available_quantity: 8, reserved_quantity: 0 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Add stock" })).toBeEnabled());
  });
});
