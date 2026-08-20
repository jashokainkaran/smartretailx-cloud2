from decimal import Decimal, ROUND_HALF_UP
from pydantic import BaseModel, Field, field_serializer
from typing import Optional


class ProductBase(BaseModel):
    name: str
    description: str
    # Amounts are in US dollars (USD). The currency is implicit — see the
    # single-currency limitation recorded against ADR-039.
    price: Decimal = Field(..., gt=0, decimal_places=2)
    category: str
    image_url: Optional[str] = None

    @field_serializer("price")
    def _serialise_price(self, value: Decimal) -> str:
        """
        Force two decimal places on the way out.

        DynamoDB stores numbers canonically and DISCARDS trailing zeros, so
        a price written as 20.50 reads back as 20.5. The stored value is
        numerically identical — ADR-039's actual concern, float imprecision,
        is untouched — but the wire format would then vary with the data,
        which a currency API cannot allow and a customer-facing UI would
        render as "$20.5".

        quantize only ever pads: 30.89 stays 30.89, 20.5 becomes 20.50.
        ROUND_HALF_UP is unreachable here because decimal_places=2 is
        validated on input, but it is stated rather than left to Python's
        default banker's rounding, which would send 30.885 to 30.88 where a
        human expects 30.89. Money code should not inherit that default
        silently.

        Two decimal places is correct for USD (cents) and is assumed
        system-wide. It would be wrong for a zero-decimal currency such as
        JPY or a three-decimal one such as KWD — see ADR-039.
        """
        return str(value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


# What a client sends us when CREATING a product.
# It has the base fields but NOT an id — the server generates that.
class ProductCreate(ProductBase):
    pass


# What a client sends us when UPDATING a product. Every field is optional,
# so the client can send only what changed rather than resending the whole
# product (a partial update, not a full replace).
class ProductUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    price: Optional[Decimal] = Field(None, gt=0, decimal_places=2)
    category: Optional[str] = None
    image_url: Optional[str] = None


# What we STORE and SEND BACK — the base fields plus the id and active flag.
# `active` is server-controlled: clients never set it on creation.
class Product(ProductBase):
    id: str
    active: bool = True


# The shape returned by the paginated list endpoint.
class ProductPage(BaseModel):
    items: list[Product]
    next_cursor: Optional[str] = None


# Request body for the batch lookup used by the Order saga to resolve prices.
#
# max_length=100 is DynamoDB's BatchGetItem limit: 100 keys per request.
# The Order service caps a basket at 100 line items for the same underlying
# reason (its reserve transaction has a 100-operation limit), so the two
# ceilings line up rather than one silently truncating the other.
class ProductBatchRequest(BaseModel):
    product_ids: list[str] = Field(..., min_length=1, max_length=100)


# Request/response pair for the admin image-upload flow (app/images.py). The
# browser asks for a presigned URL, PUTs the file straight to S3, then sends
# the returned image_url back on the usual create/update product call — the
# upload itself never touches this service beyond generating the URL.
class ImageUploadRequest(BaseModel):
    content_type: str


class ImageUploadResponse(BaseModel):
    post_url: str
    fields: dict[str, str]
    image_url: str