"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import {
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Spinner,
  StatusBadge,
} from "@/components/ui";
import { api, type InventoryItem } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export default function InventoryItemPage() {
  const params = useParams<{ sku: string }>();
  const sku = Array.isArray(params.sku) ? params.sku[0] : params.sku;
  const { selectedStoreId, stores } = useAuth();
  const [item, setItem] = useState<InventoryItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStoreId || !sku) return;

    let active = true;
    setItem(null);
    setError(null);
    api
      .getInventoryItem({ sku, storeId: selectedStoreId })
      .then((result) => {
        if (active) setItem(result);
      })
      .catch(() => {
        if (active) setError("Couldn't load this inventory item.");
      });

    return () => {
      active = false;
    };
  }, [selectedStoreId, sku]);

  const totals = item?.balances.reduce(
    (current, balance) => ({
      available: current.available + balance.availableQty,
      reserved: current.reserved + balance.reservedQty,
      committed: current.committed + balance.committedQty,
    }),
    { available: 0, reserved: 0, committed: 0 },
  );

  return (
    <>
      <div className="mb-4">
        <Link href="/inventory" className="text-xs font-medium text-slate-500 hover:text-slate-900">
          ← Back to inventory
        </Link>
      </div>

      <PageHeader
        title={item?.sku ?? sku ?? "Inventory item"}
        description={item?.name ?? "Canonical inventory position across warehouse locations."}
        action={item ? <StatusBadge status={item.active ? "ACTIVE" : "INACTIVE"} /> : undefined}
      />

      {stores.length === 0 ? (
        <Card>
          <EmptyState title="No store connected yet" />
        </Card>
      ) : error ? (
        <Card>
          <p className="p-6 text-sm text-red-600">{error}</p>
        </Card>
      ) : !item ? (
        <Card>
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        </Card>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric label="Available" value={totals?.available ?? 0} tone="text-emerald-700" />
            <Metric label="Reserved" value={totals?.reserved ?? 0} tone="text-amber-700" />
            <Metric label="Committed" value={totals?.committed ?? 0} tone="text-indigo-700" />
            <Metric
              label="On hand"
              value={(totals?.available ?? 0) + (totals?.reserved ?? 0) + (totals?.committed ?? 0)}
              tone="text-slate-900"
            />
          </div>

          <Card>
            <CardHeader
              title="Location balances"
              subtitle="Reserved stock is held for orders; committed stock is in fulfillment."
            />
            {item.balances.length === 0 ? (
              <EmptyState title="No location balances" description="No stock has been recorded for this SKU." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                      <th className="px-5 py-3 font-medium">Location</th>
                      <th className="px-5 py-3 text-right font-medium">Available</th>
                      <th className="px-5 py-3 text-right font-medium">Reserved</th>
                      <th className="px-5 py-3 text-right font-medium">Committed</th>
                      <th className="px-5 py-3 text-right font-medium">On hand</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.balances.map((balance) => (
                      <tr
                        key={`${balance.location.id}-${balance.location.code}`}
                        className="border-b border-slate-50 last:border-0"
                      >
                        <td className="px-5 py-3">
                          <p className="font-medium text-slate-800">{balance.location.name}</p>
                          <p className="mt-0.5 font-mono text-[11px] text-slate-400">
                            {balance.location.code}
                          </p>
                        </td>
                        <QuantityCell value={balance.availableQty} />
                        <QuantityCell value={balance.reservedQty} />
                        <QuantityCell value={balance.committedQty} />
                        <QuantityCell
                          value={balance.availableQty + balance.reservedQty + balance.committedQty}
                        />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Store references" subtitle="External identifiers mapped to this canonical SKU." />
            {item.externalReferences.length === 0 ? (
              <EmptyState title="No external references" description="This store has no platform inventory identifier linked to the SKU." />
            ) : (
              <div className="divide-y divide-slate-100">
                {item.externalReferences.map((reference) => (
                  <div key={reference.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <span className="text-sm font-medium text-slate-700">{reference.platform}</span>
                    <span className="truncate font-mono text-xs text-slate-500">{reference.externalId}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <Card className="px-4 py-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
    </Card>
  );
}

function QuantityCell({ value }: { value: number }) {
  return <td className="px-5 py-3 text-right font-semibold tabular-nums text-slate-700">{value}</td>;
}
