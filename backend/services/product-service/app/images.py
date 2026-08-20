"""Presigned S3 uploads for admin-supplied product images.

The upload itself is browser -> S3 directly, never through this service —
presigning is a local cryptographic operation boto3 performs with no network
call. S3 enforces the real constraints (identity, content type, size) when
the browser's request actually lands, using this role's real permissions
(terraform/lambda_http_services.tf) and the conditions signed into the URL
below.
"""
import logging
import uuid
import boto3
from botocore.exceptions import BotoCoreError, ClientError
from app import config

logger = logging.getLogger(__name__)

# SVG is deliberately excluded: it can embed a <script>, a real stored-XSS
# vector for anything CloudFront serves back as-is.
_CONTENT_TYPE_EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}

# A presigned PUT has no way to cap size up front — S3's only enforcement
# for that, a content-length-range condition, is a presigned-POST-only
# feature. That's the whole reason this uses generate_presigned_post rather
# than the simpler generate_presigned_url("put_object", ...): without it,
# the 5MB limit would exist only in the browser and be trivial to bypass by
# calling this endpoint directly.
MAX_UPLOAD_BYTES = 5 * 1024 * 1024

_s3_client = boto3.client("s3", region_name=config.AWS_REGION)


def allowed_content_type(content_type: str) -> bool:
    return content_type in _CONTENT_TYPE_EXTENSIONS


def presign_upload(content_type: str) -> dict:
    """
    Return a presigned POST (url + form fields) and the public URL the
    object will be reachable at once uploaded.

    The key is generated server-side, never client-supplied — a client
    choosing its own key/path is exactly how object-storage uploads become a
    path-traversal or overwrite-someone-else's-file bug. The
    "product-images/products/" prefix matches the CloudFront path pattern in
    terraform/hosting.tf exactly, so no origin-path rewriting is needed: the
    URL path IS the S3 key.

    Content-Type is both a default field and a signed condition: S3 will
    only accept the POST if the browser's form carries that exact
    Content-Type, so the upload can't silently become a different file type
    than what was validated and presigned for.
    """
    extension = _CONTENT_TYPE_EXTENSIONS[content_type]
    key = f"product-images/products/{uuid.uuid4()}.{extension}"

    presigned = _s3_client.generate_presigned_post(
        Bucket=config.PRODUCT_IMAGES_BUCKET,
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[
            {"Content-Type": content_type},
            ["content-length-range", 1, MAX_UPLOAD_BYTES],
        ],
        ExpiresIn=300,
    )

    return {
        "post_url": presigned["url"],
        "fields": presigned["fields"],
        "image_url": f"{config.PRODUCT_IMAGES_BASE_URL}/{key}",
    }


def delete_image(image_url: str | None) -> None:
    """
    Best-effort delete of a replaced product image, called when an update
    changes image_url away from a value this feature generated.

    A URL that doesn't match our own base URL + key prefix — e.g. one set
    through the old manual-paste field, before uploads existed, or None — is
    left alone: there is nothing of ours to clean up, and this must never
    attempt to delete an arbitrary externally-hosted URL a client supplied.
    """
    prefix = f"{config.PRODUCT_IMAGES_BASE_URL}/product-images/products/"
    if not image_url or not image_url.startswith(prefix):
        return

    key = image_url[len(config.PRODUCT_IMAGES_BASE_URL) + 1:]
    try:
        _s3_client.delete_object(Bucket=config.PRODUCT_IMAGES_BUCKET, Key=key)
    except (BotoCoreError, ClientError):
        # Best-effort cleanup, not a correctness requirement — the product
        # update itself already succeeded. An orphaned object costs cents;
        # failing an otherwise-successful edit over it would not be a fair
        # trade.
        logger.warning("product_image_delete_failed image_url=%s", image_url)
