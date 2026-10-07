import { describe, expect, it } from "vitest";

import {
  COMPLIANCE_REST_TOPICS,
  COMPLIANCE_WEBHOOK_SUBSCRIPTIONS,
  COMPLIANCE_WEBHOOK_TOPICS,
  evaluateWebhookRegistrationGuards,
  hostnameFromUrl,
  isComplianceRestTopic,
  isHostWithinDomain,
  isLocalHostname,
  isTunnelHostname,
  planWebhookSubscriptionReconciliation,
} from "./webhook-registration";

describe("host classification", () => {
  it("detects tunnel hostnames including subdomains", () => {
    expect(isTunnelHostname("abc123.ngrok-free.app")).toBe(true);
    expect(isTunnelHostname("random-words.trycloudflare.com")).toBe(true);
    expect(isTunnelHostname("NGROK.IO")).toBe(true);
    expect(isTunnelHostname("api.reygent.com")).toBe(false);
    expect(isTunnelHostname("ngrok.io.evil.test")).toBe(false);
  });

  it("detects local hosts and private ranges", () => {
    expect(isLocalHostname("localhost")).toBe(true);
    expect(isLocalHostname("api.local")).toBe(true);
    expect(isLocalHostname("192.168.1.20")).toBe(true);
    expect(isLocalHostname("10.0.0.5")).toBe(true);
    expect(isLocalHostname("172.16.4.1")).toBe(true);
    expect(isLocalHostname("172.32.4.1")).toBe(false);
    expect(isLocalHostname("api.reygent.com")).toBe(false);
  });

  it("matches a host inside a domain but not a lookalike", () => {
    expect(isHostWithinDomain("api.reygent.com", "reygent.com")).toBe(true);
    expect(isHostWithinDomain("reygent.com", "reygent.com")).toBe(true);
    expect(isHostWithinDomain("api.staging.reygent.com", "reygent.com")).toBe(
      true,
    );
    expect(isHostWithinDomain("reygent.com.evil.test", "reygent.com")).toBe(
      false,
    );
    expect(isHostWithinDomain("notreygent.com", "reygent.com")).toBe(false);
  });

  it("extracts hostnames from URLs and rejects relative ones", () => {
    expect(hostnameFromUrl("https://api.reygent.com/webhooks/shopify")).toBe(
      "api.reygent.com",
    );
    expect(() => hostnameFromUrl("/webhooks/shopify")).toThrow();
  });
});

describe("planWebhookSubscriptionReconciliation", () => {
  const desiredUri = "https://api.reygent.com/webhooks/shopify";

  it("creates every managed topic when nothing is registered", () => {
    const plan = planWebhookSubscriptionReconciliation({
      existing: [],
      desiredUri,
    });

    // APP_UNINSTALLED is managed on purpose: without it the OMS never
    // learns that the stored access token died with the install.
    expect(plan.create).toEqual([
      "ORDERS_CREATE",
      "ORDERS_UPDATED",
      "ORDERS_CANCELLED",
      "APP_UNINSTALLED",
    ]);
    expect(plan.update).toEqual([]);
    expect(plan.delete).toEqual([]);
    expect(plan.unmanaged).toEqual([]);
  });

  it("leaves a correct subscription alone", () => {
    const plan = planWebhookSubscriptionReconciliation({
      existing: [{ id: "1", topic: "ORDERS_CREATE", uri: desiredUri }],
      desiredUri,
    });

    expect(plan.create).toEqual([
      "ORDERS_UPDATED",
      "ORDERS_CANCELLED",
      "APP_UNINSTALLED",
    ]);
    expect(plan.unchanged).toEqual([
      { id: "1", topic: "ORDERS_CREATE", uri: desiredUri },
    ]);
  });

  it("updates a subscription left pointing at a dead tunnel", () => {
    const plan = planWebhookSubscriptionReconciliation({
      existing: [
        { id: "1", topic: "ORDERS_CREATE", uri: "https://old.ngrok-free.app/webhooks/shopify" },
      ],
      desiredUri,
    });

    expect(plan.update).toEqual([
      {
        id: "1",
        topic: "ORDERS_CREATE",
        fromUri: "https://old.ngrok-free.app/webhooks/shopify",
        toUri: desiredUri,
      },
    ]);
    expect(plan.create).toEqual([
      "ORDERS_UPDATED",
      "ORDERS_CANCELLED",
      "APP_UNINSTALLED",
    ]);
    expect(plan.delete).toEqual([]);
  });

  it("updates a subscription pointing at an older origin on our domain", () => {
    const plan = planWebhookSubscriptionReconciliation({
      existing: [
        {
          id: "9",
          topic: "ORDERS_UPDATED",
          uri: "https://staging-api.reygent.com/webhooks/shopify",
        },
      ],
      desiredUri,
      ownedDomain: "reygent.com",
    });

    // Same registrable domain as APP_URL → ours to move.
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]?.id).toBe("9");
  });

  it("never touches another integration's subscription on our topic", () => {
    const plan = planWebhookSubscriptionReconciliation({
      existing: [
        { id: "1", topic: "ORDERS_CREATE", uri: "https://partner.example.com/hooks" },
        { id: "2", topic: "FULFILLMENTS_CREATE", uri: "https://partner.example.com/hooks" },
      ],
      desiredUri,
    });

    expect(plan.create).toContain("ORDERS_CREATE");
    expect(plan.unmanaged).toEqual([
      { id: "1", topic: "ORDERS_CREATE", uri: "https://partner.example.com/hooks" },
      { id: "2", topic: "FULFILLMENTS_CREATE", uri: "https://partner.example.com/hooks" },
    ]);
    expect(plan.update).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  it("collapses duplicate registrations of the desired URI", () => {
    const plan = planWebhookSubscriptionReconciliation({
      existing: [
        { id: "1", topic: "ORDERS_CREATE", uri: desiredUri },
        { id: "2", topic: "ORDERS_CREATE", uri: desiredUri },
      ],
      desiredUri,
    });

    expect(plan.unchanged).toEqual([
      { id: "1", topic: "ORDERS_CREATE", uri: desiredUri },
    ]);
    expect(plan.delete).toEqual([
      { id: "2", topic: "ORDERS_CREATE", uri: desiredUri },
    ]);
  });
});

