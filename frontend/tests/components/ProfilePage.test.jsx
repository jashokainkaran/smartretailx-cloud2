import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CompleteProfilePage from "../../src/components/CompleteProfilePage.jsx";
import ProfilePage from "../../src/components/ProfilePage.jsx";
import {
  beginTotpSetup,
  fetchCognitoProfile,
  setTotpPreference,
  updateCognitoAttributes,
  verifyTotpSetup,
} from "../../src/auth/cognitoUser.js";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,test") } }));
vi.mock("../../src/auth/cognitoUser.js", () => ({
  beginTotpSetup: vi.fn(),
  changeCognitoPassword: vi.fn(),
  deleteCognitoAccount: vi.fn(),
  fetchCognitoProfile: vi.fn(),
  setTotpPreference: vi.fn(),
  updateCognitoAttributes: vi.fn(),
  verifyCognitoEmail: vi.fn(),
  verifyTotpSetup: vi.fn(),
}));

const profile = {
  sub: "user-1",
  email: "customer@example.com",
  givenName: "Asha",
  familyName: "Perera",
  emailVerified: true,
  preferredMfa: null,
  mfaSettings: [],
};

describe("Cognito profile screens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchCognitoProfile.mockResolvedValue(profile);
  });

  it("requires first and last name before a new account can continue", async () => {
    const onCompleted = vi.fn();
    render(<CompleteProfilePage accessToken="access-token" profile={{ ...profile, givenName: "", familyName: "" }} onCompleted={onCompleted} />);

    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter both your first name and last name");

    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Asha" } });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Perera" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    await waitFor(() => expect(updateCognitoAttributes).toHaveBeenCalledWith("access-token", {
      given_name: "Asha",
      family_name: "Perera",
    }));
    expect(onCompleted).toHaveBeenCalledWith(profile);
  });

  it("keeps profile details read-only until Edit profile is selected", async () => {
    const onProfileUpdated = vi.fn();
    render(<ProfilePage accessToken="access-token" profile={profile} onProfileUpdated={onProfileUpdated} onSignOut={() => {}} />);

    expect(screen.getByText("Asha")).toBeInTheDocument();
    expect(screen.queryByLabelText("First name")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ashani" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateCognitoAttributes).toHaveBeenCalledWith("access-token", { given_name: "Ashani" }));
    await waitFor(() => expect(onProfileUpdated).toHaveBeenCalledWith(profile));
  });

  it("sets up TOTP only after the six-digit authenticator code is verified", async () => {
    beginTotpSetup.mockResolvedValue({ SecretCode: "ABCDEF123456" });
    const mfaProfile = { ...profile, mfaSettings: ["SOFTWARE_TOKEN_MFA"], preferredMfa: "SOFTWARE_TOKEN_MFA" };
    fetchCognitoProfile.mockResolvedValue(mfaProfile);
    render(<ProfilePage accessToken="access-token" profile={profile} onProfileUpdated={() => {}} onSignOut={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Set up authenticator app" }));
    await screen.findByAltText("QR code to set up SmartRetailX authenticator MFA");
    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and enable" }));

    await waitFor(() => expect(verifyTotpSetup).toHaveBeenCalledWith("access-token", "123456"));
    expect(setTotpPreference).toHaveBeenCalledWith("access-token", true);
  });
});
