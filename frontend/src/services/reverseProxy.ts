import type { CancelablePromise } from "@/client"
import { OpenAPI } from "@/client"
import { request as __request } from "@/client/core/request"

export type TraefikRuntimeItem = Record<string, unknown>

export type TraefikRuntimeSection = {
  routers: TraefikRuntimeItem[]
  services: TraefikRuntimeItem[]
  middlewares: TraefikRuntimeItem[]
}

export type TraefikRuntimeSnapshot = {
  runtime_error?: string | null
  version?: Record<string, unknown> | null
  overview?: Record<string, unknown> | null
  entrypoints: TraefikRuntimeItem[]
  http: TraefikRuntimeSection
  tcp: TraefikRuntimeSection
  udp: TraefikRuntimeSection
}

export type ManagedReverseProxyRule = {
  id: string
  vmid: number
  vm_ip: string
  domain: string
  internal_port: number
  enable_https: boolean
  dns_provider: string
  created_at: string
}

export type ReverseProxyRuleCreateInput = {
  vmid: number
  domain: string
  internal_port: number
  enable_https: boolean
}

export const ReverseProxyApiService = {
  getRuntimeSnapshot(): CancelablePromise<TraefikRuntimeSnapshot> {
    return __request(OpenAPI, {
      method: "GET",
      url: "/api/v1/reverse-proxy/runtime",
    })
  },

  listRules(): CancelablePromise<ManagedReverseProxyRule[]> {
    return __request(OpenAPI, {
      method: "GET",
      url: "/api/v1/reverse-proxy/rules",
    })
  },

  createRule(
    requestBody: ReverseProxyRuleCreateInput,
  ): CancelablePromise<{ message: string }> {
    return __request(OpenAPI, {
      method: "POST",
      url: "/api/v1/reverse-proxy/rules",
      body: requestBody,
      mediaType: "application/json",
    })
  },

  deleteRule(data: {
    ruleId: string
  }): CancelablePromise<{ message: string }> {
    return __request(OpenAPI, {
      method: "DELETE",
      url: "/api/v1/reverse-proxy/rules/{rule_id}",
      path: { rule_id: data.ruleId },
    })
  },

  syncRules(): CancelablePromise<{ message: string }> {
    return __request(OpenAPI, {
      method: "POST",
      url: "/api/v1/reverse-proxy/rules/sync",
    })
  },
}