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

describe("Dashboard live updates", () => {
  beforeEach(() => {
    websocket.callbacks.clear();
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
});
