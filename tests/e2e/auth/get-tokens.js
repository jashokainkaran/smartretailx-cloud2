// Fetches real, fresh Cognito tokens for the dedicated customer/admin test
// accounts before any test runs — the same USER_PASSWORD_AUTH flow the CD
// pipeline already uses against the same non-browser integration-test app
// client (terraform/cognito.tf's aws_cognito_user_pool_client.integration_test).
//
// Deliberately shells out to the AWS CLI rather than adding an AWS SDK
// dependency here: this environment already has it configured, and every
// other script in this project's testing story (deployed_integration_test.py,
// cd.yml) authenticates the same way.
//
// The request body is written to a temp file and passed via --cli-input-json
// file://..., not inlined as a shell argument — avoids any shell-quoting
// problem with the JSON payload on any platform.

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CLIENT_ID = process.env.SMARTRETAILX_COGNITO_TEST_CLIENT_ID || "3j9l9e55inbvlep2e6ikpril0k";
const AUTH_DIR = path.join(__dirname, "..", ".auth");

function authenticate(username, password) {
  const requestFile = path.join(os.tmpdir(), `smartretailx-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(
    requestFile,
    JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }),
  );

  try {
    const raw = execFileSync(
      "aws",
      ["cognito-idp", "initiate-auth", "--cli-input-json", `file://${requestFile}`, "--output", "json"],
      { encoding: "utf-8" },
    );
    const response = JSON.parse(raw);
    const idToken = response.AuthenticationResult && response.AuthenticationResult.IdToken;
    const accessToken = response.AuthenticationResult && response.AuthenticationResult.AccessToken;
    if (!idToken || !accessToken) {
      throw new Error(`Cognito did not return both tokens for ${username}.`);
    }
    return { id_token: idToken, access_token: accessToken };
  } finally {
    fs.rmSync(requestFile, { force: true });
  }
}

module.exports = async function globalSetup() {
  const customerEmail = process.env.SMARTRETAILX_TEST_CUSTOMER_EMAIL;
  const customerPassword = process.env.SMARTRETAILX_TEST_CUSTOMER_PASSWORD;
  const adminEmail = process.env.SMARTRETAILX_TEST_ADMIN_EMAIL;
  const adminPassword = process.env.SMARTRETAILX_TEST_ADMIN_PASSWORD;

  const missing = ["SMARTRETAILX_TEST_CUSTOMER_EMAIL", "SMARTRETAILX_TEST_CUSTOMER_PASSWORD", "SMARTRETAILX_TEST_ADMIN_EMAIL", "SMARTRETAILX_TEST_ADMIN_PASSWORD"].filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Set these environment variables before running the E2E suite: ${missing.join(", ")}`);
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(path.join(AUTH_DIR, "customer.json"), JSON.stringify(authenticate(customerEmail, customerPassword)));
  fs.writeFileSync(path.join(AUTH_DIR, "admin.json"), JSON.stringify(authenticate(adminEmail, adminPassword)));
};
