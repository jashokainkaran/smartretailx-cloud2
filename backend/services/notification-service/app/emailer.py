import html

import boto3

from app import config

ses = boto3.client("ses", region_name=config.AWS_REGION)


def _items_rows_html(items: list[dict]) -> str:
    rows = "".join(
        f"<tr>"
        f"<td style='padding:6px 0;'>{html.escape(item['quantity'].__str__())} x {html.escape(item['name'])}</td>"
        f"<td style='padding:6px 0;text-align:right;'>{html.escape(item['unit_price'])}</td>"
        f"</tr>"
        for item in items
    )
    return f"<table style='width:100%;border-collapse:collapse;'>{rows}</table>"


def _items_lines_text(items: list[dict]) -> str:
    return "\n".join(f"{item['quantity']} x {item['name']} @ {item['unit_price']}" for item in items)


def _wrap_html(greeting: str, body_html: str) -> str:
    """One small shared shell so every email looks consistent without a
    templating library — this is deliberately still simple HTML, matching
    the thin scope this service was designed for (ADR-006), not a full
    branded email system."""
    return f"""
    <div style="font-family: Arial, sans-serif; color: #1c1917; max-width: 480px; margin: 0 auto;">
      <h2 style="color: #b45309;">SmartRetailX</h2>
      <p>{greeting}</p>
      {body_html}
      <p style="margin-top: 24px;">Thanks for shopping with SmartRetailX!</p>
    </div>
    """


def _greeting(recipient_name: str | None) -> str:
    return f"Hi {html.escape(recipient_name)}," if recipient_name else "Hi there,"


def _receipt_email(data: dict) -> tuple[str, str, str]:
    """(subject, html_body, text_body) for an OrderConfirmed event — covers
    both the card path (CONFIRMED) and cash on delivery
    (PENDING_ON_DELIVERY), which is why the wording branches on
    data["status"] rather than assuming one."""
    items = data.get("items", [])
    greeting = _greeting(data.get("recipient_name"))

    if data.get("status") == "PENDING_ON_DELIVERY":
        payment_note_html = (
            "<p><strong>This is a cash-on-delivery order.</strong> No payment has been taken — "
            "please have the total ready to pay in cash when your order arrives at your door.</p>"
        )
        payment_note_text = (
            "This is a cash-on-delivery order. No payment has been taken — "
            "please have the total ready to pay in cash when your order arrives at your door.\n"
        )
    else:
        payment_note_html = "<p>Your payment has been confirmed.</p>"
        payment_note_text = "Your payment has been confirmed.\n"

    body_html = (
        f"<p>Your order has been confirmed.</p>"
        f"<p><strong>Order:</strong> {html.escape(data['order_id'])}</p>"
        f"{_items_rows_html(items)}"
        f"<p style='text-align:right;'><strong>Total: {html.escape(data['total'])}</strong></p>"
        f"{payment_note_html}"
    )
    html_body = _wrap_html(greeting, body_html)

    text_body = (
        f"{greeting}\n\n"
        "Your order has been confirmed.\n\n"
        f"Order: {data['order_id']}\n\n"
        f"{_items_lines_text(items)}\n\n"
        f"Total: {data['total']}\n\n"
        f"{payment_note_text}\n"
        "Thanks for shopping with SmartRetailX!\n"
    )

    return "Your SmartRetailX order is confirmed", html_body, text_body


def _failure_email(data: dict) -> tuple[str, str, str]:
    """(subject, html_body, text_body) for an OrderFailed event. FAILED
    (payment declined, then compensated) and REJECTED (never charged at
    all — insufficient stock) share the same base message; only FAILED
    mentions a refund, since REJECTED never took a payment to refund."""
    greeting = _greeting(data.get("recipient_name"))
    reason = data.get("reason", "Unknown")

    if data.get("status") == "FAILED":
        refund_note_html = "<p>If you were charged, that payment has already been refunded.</p>"
        refund_note_text = "If you were charged, that payment has already been refunded.\n"
    else:
        refund_note_html = ""
        refund_note_text = ""

    body_html = (
        "<p>We're sorry — your order could not be completed.</p>"
        f"<p><strong>Order:</strong> {html.escape(data['order_id'])}</p>"
        f"<p><strong>Reason:</strong> {html.escape(reason)}</p>"
        f"{refund_note_html}"
    )
    html_body = _wrap_html(greeting, body_html)

    text_body = (
        f"{greeting}\n\n"
        "We're sorry — your order could not be completed.\n\n"
        f"Order: {data['order_id']}\n"
        f"Reason: {reason}\n\n"
        f"{refund_note_text}\n"
        "Thanks for shopping with SmartRetailX!\n"
    )

    return "Your SmartRetailX order could not be completed", html_body, text_body


_DELIVERY_STATUS_MESSAGES = {
    "PROCESSING": "is being processed",
    "SHIPPED": "has shipped",
    "OUT_FOR_DELIVERY": "is out for delivery",
    "DELIVERED": "has been delivered",
}


def _delivery_status_email(data: dict) -> tuple[str, str, str]:
    """(subject, html_body, text_body) for a DeliveryStatusChanged event.
    Deliberately thin compared to the receipt/failure emails above — this
    is a status ping, not something carrying items or a total; the
    customer's own order history is the source of truth for the rest."""
    greeting = _greeting(data.get("recipient_name"))
    status = data["delivery_status"]
    status_message = _DELIVERY_STATUS_MESSAGES.get(status, f"is now {status}")

    body_html = (
        f"<p>Your order {status_message}.</p>"
        f"<p><strong>Order:</strong> {html.escape(data['order_id'])}</p>"
    )
    html_body = _wrap_html(greeting, body_html)

    text_body = (
        f"{greeting}\n\n"
        f"Your order {status_message}.\n\n"
        f"Order: {data['order_id']}\n\n"
        "Thanks for shopping with SmartRetailX!\n"
    )

    return f"Your SmartRetailX order {status_message}", html_body, text_body


def send_receipt(event_type: str, data: dict) -> None:
    """The only place this service calls SES. Raises on any failure —
    deliberately not swallowed, so a real send failure propagates back to
    the SQS-triggered handler, stays un-marked-as-sent, and is retried
    (eventually reaching the DLQ if it keeps failing) rather than being
    silently lost."""
    if event_type == "OrderConfirmed":
        subject, html_body, text_body = _receipt_email(data)
    elif event_type == "OrderFailed":
        subject, html_body, text_body = _failure_email(data)
    elif event_type == "DeliveryStatusChanged":
        subject, html_body, text_body = _delivery_status_email(data)
    else:
        raise ValueError(f"Unrecognised event_type for a receipt: {event_type}")

    ses.send_email(
        Source=config.SENDER_EMAIL,
        Destination={"ToAddresses": [data["contact_email"]]},
        Message={
            "Subject": {"Data": subject},
            "Body": {
                "Html": {"Data": html_body},
                "Text": {"Data": text_body},
            },
        },
    )
