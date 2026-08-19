// Self-service account operations. These calls go directly from the signed-in
// browser to Cognito with the user's *access* token. They never pass a
// password or MFA secret through SmartRetailX's API Gateway, Lambda services,
// logs, or DynamoDB tables.

const domain = import.meta.env.VITE_COGNITO_DOMAIN;
const configuredRegion = import.meta.env.VITE_COGNITO_REGION;

function regionFromDomain() {
  // A Cognito-managed domain is <prefix>.auth.<region>.amazoncognito.com.
  // Keeping the region derivation here avoids a second required frontend
  // setting while still allowing an explicit override for a custom domain.
  const match = domain?.match(/\.auth\.([a-z0-9-]+)\.amazoncognito\.com$/);
  return configuredRegion || match?.[1] || null;
}

function endpoint() {
  const region = regionFromDomain();
  if (!region) throw new Error("Cognito region is not configured.");
  return `https://cognito-idp.${region}.amazonaws.com/`;
}

function messageFrom(payload, fallback) {
  return payload?.message || payload?.Message || payload?.__type || fallback;
}

async function invoke(action, body) {
  let response;
  try {
    response = await fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach Cognito. Please check your connection and try again.");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(messageFrom(payload, `Cognito request failed (${response.status}).`));
  return payload || {};
}

function attributesToProfile(attributes = [], preferredMfa = null, mfaSettings = []) {
  const values = Object.fromEntries(attributes.map(({ Name, Value }) => [Name, Value]));
  return {
    sub: values.sub || "",
    email: values.email || "",
    givenName: values.given_name || "",
    familyName: values.family_name || "",
    emailVerified: values.email_verified === "true",
    preferredMfa,
    mfaSettings,
  };
}

export async function fetchCognitoProfile(accessToken) {
  const result = await invoke("GetUser", { AccessToken: accessToken });
  return attributesToProfile(
    result.UserAttributes,
    result.PreferredMfaSetting,
    result.UserMFASettingList || [],
  );
}

export async function updateCognitoAttributes(accessToken, attributes) {
  return invoke("UpdateUserAttributes", {
    AccessToken: accessToken,
    UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value: Value.trim() })),
  });
}

export function verifyCognitoEmail(accessToken, code) {
  return invoke("VerifyUserAttribute", {
    AccessToken: accessToken,
    AttributeName: "email",
    Code: code.trim(),
  });
}

export function changeCognitoPassword(accessToken, previousPassword, proposedPassword) {
  return invoke("ChangePassword", {
    AccessToken: accessToken,
    PreviousPassword: previousPassword,
    ProposedPassword: proposedPassword,
  });
}

export function beginTotpSetup(accessToken) {
  return invoke("AssociateSoftwareToken", { AccessToken: accessToken });
}

export function verifyTotpSetup(accessToken, userCode) {
  return invoke("VerifySoftwareToken", {
    AccessToken: accessToken,
    UserCode: userCode.trim(),
    FriendlyDeviceName: "SmartRetailX authenticator",
  });
}

export function setTotpPreference(accessToken, enabled) {
  return invoke("SetUserMFAPreference", {
    AccessToken: accessToken,
    SoftwareTokenMfaSettings: {
      Enabled: enabled,
      PreferredMfa: enabled,
    },
  });
}

export function deleteCognitoAccount(accessToken) {
  return invoke("DeleteUser", { AccessToken: accessToken });
}
