import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Modal from "../../src/components/Modal.jsx";

function ModalContents() {
  return (
    <div>
      <button>First action</button>
      <button>Last action</button>
    </div>
  );
}

describe("Modal keyboard focus", () => {
  it("keeps Shift+Tab inside the modal from its initial panel focus", () => {
    render(<Modal title="Test dialog" onClose={() => {}}><ModalContents /></Modal>);

    expect(screen.getByRole("dialog")).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();
  });

  it("uses the latest close callback without resetting focus on rerender", () => {
    const firstClose = vi.fn();
    const latestClose = vi.fn();
    const { rerender } = render(
      <Modal title="Test dialog" onClose={firstClose}><ModalContents /></Modal>
    );
    const firstAction = screen.getByRole("button", { name: "First action" });
    firstAction.focus();

    rerender(<Modal title="Test dialog" onClose={latestClose}><ModalContents /></Modal>);
    expect(firstAction).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledTimes(1);
  });
});
