import { useEffect, useState } from "react";
import { fetchCognitoProfile, updateCognitoAttributes } from "../auth/cognitoUser.js";

export default function CompleteProfilePage({ accessToken, profile, onCompleted }) {
  const [givenName, setGivenName] = useState(profile?.givenName || "");
  const [familyName, setFamilyName] = useState(profile?.familyName || "");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setGivenName(profile?.givenName || "");
    setFamilyName(profile?.familyName || "");
  }, [profile]);

  async function submit(event) {
    event.preventDefault();
    const first = givenName.trim();
    const last = familyName.trim();
    if (!first || !last) {
      setError("Enter both your first name and last name to continue.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await updateCognitoAttributes(accessToken, { given_name: first, family_name: last });
      onCompleted(await fetchCognitoProfile(accessToken));
    } catch (saveError) {
      setError(saveError.message || "Could not save your profile. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto max-w-md py-8">
      <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold text-brand-700">One last step</p>
        <h2 className="mt-2 text-3xl font-bold tracking-tight text-stone-900">Complete your profile</h2>
        <p className="mt-3 text-sm leading-relaxed text-stone-600">
          Tell us how to address you. You can change these details later from My Profile.
        </p>

        <form className="mt-7 space-y-5" onSubmit={submit} noValidate>
          <NameField label="First name" value={givenName} onChange={setGivenName} autoComplete="given-name" />
          <NameField label="Last name" value={familyName} onChange={setFamilyName} autoComplete="family-name" />
          {error && <p className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">{error}</p>}
          <button
            disabled={saving}
            className="w-full rounded-md bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save and continue"}
          </button>
        </form>
      </div>
    </section>
  );
}

function NameField({ label, value, onChange, autoComplete }) {
  return (
    <label className="block text-sm font-semibold text-stone-800">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        className="mt-1.5 w-full rounded-md border border-stone-300 px-3 py-2.5 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
      />
    </label>
  );
}
