$env:PRODUCTS_TABLE = "smartretailx-dev-products"
$env:OUTBOX_TABLE = "smartretailx-dev-product-outbox"
$env:INVENTORY_TABLE = "smartretailx-dev-inventory"
$env:EVENT_BUS_NAME = "smartretailx-dev-events"
$env:AWS_REGION = "eu-west-1"
Remove-Item Env:DYNAMODB_ENDPOINT -ErrorAction SilentlyContinue
Write-Host "Pointed at AWS dev environment (eu-west-1)" -ForegroundColor Green