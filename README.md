# SmartRetailX — Cloud-Native Distributed Web Application

SmartRetailX is a cloud-native, distributed retail platform built as university coursework.
It's a microservices-based e-commerce backend built on AWS-native services, paired with a
React storefront, and is designed to be promoted through local, staging, and production
environments using the same infrastructure-as-code.

## Architecture at a glance

- **Backend:** Python + FastAPI microservices, one per domain (users, products, inventory,
  orders, payments, notifications), each with its own DynamoDB table.
- **Event-driven:** services communicate asynchronously via EventBridge and SQS rather than
  direct calls, where appropriate.
- **Identity:** authentication and authorization via AWS Cognito.
- **Deployment target:** API Gateway + Lambda, with infrastructure defined in Terraform.
- **Frontend:** React + Vite + Tailwind single-page storefront, served as static assets
  (S3 + CloudFront in the cloud).

## Repository structure

- `backend/` — the FastAPI microservices (`services/`) and the API gateway (`gateway/`).
- `frontend/` — the React + Tailwind storefront.
- `infrastructure/` — Terraform (`aws/`), Kubernetes manifests (`k8s/`), Docker assets
  (`docker/`), and architecture diagrams (`diagrams/`).
- `scripts/` — table creation, seed data, and other helper scripts.
- `tests/` — Postman collections, k6 load tests, and integration tests.
- `docs/` — architecture, API, and security documentation.
- `evidence/` — screenshots, logs, and test outputs for the report appendix.
- `report/` — the written coursework report.

## Getting started (local)

**Prerequisites:** Docker, Python 3.11+, Node.js.

1. Start DynamoDB Local (via Docker):
   ```bash
   docker run -p 8000:8000 amazon/dynamodb-local
   ```
2. Create the products table:
   ```bash
   python scripts/create_table.py
   ```
3. Seed sample data:
   ```bash
   python scripts/seed_products.py
   ```
4. Run the product-service:
   ```bash
   cd backend/services/product-service
   uvicorn app.main:app --reload --port 8080
   ```
5. Run the frontend:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

## Architectural decisions

All key architectural decisions and their rationale are recorded as ADRs in
[docs/architecture/ARCHITECTURE_DECISIONS.md](docs/architecture/ARCHITECTURE_DECISIONS.md).
