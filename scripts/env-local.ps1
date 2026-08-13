$env:PRODUCTS_TABLE = "Products"
$env:OUTBOX_TABLE = "ProductOutbox"
$env:INVENTORY_TABLE = "Inventory"
$env:DYNAMODB_ENDPOINT = "http://localhost:8000"
$env:AWS_REGION = "eu-west-1"
Write-Host "Pointed at DynamoDB Local" -ForegroundColor Yellow