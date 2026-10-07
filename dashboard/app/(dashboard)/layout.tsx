"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/lib/auth-context";
import { Spinner } from "@/components/ui";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: OverviewIcon },
  { href: "/orders", label: "Orders", icon: OrdersIcon },
  { href: "/inventory", label: "Inventory", icon: InventoryIcon },
  { href: "/exceptions", label: "Exceptions", icon: ExceptionIcon },
  { href: "/proposals", label: "AI Proposals", icon: ProposalIcon },
  { href: "/autonomy", label: "Autonomy", icon: AutonomyIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, tenant, stores, selectedStoreId, setSelectedStoreId, logout } = useAuth();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-sm font-bold text-white">
            T
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">
              {tenant?.name ?? "TechMart"}
            </p>
            <p className="text-[11px] text-slate-400">Operations Intelligence</p>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3 py-4">
          {NAV_ITEMS.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <item.icon active={active} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-slate-100 p-3">
          {stores.length > 0 ? (
            <select
              value={selectedStoreId ?? ""}
              onChange={(e) => setSelectedStoreId(e.target.value)}
              className="mb-2 w-full truncate rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 focus:outline-none"
            >
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.shopDomain}
                </option>
              ))}
            </select>
          ) : (
            <p className="mb-2 px-1 text-xs text-slate-400">No store connected yet</p>
          )}
          <button
            onClick={logout}
            className="w-full rounded-lg px-2.5 py-1.5 text-left text-xs font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-8 py-8">{children}</div>
      </main>
    </div>
  );
}

function iconProps(active?: boolean) {
  return {
    width: 17,
    height: 17,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: active ? 2.2 : 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
}

function OverviewIcon({ active }: { active?: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  );
}

function OrdersIcon({ active }: { active?: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <path d="M8 4h8l2 2v14H6V6l2-2Z" />
      <path d="M9 4v4h6V4M9 12h6M9 16h4" />
    </svg>
  );
}

function InventoryIcon({ active }: { active?: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <path d="M3 20h18M5 20V7l7-4 7 4v13" />
      <path d="M8 10h8M8 14h8M8 18h8" />
      <path d="M10 10v4M14 14v4" />
    </svg>
  );
}

function ExceptionIcon({ active }: { active?: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <path d="M10.3 3.6 2 18a1.5 1.5 0 0 0 1.3 2.2h17.4A1.5 1.5 0 0 0 22 18L13.7 3.6a1.5 1.5 0 0 0-2.6 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function ProposalIcon({ active }: { active?: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <path d="M12 2 3 6l9 4 9-4-9-4Z" />
      <path d="M3 12l9 4 9-4" />
      <path d="M3 17l9 4 9-4" />
    </svg>
  );
}

function AutonomyIcon({ active }: { active?: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </svg>
  );
}

function SettingsIcon({ active }: { active?: boolean }) {
  return (
    <svg {...iconProps(active)}>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}
