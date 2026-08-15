<#
    Build, push and deploy every service image.

    This exists because ECR image tags are MUTABLE (ADR-027). Terraform sees
    the Lambda's image_uri as "<repo>:latest" both before and after a push,
    so nothing in the configuration changes and `terraform apply` reports no
    drift. The new image must therefore be pushed to Lambda explicitly with
    update-function-code. Doing that by hand for five images is where
    mistakes live, so it is scripted.

    Usage, from the repo root:
        .\scripts\deploy-images.ps1                 # everything
        .\scripts\deploy-images.ps1 -Only order     # one service

    First deployment is a three-step sequence, because a Lambda cannot be
    created against an image that does not exist yet:

        1. terraform apply -var-file=dev.tfvars `
             -target=aws_ecr_repository.product_service `
             -target=aws_ecr_repository.inventory_service `
             -target=aws_ecr_repository.payment_service `
             -target=aws_ecr_repository.order_service `
             -target=aws_ecr_repository.outbox_relay
        2. .\scripts\deploy-images.ps1
        3. terraform apply -var-file=dev.tfvars

    After that, a code change is just step 2.
#>

param(
    [string]$Only = "",
    [string]$Region = "eu-west-1",
    [string]$Prefix = "smartretailx-dev"
)

$ErrorActionPreference = "Stop"

# service name -> path to its Dockerfile directory.
# The Lambda function name is "<prefix>-<service>-api" for the four HTTP
# services; the two event-driven Lambdas are named separately below.
$services = [ordered]@{
    "product-service"   = "backend\services\product-service"
    "inventory-service" = "backend\services\inventory-service"
    "payment-service"   = "backend\services\payment-service"
    "order-service"     = "backend\services\order-service"
    "outbox-relay"      = "backend\services\outbox-relay"
}

# Which deployed functions run each image. One image can back more than one
# function: the inventory image serves both the HTTP API and the SQS
# consumer, and the relay image serves both outboxes (ADR-024).
$functions = @{
    "product-service"   = @("$Prefix-product-api")
    "inventory-service" = @("$Prefix-inventory-api", "$Prefix-inventory-consumer")
    "payment-service"   = @("$Prefix-payment-api")
    "order-service"     = @("$Prefix-order-api")
    "outbox-relay"      = @("$Prefix-outbox-relay", "$Prefix-order-outbox-relay")
}

$accountId = (aws sts get-caller-identity --query Account --output text).Trim()
$registry = "$accountId.dkr.ecr.$Region.amazonaws.com"

# Which functions already exist, fetched ONCE.
#
# The obvious alternative — calling `aws lambda get-function` per function
# and checking the exit code — does not survive $ErrorActionPreference =
# "Stop": PowerShell promotes anything a native command writes to stderr
# into a terminating error, and get-function writes to stderr when the
# function is absent. That is the EXPECTED case on a first deployment, so
# the script would abort on its own success path. Listing once sidesteps
# it, and is one API call instead of seven.
$existingFunctions = @()
$listed = aws lambda list-functions --region $Region --query "Functions[].FunctionName" --output text
if ($LASTEXITCODE -eq 0 -and $listed) {
    $existingFunctions = $listed -split "\s+" | Where-Object { $_ }
}

Write-Host "Registry: $registry" -ForegroundColor Cyan

# One login for the whole registry, not one per repository.
#
# NOT the documented `aws ecr get-login-password | docker login
# --password-stdin` form. Windows PowerShell 5.1 encodes pipeline text as
# UTF-16LE, so docker reads a token full of null bytes off stdin, builds a
# malformed Authorization header, and ECR rejects it with a bare 400 Bad
# Request that says nothing about encoding. Capturing the token into a
# variable and passing it as an argument avoids the pipeline entirely and
# behaves identically on PowerShell 5.1 and 7.
#
# The trade-off: docker warns that a password on the command line is
# insecure, and it is — the token is briefly visible in the process list.
# It is a 12-hour registry token on a single-developer machine, not a
# long-lived credential, so the exposure is bounded and accepted.
$token = aws ecr get-login-password --region $Region
if ($LASTEXITCODE -ne 0) { throw "could not obtain an ECR token - check AWS credentials" }

docker login --username AWS --password $token $registry
if ($LASTEXITCODE -ne 0) { throw "ECR login failed" }

foreach ($name in $services.Keys) {
    if ($Only -and $name -notlike "*$Only*") { continue }

    $path = $services[$name]
    $repo = "$Prefix-$name"
    $uri = "$registry/${repo}:latest"

    Write-Host "`n=== $name ===" -ForegroundColor Yellow

    # --provenance=false is REQUIRED. BuildKit's default output is an OCI
    # manifest with attestation layers attached, which Lambda rejects with
    # "The image manifest, config or layer media type for the source image
    # is not supported". Lambda needs Docker v2 schema 2.
    #
    # --platform linux/amd64 is stated rather than inherited. The Lambda
    # functions are x86_64 (the default architecture), and an image built
    # for a different architecture is accepted by ECR and then fails at
    # invocation with Runtime.InvalidEntrypoint — a failure that surfaces
    # far from its cause. On an x86 machine this flag changes nothing; it
    # exists so the build does not silently depend on which machine ran it.
    docker build --provenance=false --platform linux/amd64 -t $repo $path
    if ($LASTEXITCODE -ne 0) { throw "build failed: $name" }

    docker tag "${repo}:latest" $uri
    docker push $uri
    if ($LASTEXITCODE -ne 0) { throw "push failed: $name" }

    foreach ($fn in $functions[$name]) {
        # The function may not exist yet on a first deployment — that is
        # expected, and Terraform creates it in the step that follows,
        # pointing at the image just pushed.
        if ($existingFunctions -notcontains $fn) {
            Write-Host "  $fn does not exist yet - skipping (terraform apply will create it)" -ForegroundColor DarkGray
            continue
        }

        Write-Host "  updating $fn" -ForegroundColor Green
        aws lambda update-function-code `
            --function-name $fn `
            --image-uri $uri `
            --region $Region `
            --no-cli-pager | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "update-function-code failed: $fn" }
    }
}

Write-Host "`nDone." -ForegroundColor Cyan
