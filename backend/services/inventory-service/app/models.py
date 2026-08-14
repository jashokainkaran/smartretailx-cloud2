from pydantic import BaseModel, Field


# An inventory record tracks stock in TWO states:
#   available_quantity — units free to be reserved
#   reserved_quantity  — units currently held for in-progress checkouts (not yet sold)
# Reserving moves units available -> reserved (only if enough are available).
# Releasing moves them back reserved -> available (e.g. cancelled checkout).
class InventoryItem(BaseModel):
    product_id: str
    available_quantity: int
    reserved_quantity: int = 0

class StockOperation(BaseModel):
    """One line of a batch reserve / release / confirm."""
    product_id: str
    quantity: int = Field(..., gt=0)