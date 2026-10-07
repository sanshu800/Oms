"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/lib/auth-context";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const { status, login } = useAuth();
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/");
    }
  }, [status, router]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login(apiKey.trim());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("That API key isn't valid or has been revoked.");
      } else {
        setError("Couldn't reach TechMart. Check that the API is running.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-900 text-lg font-bold text-white">
            T
          </div>
          <h1 className="text-lg font-semibold text-slate-900">Sign in to TechMart</h1>
          <p className="mt-1 text-sm text-slate-500">
            Paste the API key you were given when your store was connected.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-card"
        >
          <label className="mb-1.5 block text-xs font-medium text-slate-700">API key</label>
          <input
            type="password"
            required
            autoFocus
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="tmk_..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />

          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}

          <Button type="submit" disabled={submitting || !apiKey.trim()} className="mt-4 w-full">
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-400">
          Don&apos;t have a key yet? Connect your store through Shopify first — a key is issued
          automatically the moment your store finishes installing.
        </p>
      </div>
    </div>
  );
}
