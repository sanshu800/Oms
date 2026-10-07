"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";

import {
  api,
  clearStoredApiKey,
  getStoredApiKey,
  setStoredApiKey,
  type MeResponse,
  type Store,
} from "./api";

type AuthState = {
  status: "loading" | "authenticated" | "unauthenticated";
  tenant: MeResponse["tenant"];
  stores: Store[];
  selectedStoreId: string | null;
  setSelectedStoreId: (storeId: string) => void;
  login: (apiKey: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

const SELECTED_STORE_KEY = "techmart_selected_store";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [tenant, setTenant] = useState<MeResponse["tenant"]>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreIdState] = useState<string | null>(null);

  const applyMe = useCallback((me: MeResponse) => {
    setTenant(me.tenant);
    setStores(me.stores);

    const storedStoreId =
      typeof window !== "undefined" ? window.localStorage.getItem(SELECTED_STORE_KEY) : null;

    const validStoredStore = me.stores.find((s) => s.id === storedStoreId);
    const initialStoreId = validStoredStore?.id ?? me.stores[0]?.id ?? null;

    setSelectedStoreIdState(initialStoreId);
    setStatus("authenticated");
  }, []);

  const refresh = useCallback(async () => {
    const me = await api.me();
    applyMe(me);
  }, [applyMe]);

  useEffect(() => {
    const existingKey = getStoredApiKey();

    if (!existingKey) {
      setStatus("unauthenticated");
      return;
    }

    api
      .me()
      .then(applyMe)
      .catch(() => {
        clearStoredApiKey();
        setStatus("unauthenticated");
      });
  }, [applyMe]);

  const login = useCallback(
    async (apiKey: string) => {
      const me = await api.validateKey(apiKey);
      setStoredApiKey(apiKey);
      applyMe(me);
      router.push("/");
    },
    [applyMe, router],
  );

  const logout = useCallback(() => {
    clearStoredApiKey();
    window.localStorage.removeItem(SELECTED_STORE_KEY);
    setTenant(null);
    setStores([]);
    setSelectedStoreIdState(null);
    setStatus("unauthenticated");
    router.push("/login");
  }, [router]);

  const setSelectedStoreId = useCallback((storeId: string) => {
    setSelectedStoreIdState(storeId);
    window.localStorage.setItem(SELECTED_STORE_KEY, storeId);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      status,
      tenant,
      stores,
      selectedStoreId,
      setSelectedStoreId,
      login,
      logout,
      refresh,
    }),
    [status, tenant, stores, selectedStoreId, setSelectedStoreId, login, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