describe("evaluateWebhookRegistrationGuards", () => {
  const base = {
    appUrl: "https://api.reygent.com",
    appDomain: "reygent.com",
    shopDomain: "techmart-lab.myshopify.com",
  };

  it("allows a production origin on the configured domain", () => {
    expect(
      evaluateWebhookRegistrationGuards({ ...base, nodeEnv: "production" }),
    ).toEqual([]);
  });

  it("blocks http, tunnel and local origins in production", () => {
    expect(
      evaluateWebhookRegistrationGuards({
        ...base,
        nodeEnv: "production",
        appUrl: "http://api.reygent.com",
      }).join(" "),
    ).toContain("https in production");

    expect(
      evaluateWebhookRegistrationGuards({
        ...base,
        nodeEnv: "production",
        appUrl: "https://abc.ngrok-free.app",
        appDomain: "ngrok-free.app",
      }).join(" "),
    ).toContain("tunnel host");

    expect(
      evaluateWebhookRegistrationGuards({
        ...base,
        nodeEnv: "production",
        appUrl: "https://localhost:4000",
        appDomain: "localhost",
      }).join(" "),
    ).toContain("is local");
  });

  it("rejects an origin outside APP_DOMAIN, even outside production", () => {
    expect(
      evaluateWebhookRegistrationGuards({
        ...base,
        nodeEnv: "development",
        appUrl: "https://api.other-tenant.example",
      }).join(" "),
    ).toContain("is not inside APP_DOMAIN");
  });

  it("requires an explicit opt-in for tunnel origins in development", () => {
    const tunnel = {
      appUrl: "https://abc.ngrok-free.app",
      appDomain: "",
      shopDomain: "techmart-lab.myshopify.com",
      nodeEnv: "development",
    };

    expect(evaluateWebhookRegistrationGuards(tunnel).join(" ")).toContain(
      "--allow-tunnel",
    );
    expect(
      evaluateWebhookRegistrationGuards({ ...tunnel, allowTunnel: true }),
    ).toEqual([]);
  });

  it("requires APP_DOMAIN in production and validates the shop domain", () => {
    expect(
      evaluateWebhookRegistrationGuards({
        appUrl: "https://api.reygent.com",
        appDomain: "",
        shopDomain: "techmart-lab.myshopify.com",
        nodeEnv: "production",
      }).join(" "),
    ).toContain("APP_DOMAIN must be configured");

    expect(
      evaluateWebhookRegistrationGuards({
        ...base,
        nodeEnv: "development",
        shopDomain: "not a domain",
      }).join(" "),
    ).toContain("Shop domain does not look valid");
  });
});

describe("compliance topic naming", () => {
  it("uses the topic strings Shopify actually delivers", () => {
    // Documented values from the webhook (REST) side of the Admin API. The
    // assertion is deliberately literal: it is the only thing standing
    // between a future refactor and a silent `_ → /` rewrite.
    expect([...COMPLIANCE_REST_TOPICS].sort()).toEqual([
      "customers/data_request",
      "customers/redact",
      "shop/redact",
    ]);
  });

  it("matches deliveries but not a mechanically converted topic", () => {
    expect(isComplianceRestTopic("customers/data_request")).toBe(true);
    expect(isComplianceRestTopic("shop/redact")).toBe(true);
    expect(isComplianceRestTopic("customers/data/request")).toBe(false);
    expect(isComplianceRestTopic("orders/create")).toBe(false);
    expect(isComplianceRestTopic("CUSTOMERS_DATA_REQUEST")).toBe(false);
  });

  it("keeps the GraphQL and REST names paired one-to-one", () => {
    expect(COMPLIANCE_WEBHOOK_TOPICS).toHaveLength(
      COMPLIANCE_WEBHOOK_SUBSCRIPTIONS.length,
    );
    expect(COMPLIANCE_REST_TOPICS).toHaveLength(
      COMPLIANCE_WEBHOOK_SUBSCRIPTIONS.length,
    );
    expect(new Set(COMPLIANCE_REST_TOPICS).size).toBe(
      COMPLIANCE_REST_TOPICS.length,
    );
  });
});
