from pydantic import BaseModel, Field, field_validator


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


class StockBatchRequest(BaseModel):
    """Product ids whose current stock levels should be returned together."""

    product_ids: list[str] = Field(..., min_length=1, max_length=100)

    @field_validator("product_ids")
    @classmethod
    def product_ids_must_not_be_blank(cls, product_ids: list[str]) -> list[str]:
        if any(not product_id.strip() for product_id in product_ids):
            raise ValueError("Product ids must not be blank")
        return product_ids
