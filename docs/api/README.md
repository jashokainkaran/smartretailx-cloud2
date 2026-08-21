# API docs

OpenAPI 3.1 specs for the four HTTP services: product, inventory, payment, order.
Generated from each FastAPI app's own schema.

`notification-service` and `outbox-relay` are event-triggered, not HTTP APIs, so
they don't get a spec. `websocket-service` doesn't fit OpenAPI either.

## Viewing

`index.html` is a Swagger UI page with a dropdown for the four specs. Needs to be
served, not opened directly (browsers block a `file://` page from fetching the
JSON next to it):

```
cd docs/api
python -m http.server 8000
```

Open `http://localhost:8000`.

## Regenerating

```
python -c "
import json, sys
sys.path.insert(0, 'backend/services/product-service')
from app.main import app
print(json.dumps(app.openapi(), indent=2))
" > docs/api/product-service.openapi.json
```

Swap the service dir/filename for the other three. Do this after any route or
model change so the spec doesn't drift from the code.
