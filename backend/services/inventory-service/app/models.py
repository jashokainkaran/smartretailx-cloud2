from pydantic import BaseModel


# An inventory record tracks stock in TWO states:
#   available_quantity — units free to be reserved
#   reserved_quantity  — units currently held for in-progress checkouts (not yet sold)
# Reserving moves units available -> reserved (only if enough are available).
# Releasing moves them back reserved -> available (e.g. cancelled checkout).
class InventoryItem(BaseModel):
    product_id: str
    available_quantity: int
    reserved_quantity: int = 0