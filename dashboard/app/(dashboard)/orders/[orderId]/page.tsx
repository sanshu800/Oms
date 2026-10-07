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
import { api, type OrderDetails } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export default function OrderDetailPage() {
  const params = useParams<{ orderId: string }>();
  const orderId = Array.isArray(params.orderId) ? params.orderId[0] : params.orderId;
  const { selectedStoreId, stores } = useAuth();
  const [order, setOrder] = useState<OrderDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedStoreId || !orderId) return;

    let active = true;
    setOrder(null);
    setError(null);
    api
      .getOrder({ orderId, storeId: selectedStoreId })
      .then((result) => {
        if (active) setOrder(result);
      })
      .catch(() => {
        if (active) setError("Couldn't load this order. It may no longer be available in this store.");
      });

    return () => {
      active = false;
    };
  }, [selectedStoreId, orderId]);

  return (
    <>
      <div className="mb-4">
        <Link href="/orders" className="text-xs font-medium text-slate-500 hover:text-slate-900">
          ← Back to orders
        </Link>
      </div>

      <PageHeader
        title={order?.orderNumber ?? "Order details"}
        description={order ? `Shopify order #${order.externalOrderId}` : "Order lifecycle and inventory reservation details."}
        action={order ? <StatusBadge status={order.status} /> : undefined}
      />

      {stores.length === 0 ? (
        <Card>
          <EmptyState title="No store connected yet" />
        </Card>
      ) : error ? (
        <Card>
          <p className="p-6 text-sm text-red-600">{error}</p>
        </Card>
      ) : !order ? (
        <Card>
          <div className="flex justify-center py-14">
            <Spinner />
          </div>
        </Card>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Order total" value={formatMoney(order.totalAmount, order.currency)} />
            <Metric label="Payment" value={humanize(order.paymentStatus)} />
            <Metric label="Shopify fulfillment" value={humanize(order.fulfillmentStatus)} />
            <Metric label="Placed" value={new Date(order.orderedAt).toLocaleString()} />
          </div>

          <Card>
            <CardHeader
              title="Line items"
              subtitle={`${order.items.length} recorded line${order.items.length === 1 ? "" : "s"}`}
            />
            {order.items.length === 0 ? (
              <EmptyState title="No line items recorded" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                      <th className="px-5 py-3 font-medium">Product</th>
                      <th className="px-5 py-3 font-medium">SKU</th>
                      <th className="px-5 py-3 text-right font-medium">Quantity</th>
                      <th className="px-5 py-3 text-right font-medium">Unit price</th>
                      <th className="px-5 py-3 font-medium">Inventory link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((item) => (
                      <tr key={item.id} className="border-b border-slate-50 last:border-0">
                        <td className="px-5 py-3">
                          <p className="font-medium text-slate-800">{item.title}</p>
                          {item.quantity === 0 ? (
                            <p className="mt-0.5 text-[11px] text-slate-400">Removed in Shopify</p>
                          ) : null}
                        </td>
                        <td className="px-5 py-3 font-mono text-xs text-slate-500">{item.sku}</td>
                        <td className="px-5 py-3 text-right font-semibold tabular-nums text-slate-700">
                          {item.quantity}
                        </td>
                        <td className="px-5 py-3 text-right text-slate-500">
                          {item.unitPrice ? formatMoney(item.unitPrice, order.currency) : "—"}
                        </td>
                        <td className="px-5 py-3 text-xs">
                          {item.inventoryItemId ? (
                            <span className="font-mono text-emerald-700">Linked</span>
                          ) : (
                            <span className="text-slate-400">Unlinked</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Inventory reservations"
              subtitle="Reservations transition from active to committed, then shipped, through fulfillment."
            />
            {order.reservations.length === 0 ? (
              <EmptyState title="No reservations" description="This order currently has no inventory reservation history." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px] text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                      <th className="px-5 py-3 font-medium">Inventory item</th>
                      <th className="px-5 py-3 font-medium">Location</th>
                      <th className="px-5 py-3 text-right font-medium">Quantity</th>
                      <th className="px-5 py-3 font-medium">State</th>
                      <th className="px-5 py-3 font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.reservations.map((reservation) => (
                      <tr key={reservation.id} className="border-b border-slate-50 last:border-0">
                        <td className="px-5 py-3 font-mono text-xs text-slate-600">
                          {reservation.inventoryItemId}
                        </td>
                        <td className="px-5 py-3 font-mono text-xs text-slate-500">
                          {reservation.locationId}
                        </td>
                        <td className="px-5 py-3 text-right font-semibold tabular-nums text-slate-700">
                          {reservation.quantity}
                        </td>
                        <td className="px-5 py-3"><StatusBadge status={reservation.status} /></td>
                        <td className="px-5 py-3 text-xs text-slate-400">
                          {new Date(reservation.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Fulfillment activity" />
            {order.fulfillments.length === 0 ? (
              <EmptyState title="No fulfillment activity yet" />
            ) : (
              <div className="divide-y divide-slate-100">
                {order.fulfillments.map((fulfillment) => (
                  <div key={fulfillment.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-800">Fulfillment {fulfillment.id.slice(0, 8)}</p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {fulfillment.items.length} item lines · {fulfillment.shipments.length} shipment(s)
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={fulfillment.status} />
                      {fulfillment.shipments.map((shipment) => (
                        <span key={shipment.id} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-500">
                          {shipment.trackingNumber ?? shipment.carrier ?? shipment.status}
                        </span>
                      ))}
                    </div>
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card className="min-w-0 px-4 py-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-2 truncate text-sm font-semibold text-slate-800">{value}</p>
    </Card>
  );
}

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatMoney(amount: string, currency: string): string {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(numericAmount);
  } catch {
    return `${amount} ${currency}`;
  }
}
