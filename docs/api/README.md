# API docs

This is the OpenAPI documentation for the four HTTP services in the system:
product, inventory, payment and order. Each spec is just the FastAPI app's own
schema, dumped to JSON, so it's always exactly what that service actually
implements.

Two services are missing on purpose. `notification-service` and
`outbox-relay` only react to SQS/DynamoDB Stream events, they don't expose an
HTTP API, so there's nothing to document here. `websocket-service` is a
WebSocket API, which OpenAPI just isn't built to describe.

## Viewing the docs

Open `index.html` through a local server, not by double-clicking the file.
Browsers block a page opened via `file://` from fetching the JSON next to it,
so you'll just get a blank page if you try that.

```
cd docs/api
python -m http.server 8000
```

Then go to `http://localhost:8000` in a browser. There's a dropdown at the top
to switch between the four services.

## Keeping it up to date

The specs are generated, not hand-written, so if you change a route or a
Pydantic model, the JSON file will drift out of date until you regenerate it.
For product-service that looks like:

```
python -c "
import json, sys
sys.path.insert(0, 'backend/services/product-service')
from app.main import app
print(json.dumps(app.openapi(), indent=2))
" > docs/api/product-service.openapi.json
```

Same idea for the other three, just swap the service folder and the output
filename.
