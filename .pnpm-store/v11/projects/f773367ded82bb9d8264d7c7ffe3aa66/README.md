# SmartRetailX — Frontend

React + Vite + Tailwind CSS storefront for the SmartRetailX product catalogue.

## Install

```bash
npm install
```

## Run (dev server)

```bash
npm run dev
```

By default the app calls the API at `http://localhost:8080`.

## Pointing at a different API

Set `VITE_API_BASE_URL` before starting the dev server, or in a `.env` file in this
directory:

```
VITE_API_BASE_URL=http://localhost:9000
```

## Cognito sign-in

The frontend uses Cognito's managed sign-in page with OAuth authorisation-code
flow and PKCE. The browser never contains an AWS key or a client secret.

1. Copy `.env.example` to `.env.local`.
2. Start or restart `npm run dev`.
3. Open `http://localhost:5173` and select **Sign in**.

`VITE_COGNITO_DOMAIN` and `VITE_COGNITO_CLIENT_ID` are public identifiers. Do
not put AWS access keys, passwords, or client secrets in any `VITE_*` variable:
Vite includes those values in the browser bundle.

## Build

```bash
npm run build
```
