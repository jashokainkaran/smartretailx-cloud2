import { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  beginTotpSetup,
  changeCognitoPassword,
  deleteCognitoAccount,
  fetchCognitoProfile,
  setTotpPreference,
  updateCognitoAttributes,
  verifyCognitoEmail,
  verifyTotpSetup,
} from "../auth/cognitoUser.js";
import { validateEmail, validateRequired } from "../lib/validation.js";

const MIN_PASSWORD_LENGTH = 8;

export default function ProfilePage({ accessToken, profile, onProfileUpdated, onSignOut }) {
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState(detailsFrom(profile));
  const [pendingEmail, setPendingEmail] = useState(null);
  const [emailCode, setEmailCode] = useState("");
  const [detailsNotice, setDetailsNotice] = useState(null);
  const [detailsError, setDetailsError] = useState(null);
  const [savingDetails, setSavingDetails] = useState(false);
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState(null);
  const [passwordError, setPasswordError] = useState(null);
  const [savingPassword, setSavingPassword] = useState(false);
  const [totpSecret, setTotpSecret] = useState(null);
  const [totpQrUrl, setTotpQrUrl] = useState(null);
  const [totpCode, setTotpCode] = useState("");
  const [mfaNotice, setMfaNotice] = useState(null);
  const [mfaError, setMfaError] = useState(null);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [confirmDisableMfa, setConfirmDisableMfa] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setDetails(detailsFrom(profile));
  }, [profile]);

  const mfaEnabled = profile?.mfaSettings?.includes("SOFTWARE_TOKEN_MFA") || profile?.preferredMfa === "SOFTWARE_TOKEN_MFA";

  async function refreshProfile() {
    const fresh = await fetchCognitoProfile(accessToken);
    onProfileUpdated(fresh);
    return fresh;
  }

  async function saveDetails(event) {
    event.preventDefault();
    const first = details.givenName.trim();
    const last = details.familyName.trim();
    const email = details.email.trim();
    const errors = [
      validateRequired(first, "First name"),
      validateRequired(last, "Last name"),
      validateEmail(email),
    ].filter(Boolean);
    if (errors.length) {
      setDetailsError(errors[0]);
      return;
    }

    const updates = {};
    if (first !== profile.givenName) updates.given_name = first;
    if (last !== profile.familyName) updates.family_name = last;
    if (email !== profile.email) updates.email = email;
    if (!Object.keys(updates).length) {
      setEditing(false);
      return;
    }

    setSavingDetails(true);
    setDetailsError(null);
    setDetailsNotice(null);
    try {
      const result = await updateCognitoAttributes(accessToken, updates);
      const emailNeedsVerification = result?.CodeDeliveryDetailsList?.some((item) => item.AttributeName === "email");
      await refreshProfile();
      setEditing(false);
      if (emailNeedsVerification) {
        setPendingEmail(email);
        setDetailsNotice(`We sent a verification code to ${email}. Your current email remains active until you enter it below.`);
      } else {
        setDetailsNotice("Your profile details were saved.");
      }
    } catch (saveError) {
      setDetailsError(saveError.message || "Could not update your profile. Please try again.");
    } finally {
      setSavingDetails(false);
    }
  }

  async function confirmEmail(event) {
    event.preventDefault();
    if (!/^\d{6}$/.test(emailCode.trim())) {
      setDetailsError("Enter the six-digit email verification code.");
      return;
    }
    setSavingDetails(true);
    setDetailsError(null);
    try {
      await verifyCognitoEmail(accessToken, emailCode);
      await refreshProfile();
      setPendingEmail(null);
      setEmailCode("");
      setDetailsNotice("Your new email address is verified. Sign out and sign in again to refresh your email in all browser sessions.");
    } catch (verifyError) {
      setDetailsError(verifyError.message || "That verification code was not accepted.");
    } finally {
      setSavingDetails(false);
    }
  }

  async function savePassword(event) {
    event.preventDefault();
    if (!passwords.current || !passwords.next || !passwords.confirm) {
      setPasswordError("Complete all three password fields.");
      return;
    }
    if (passwords.next.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`Your new password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
      return;
    }
    if (passwords.next !== passwords.confirm) {
      setPasswordError("Your new password and confirmation do not match.");
      return;
    }
    setSavingPassword(true);
    setPasswordError(null);
    try {
      await changeCognitoPassword(accessToken, passwords.current, passwords.next);
      setPasswords({ current: "", next: "", confirm: "" });
      setPasswordOpen(false);
      setPasswordNotice("Your password was changed successfully.");
    } catch (changeError) {
      setPasswordError(changeError.message || "Could not change your password.");
    } finally {
      setSavingPassword(false);
    }
  }

  async function startTotpSetup() {
    setMfaBusy(true);
    setMfaError(null);
    setMfaNotice(null);
    try {
      const { SecretCode } = await beginTotpSetup(accessToken);
      const otpUri = `otpauth://totp/${encodeURIComponent(`SmartRetailX:${profile.email}`)}?secret=${SecretCode}&issuer=SmartRetailX`;
      setTotpSecret(SecretCode);
      setTotpQrUrl(await QRCode.toDataURL(otpUri, { margin: 1, width: 220 }));
    } catch (setupError) {
      setMfaError(setupError.message || "Could not start authenticator setup.");
    } finally {
      setMfaBusy(false);
    }
  }

  async function completeTotpSetup(event) {
    event.preventDefault();
    if (!/^\d{6}$/.test(totpCode.trim())) {
      setMfaError("Enter the current six-digit code from your authenticator app.");
      return;
    }
    setMfaBusy(true);
    setMfaError(null);
    try {
      await verifyTotpSetup(accessToken, totpCode);
      await setTotpPreference(accessToken, true);
      await refreshProfile();
      setTotpSecret(null);
      setTotpQrUrl(null);
      setTotpCode("");
      setMfaNotice("Authenticator-app MFA is now enabled. You will be asked for a code at your next sign-in.");
    } catch (verifyError) {
      setMfaError(verifyError.message || "That authenticator code was not accepted.");
    } finally {
      setMfaBusy(false);
    }
  }

  async function disableTotp() {
    setMfaBusy(true);
    setMfaError(null);
    try {
      await setTotpPreference(accessToken, false);
      await refreshProfile();
      setConfirmDisableMfa(false);
      setMfaNotice("Authenticator-app MFA has been disabled.");
    } catch (disableError) {
      setMfaError(disableError.message || "Could not disable MFA.");
    } finally {
      setMfaBusy(false);
    }
  }

  async function removeAccount(event) {
    event.preventDefault();
    if (deleteConfirmation !== "DELETE") {
      setDeleteError('Type DELETE exactly to confirm account deletion.');
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteCognitoAccount(accessToken);
      onSignOut();
    } catch (removeError) {
      setDeleteError(removeError.message || "Could not delete your account.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="mx-auto max-w-3xl">
      <p className="text-sm font-semibold text-brand-700">Your account</p>
      <h2 className="mt-1 text-3xl font-bold tracking-tight text-stone-900">My Profile</h2>
      <p className="mt-2 text-sm text-stone-600">Manage your personal details and account security in one place.</p>

      <div className="mt-7 space-y-6">
        <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h3 className="text-lg font-bold text-stone-900">Personal details</h3><p className="mt-1 text-sm text-stone-500">Used to personalise your checkout form.</p></div>
            <button type="button" onClick={() => { setEditing((current) => !current); setDetailsError(null); }} className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50">
              {editing ? "Cancel editing" : "Edit profile"}
            </button>
          </div>

          {editing ? (
            <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={saveDetails} noValidate>
              <ProfileField label="First name" value={details.givenName} onChange={(value) => setDetails((current) => ({ ...current, givenName: value }))} autoComplete="given-name" />
              <ProfileField label="Last name" value={details.familyName} onChange={(value) => setDetails((current) => ({ ...current, familyName: value }))} autoComplete="family-name" />
              <div className="sm:col-span-2"><ProfileField label="Email address" type="email" value={details.email} onChange={(value) => setDetails((current) => ({ ...current, email: value }))} autoComplete="email" /></div>
              {detailsError && <p className="sm:col-span-2 rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{detailsError}</p>}
              <div className="sm:col-span-2"><button disabled={savingDetails} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{savingDetails ? "Saving…" : "Save changes"}</button></div>
            </form>
          ) : (
            <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-3"><ProfileValue label="First name" value={profile?.givenName} /><ProfileValue label="Last name" value={profile?.familyName} /><ProfileValue label="Email" value={profile?.email} /></dl>
          )}

          {detailsNotice && <p className="mt-5 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{detailsNotice}</p>}
          {pendingEmail && (
            <form className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4" onSubmit={confirmEmail} noValidate>
              <p className="text-sm font-semibold text-amber-900">Verify {pendingEmail}</p>
              <p className="mt-1 text-xs text-amber-800">Enter the six-digit code sent to your new address.</p>
              <div className="mt-3 flex flex-wrap gap-3"><input value={emailCode} onChange={(event) => setEmailCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" aria-label="Email verification code" className="w-44 rounded-md border border-amber-300 bg-white px-3 py-2" /><button disabled={savingDetails} className="rounded-md bg-amber-700 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-60">Verify email</button></div>
            </form>
          )}
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold text-stone-900">Password</h3><p className="mt-1 text-sm text-stone-500">Use a new, unique password you do not reuse elsewhere.</p></div><button type="button" onClick={() => { setPasswordOpen((current) => !current); setPasswordError(null); }} className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50">{passwordOpen ? "Cancel" : "Change password"}</button></div>
          {passwordNotice && <p className="mt-5 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{passwordNotice}</p>}
          {passwordOpen && <form className="mt-5 max-w-md space-y-4" onSubmit={savePassword} noValidate><PasswordField label="Current password" value={passwords.current} onChange={(value) => setPasswords((current) => ({ ...current, current: value }))} autoComplete="current-password" /><PasswordField label="New password" value={passwords.next} onChange={(value) => setPasswords((current) => ({ ...current, next: value }))} autoComplete="new-password" /><PasswordField label="Confirm new password" value={passwords.confirm} onChange={(value) => setPasswords((current) => ({ ...current, confirm: value }))} autoComplete="new-password" />{passwordError && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{passwordError}</p>}<button disabled={savingPassword} className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{savingPassword ? "Changing…" : "Save new password"}</button></form>}
        </section>

        <section className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold text-stone-900">Multi-factor authentication</h3><p className="mt-1 text-sm text-stone-500">Protect your account with a six-digit code from an authenticator app.</p></div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${mfaEnabled ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-700"}`}>{mfaEnabled ? "Enabled" : "Not enabled"}</span></div>
          {mfaNotice && <p className="mt-5 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800" role="status">{mfaNotice}</p>}
          {mfaError && <p className="mt-5 rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{mfaError}</p>}
          {!mfaEnabled && !totpSecret && <button type="button" onClick={startTotpSetup} disabled={mfaBusy} className="mt-5 rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{mfaBusy ? "Preparing…" : "Set up authenticator app"}</button>}
          {totpSecret && <form className="mt-5 rounded-lg border border-brand-200 bg-brand-50 p-4" onSubmit={completeTotpSetup} noValidate><h4 className="font-semibold text-stone-900">Scan the QR code</h4><p className="mt-1 text-sm text-stone-600">Open Google Authenticator, Microsoft Authenticator, Authy, or a compatible app and scan this code. Then enter its current six-digit code.</p>{totpQrUrl && <img src={totpQrUrl} alt="QR code to set up SmartRetailX authenticator MFA" className="mt-4 h-[220px] w-[220px] rounded bg-white p-2" />}<details className="mt-3 text-xs text-stone-600"><summary className="cursor-pointer font-medium">Can’t scan the code?</summary><p className="mt-2 break-all">Manual setup key: <code>{totpSecret}</code></p></details><div className="mt-4 flex flex-wrap gap-3"><input value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" aria-label="Authenticator code" placeholder="Six-digit code" className="w-44 rounded-md border border-stone-300 px-3 py-2" /><button disabled={mfaBusy} className="rounded-md bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">{mfaBusy ? "Verifying…" : "Verify and enable"}</button></div></form>}
          {mfaEnabled && !confirmDisableMfa && <button type="button" onClick={() => setConfirmDisableMfa(true)} className="mt-5 rounded-md border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">Disable MFA</button>}
          {mfaEnabled && confirmDisableMfa && <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4"><p className="text-sm text-red-800">Disabling MFA makes this account less secure. Are you sure?</p><div className="mt-3 flex gap-3"><button type="button" disabled={mfaBusy} onClick={disableTotp} className="rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60">{mfaBusy ? "Disabling…" : "Yes, disable MFA"}</button><button type="button" onClick={() => setConfirmDisableMfa(false)} className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-700">Cancel</button></div></div>}
        </section>

        <section className="rounded-xl border border-red-200 bg-white p-5 shadow-sm sm:p-6"><h3 className="text-lg font-bold text-red-800">Delete account</h3><p className="mt-1 text-sm text-stone-600">This deletes your Cognito sign-in account. It does not delete completed order records, which must be retained for operational and financial reasons.</p>{!deleteOpen ? <button type="button" onClick={() => setDeleteOpen(true)} className="mt-5 rounded-md border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">Delete my account</button> : <form className="mt-5 rounded-lg bg-red-50 p-4" onSubmit={removeAccount}><label className="block text-sm font-semibold text-red-900">Type <code>DELETE</code> to confirm<input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} className="mt-2 block w-full rounded-md border border-red-300 bg-white px-3 py-2 text-stone-900" /></label>{deleteError && <p className="mt-3 text-sm text-red-800" role="alert">{deleteError}</p>}<div className="mt-4 flex gap-3"><button disabled={deleting} className="rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-60">{deleting ? "Deleting…" : "Permanently delete account"}</button><button type="button" onClick={() => { setDeleteOpen(false); setDeleteConfirmation(""); setDeleteError(null); }} className="rounded-md border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-700">Cancel</button></div></form>}</section>
      </div>
    </section>
  );
}

function detailsFrom(profile) {
  return { givenName: profile?.givenName || "", familyName: profile?.familyName || "", email: profile?.email || "" };
}

function ProfileValue({ label, value }) { return <div><dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</dt><dd className="mt-1 break-words font-medium text-stone-900">{value || "—"}</dd></div>; }
function ProfileField({ label, value, onChange, type = "text", autoComplete }) { return <label className="block text-sm font-semibold text-stone-800">{label}<input type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} className="mt-1.5 w-full rounded-md border border-stone-300 px-3 py-2 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200" /></label>; }
function PasswordField({ label, value, onChange, autoComplete }) { return <label className="block text-sm font-semibold text-stone-800">{label}<input type="password" value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} className="mt-1.5 w-full rounded-md border border-stone-300 px-3 py-2 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200" /></label>; }
