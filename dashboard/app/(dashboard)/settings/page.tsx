"use client";

import { useAuth } from "@/lib/auth-context";
import { Card, CardHeader, PageHeader, StatusBadge } from "@/components/ui";

const API_URL = "/api";

export default function SettingsPage() {
  const { tenant, stores } = useAuth();

  return (
    <>
      <PageHeader title="Settings" description="Your tenant, connected stores, and API access." />

      <div className="space-y-5">
        <Card>
          <CardHeader title="Tenant" />
          <div className="px-5 py-4 text-sm">
            <p className="font-medium text-slate-800">{tenant?.name}</p>
            <p className="mt-0.5 font-mono text-xs text-slate-400">{tenant?.id}</p>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Connected stores"
            subtitle="A store missing write access can only get recommend-only AI proposals executed manually — nothing writes back to Shopify without it."
          />
          <div className="divide-y divide-slate-100">
            {stores.map((store) => {
              const hasWriteAccess = store.scopes.some((s) => s.startsWith("write_"));

              return (
                <div key={store.id} className="flex items-center justify-between px-5 py-3.5">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{store.shopDomain}</p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {store.scopes.join(", ") || "no scopes recorded"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge status={store.status} />
                    {!hasWriteAccess ? (
                      <a
                        href={`${API_URL}/auth/shopify/request-write-access?shop=${store.shopDomain}`}
                        className="text-xs font-medium text-indigo-600 hover:underline"
                      >
                        Grant write access →
                      </a>
                    ) : (
                      <span className="text-xs font-medium text-emerald-600">Write access granted</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader title="API access" />
          <div className="px-5 py-4 text-sm text-slate-600">
            <p>
              You&apos;re signed in with an API key stored only in this browser. Keys are shown
              once, at the moment they&apos;re issued, and can&apos;t be retrieved again — if you
              lose yours, a new one can be minted for this tenant from the server.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
