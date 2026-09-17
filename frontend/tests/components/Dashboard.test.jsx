import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dashboard from "../../src/components/Dashboard.jsx";
import { fetchAdminProducts } from "../../src/api/products.js";
import { fetchAttentionOrders, fetchOrderSummary, fetchReadyToShip } from "../../src/api/orders.js";
import { fetchLowStock } from "../../src/api/inventory.js";

const websocket = vi.hoisted(() => ({ callbacks: new Map() }));

vi.mock("../../src/api/products.js", () => ({ fetchAdminProducts: vi.fn() }));
vi.mock("../../src/api/orders.js", () => ({
  fetchAttentionOrders: vi.fn(),
  fetchOrderSummary: vi.fn(),
  fetchReadyToShip: vi.fn(),
}));
vi.mock("../../src/api/inventory.js", () => ({ fetchLowStock: vi.fn() }));
vi.mock("../../src/realtime/WebSocketProvider.jsx", () => ({
  useWebSocketMessage: (type, callback) => websocket.callbacks.set(type, callback),
}));
vi.mock("../../src/components/OrdersPage.jsx", () => ({
  StatusBadge: ({ status }) => <span>{status}</span>,
}));

function dashboardTile(label) {
  return screen.getByText(label).parentElement;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Dashboard live updates", () => {
  beforeEach(() => {
    websocket.callbacks.clear();
    vi.resetAllMocks();
    fetchAdminProducts.mockResolvedValue({ items: [] });
    fetchAttentionOrders.mockResolvedValue([]);
    fetchOrderSummary.mockResolvedValue({
      total_orders: 0,
      total_revenue: "0",
      average_order_value: "0",
      by_status: {},
      by_payment_method: {},
    });
    fetchReadyToShip.mockResolvedValue([]);
    fetchLowStock.mockResolvedValue([]);
  });

  afterEach(() => vi.useRealTimers());

  it("deduplicates an order event, updates the visible count immediately and coalesces its refresh", async () => {
    render(<Dashboard idToken="test-token" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Orders today")).toBeInTheDocument());
    vi.useFakeTimers();
    vi.clearAllMocks();

    const orderResolved = websocket.callbacks.get("OrderResolved");
    const message = {
      event_id: "event-1",
      order_id: "order-1",
      status: "CONFIRMED",
      payment_method: "card",
    };
    act(() => orderResolved(message));
    act(() => orderResolved(message));

    expect(dashboardTile("Orders today")).toHaveTextContent("1");
    expect(dashboardTile("Orders resolved live")).toHaveTextContent("1");
    // One instance is the admin toast and one is the Ready-to-ship card;
    // receiving the same event twice must not create either a second toast
    // or a second card row.
    expect(screen.getAllByText("order-1")).toHaveLength(2);

    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(fetchOrderSummary).toHaveBeenCalledTimes(1);
    expect(fetchReadyToShip).toHaveBeenCalledTimes(1);
    expect(fetchLowStock).toHaveBeenCalledTimes(1);
    expect(fetchAttentionOrders).not.toHaveBeenCalled();
  });

  it("removes an order from Ready to ship immediately when delivery begins", async () => {
    fetchReadyToShip.mockResolvedValueOnce([{ order_id: "order-2", status: "CONFIRMED" }]);
    render(<Dashboard idToken="test-token" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("order-2")).toBeInTheDocument());

    act(() => websocket.callbacks.get("DeliveryStatusChanged")({
      event_id: "delivery-event-1",
      order_id: "order-2",
      delivery_status: "PROCESSING",
    }));

    expect(screen.queryByText("order-2")).not.toBeInTheDocument();
  });

  it("hides known inactive products from low-stock alerts without hiding unknown ids", async () => {
    fetchAdminProducts.mockResolvedValueOnce({
      items: [
        { id: "active-product", name: "Active lamp", active: true },
        { id: "inactive-product", name: "Retired lamp", active: false },
      ],
    });
    fetchLowStock.mockResolvedValueOnce([
      { product_id: "active-product", available_quantity: 2 },
      { product_id: "inactive-product", available_quantity: 1 },
      { product_id: "unknown-product", available_quantity: 3 },
    ]);

    render(<Dashboard idToken="test-token" onNavigate={() => {}} />);

    await waitFor(() => expect(screen.getByText("Active lamp")).toBeInTheDocument());
    expect(screen.queryByText("Retired lamp")).not.toBeInTheDocument();
    expect(screen.getByText("unknown-product")).toBeInTheDocument();
  });

  it("loads every product page before calculating catalogue counts and low-stock visibility", async () => {
    fetchAdminProducts
      .mockResolvedValueOnce({
        items: [{ id: "active-product", name: "Active lamp", active: true }],
        next_cursor: "page-2",
      })
      .mockResolvedValueOnce({
        items: [{ id: "inactive-product", name: "Retired lamp", active: false }],
        next_cursor: null,
      });
    fetchLowStock.mockResolvedValueOnce([
      { product_id: "active-product", available_quantity: 2 },
      { product_id: "inactive-product", available_quantity: 1 },
    ]);

    render(<Dashboard idToken="test-token" onNavigate={() => {}} />);

    await waitFor(() => expect(screen.getByText("Active lamp")).toBeInTheDocument());
    expect(fetchAdminProducts).toHaveBeenNthCalledWith(1, { limit: 100, cursor: undefined, idToken: "test-token" });
    expect(fetchAdminProducts).toHaveBeenNthCalledWith(2, { limit: 100, cursor: "page-2", idToken: "test-token" });
    expect(dashboardTile("Active products")).toHaveTextContent("1");
    expect(dashboardTile("Inactive products")).toHaveTextContent("1");
    expect(screen.getByText("Catalogue").closest("section")).toHaveTextContent("2 products total.");
    expect(screen.queryByText("Retired lamp")).not.toBeInTheDocument();
  });

  it("refreshes the low-stock card after a StockUpdated event", async () => {
    fetchAdminProducts.mockResolvedValueOnce({
      items: [{ id: "p1", name: "Low lamp", active: true }],
    });
    fetchLowStock.mockResolvedValueOnce([{ product_id: "p1", available_quantity: 2 }]);
    render(<Dashboard idToken="test-token" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Low lamp")).toBeInTheDocument());

    vi.useFakeTimers();
    vi.clearAllMocks();
    fetchLowStock.mockResolvedValueOnce([]);
    act(() => websocket.callbacks.get("StockUpdated")({
      event_id: "stock-event-1",
      product_id: "p1",
      available: 20,
    }));

    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(fetchLowStock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Low lamp")).not.toBeInTheDocument();
    expect(screen.getByText("Nothing at or below 10 units.")).toBeInTheDocument();
  });

  it("does not discard one section's response when another section receives a newer event", async () => {
    render(<Dashboard idToken="test-token" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Orders today")).toBeInTheDocument());

    vi.useFakeTimers();
    vi.clearAllMocks();
    const pendingAttention = deferred();
    fetchAttentionOrders.mockReturnValueOnce(pendingAttention.promise);

    act(() => websocket.callbacks.get("OrderNeedsReconciliation")({
      event_id: "attention-event-1",
      order_id: "toast-order",
      status: "STOCK_UNKNOWN",
    }));
    await act(async () => vi.advanceTimersByTimeAsync(500));

    act(() => websocket.callbacks.get("DeliveryStatusChanged")({
      event_id: "delivery-event-2",
      order_id: "delivery-order",
      delivery_status: "PROCESSING",
    }));
    await act(async () => {
      pendingAttention.resolve([{ order_id: "attention-fresh", status: "STOCK_UNKNOWN" }]);
      await Promise.resolve();
    });

    expect(screen.getByText("attention-fresh")).toBeInTheDocument();
  });
});
