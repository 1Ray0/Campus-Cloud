import { QueryClientProvider } from "@tanstack/react-query"
import { createRouter, RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import ReactDOM from "react-dom/client"

import { OpenAPI } from "./client"
import { ThemeProvider } from "./components/theme-provider"
import { Toaster } from "./components/ui/sonner"
import "./index.css"
import "./lib/i18n"
import { queryClient } from "./lib/queryClient"
import { LanguageProvider } from "./providers/LanguageProvider"
import { routeTree } from "./routeTree.gen"
import { AuthSessionService } from "./services/authSession"

OpenAPI.BASE = import.meta.env.VITE_API_URL

function getTokenExp(token: string): number {
  try {
    const payload = token.split(".")[1]
    if (!payload) return 0
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const json = atob(normalized)
    const data = JSON.parse(json) as { exp?: number }
    return typeof data.exp === "number" ? data.exp : 0
  } catch {
    return 0
  }
}

const REFRESH_THRESHOLD_SEC = 30

let refreshPromise: Promise<boolean> | null = null

async function tryRefreshToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise

  refreshPromise = (async () => {
    try {
      return await AuthSessionService.refreshAccessToken()
    } finally {
      refreshPromise = null
    }
  })()

  return refreshPromise
}

OpenAPI.TOKEN = async () => {
  const token = AuthSessionService.getAccessToken()
  if (!token) return ""

  const exp = getTokenExp(token)
  const nowSec = Math.floor(Date.now() / 1000)

  if (exp > 0 && exp - nowSec <= REFRESH_THRESHOLD_SEC) {
    const ok = await tryRefreshToken()
    if (ok) return AuthSessionService.getAccessToken() || ""
  }

  return token
}

const handleApiError = async (error: Error) => {
  if (error instanceof ApiError && error.status === 401) {
    const refreshed = await tryRefreshToken()
    if (refreshed) {
      // Token 刷新成功：只重打目前處於 error 狀態的 active query，
      // 避免 invalidateQueries() 全量刷新導致表單頁面等元件因 re-render 重置本地狀態。
      await queryClient.refetchQueries({
        type: "active",
        predicate: (query) => query.state.status === "error",
      })
    } else {
      localStorage.removeItem("access_token")
      localStorage.removeItem("refresh_token")
      toast.error("登入已過期，請重新登入")
      window.location.href = "/login"
    }
  } else if (error instanceof ApiError && error.status === 403) {
    // 403 代表已登入但無權限存取該資源，不應強制登出
    const detail =
      (error.body as { detail?: string } | undefined)?.detail ??
      "您沒有權限執行此操作"
    toast.error(detail)
  }
}
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 401/403 是授權問題，重試只會累積退避延遲（預設 retry=3，約等 7 秒）造成 UI 長時間卡住。
      // 其他錯誤維持預設的 3 次重試行為。
      retry: (failureCount, error) => {
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          return false
        }
        return failureCount < 3
      },
    },
    mutations: {
      retry: false,
    },
  },
  queryCache: new QueryCache({
    onError: handleApiError,
  }),
  mutationCache: new MutationCache({
    onError: handleApiError,
  }),
})

const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider
      defaultLanguage="zh-TW"
      storageKey="campus-cloud-language"
    >
      <ThemeProvider defaultTheme="light" storageKey="vite-ui-theme">
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
          <Toaster richColors closeButton />
        </QueryClientProvider>
      </ThemeProvider>
    </LanguageProvider>
  </StrictMode>,
)
