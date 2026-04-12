import { useMutation, useQuery } from "@tanstack/react-query"
import { Globe, Loader2, Lock, Server } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { type ApiError, type ResourcePublic, ResourcesService } from "@/client"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import useAuth from "@/hooks/useAuth"
import { ReverseProxyApiService } from "@/services/reverseProxy"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: () => void
}

function isAdminUser(
  user: { role?: string; is_superuser?: boolean } | null | undefined,
) {
  return user?.role === "admin" || user?.is_superuser === true
}

function errorMessage(error: unknown, fallback: string) {
  const apiError = error as ApiError & { body?: { detail?: string } }
  return apiError.body?.detail ?? apiError.message ?? fallback
}

const COMMON_PORTS = [
  { value: "80", label: "80 — Nginx / Apache（網頁伺服器）" },
  { value: "443", label: "443 — HTTPS" },
  { value: "3000", label: "3000 — Node.js / React / Next.js" },
  { value: "5000", label: "5000 — Flask / Python" },
  { value: "8000", label: "8000 — FastAPI / Django" },
  { value: "8080", label: "8080 — 常見替代 Port" },
  { value: "8888", label: "8888 — Jupyter Notebook" },
] as const

export function CreateReverseProxyRuleDialog({
  open,
  onOpenChange,
  onCreated,
}: Props) {
  const { user } = useAuth()
  const [selectedVmid, setSelectedVmid] = useState("")
  const [domain, setDomain] = useState("")
  const [internalPort, setInternalPort] = useState("80")
  const [customPort, setCustomPort] = useState("")
  const [useCustomPort, setUseCustomPort] = useState(false)
  const [enableHttps, setEnableHttps] = useState(true)

  const isAdmin = isAdminUser(user)

  const resourcesQuery = useQuery({
    queryKey: ["reverse-proxy-resource-options", isAdmin ? "all" : "mine"],
    queryFn: () =>
      isAdmin
        ? ResourcesService.listResources({})
        : ResourcesService.listMyResources(),
    enabled: open && !!user,
    staleTime: 30_000,
  })

  const createRuleMutation = useMutation({
    mutationFn: () => {
      const port = useCustomPort ? Number(customPort) : Number(internalPort)
      return ReverseProxyApiService.createRule({
        vmid: Number(selectedVmid),
        domain: domain.trim().toLowerCase(),
        internal_port: port,
        enable_https: enableHttps,
      })
    },
    onSuccess: () => {
      toast.success("網域規則建立成功！系統正在自動設定路由...")
      onCreated?.()
      onOpenChange(false)
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(error, "建立網域規則失敗"))
    },
  })

  useEffect(() => {
    if (!open) {
      setSelectedVmid("")
      setDomain("")
      setInternalPort("80")
      setCustomPort("")
      setUseCustomPort(false)
      setEnableHttps(true)
    }
  }, [open])

  const resources = (resourcesQuery.data ?? []) as ResourcePublic[]
  const selectedResource = resources.find(
    (resource) => String(resource.vmid) === selectedVmid,
  )

  const effectivePort = useCustomPort ? customPort : internalPort

  const handleCreate = () => {
    if (!selectedVmid) {
      toast.error("請先選擇你要綁定的 VM")
      return
    }
    if (!domain.trim()) {
      toast.error("請輸入網域名稱")
      return
    }

    const parsedPort = Number(effectivePort)
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      toast.error("Port 必須是 1 到 65535 之間的數字")
      return
    }

    createRuleMutation.mutate()
  }

  const previewDomain = domain.trim().toLowerCase()
  const scheme = enableHttps ? "https" : "http"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5 text-sky-500" />
            新增網域
          </DialogTitle>
          <DialogDescription>
            設定一個網域，讓別人可以透過網址訪問你 VM 裡跑的網站或服務。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Step 1: 選擇 VM */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Server className="h-4 w-4 text-muted-foreground" />
              選擇你的 VM
            </Label>
            <Select value={selectedVmid} onValueChange={setSelectedVmid}>
              <SelectTrigger>
                <SelectValue placeholder="選擇一台 VM..." />
              </SelectTrigger>
              <SelectContent>
                {resources.map((resource) => (
                  <SelectItem
                    key={resource.vmid}
                    value={String(resource.vmid)}
                  >
                    {resource.name} (VM {resource.vmid})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {resourcesQuery.isLoading && (
              <p className="text-xs text-muted-foreground">
                正在載入你的 VM 列表...
              </p>
            )}
            {!resourcesQuery.isLoading && resources.length === 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                你目前沒有任何 VM，請先建立一台 VM。
              </p>
            )}
          </div>

          {/* Step 2: 選擇 Port */}
          <div className="space-y-2">
            <Label>你的服務跑在哪個 Port？</Label>
            <p className="text-xs text-muted-foreground">
              如果你不確定，通常網頁伺服器用 80，Node.js 用 3000，Python 用
              5000。
            </p>
            {!useCustomPort ? (
              <Select value={internalPort} onValueChange={setInternalPort}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_PORTS.map((port) => (
                    <SelectItem key={port.value} value={port.value}>
                      {port.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                type="number"
                min={1}
                max={65535}
                value={customPort}
                onChange={(e) => setCustomPort(e.target.value)}
                placeholder="輸入 Port 號碼（1-65535）"
              />
            )}
            <button
              type="button"
              className="text-xs text-sky-600 hover:underline dark:text-sky-400"
              onClick={() => setUseCustomPort(!useCustomPort)}
            >
              {useCustomPort ? "← 選擇常見 Port" : "我的 Port 不在列表中"}
            </button>
          </div>

          {/* Step 3: 輸入網域 */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              網域名稱
            </Label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="例如：myapp.example.edu.tw"
            />
            <p className="text-xs text-muted-foreground">
              需要先在 DNS 把這個網域指向本平台，不確定的話請問管理員。
            </p>
          </div>

          {/* Step 4: HTTPS */}
          <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
            <div className="flex items-center gap-3">
              <Lock className="h-4 w-4 text-emerald-500" />
              <div>
                <div className="text-sm font-medium text-foreground">
                  啟用安全連線 (HTTPS)
                </div>
                <div className="text-xs text-muted-foreground">
                  自動申請免費的 SSL 憑證，建議開啟
                </div>
              </div>
            </div>
            <Switch checked={enableHttps} onCheckedChange={setEnableHttps} />
          </div>

          {/* 預覽 */}
          {previewDomain && selectedVmid && (
            <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 text-sm">
              <div className="font-medium text-foreground">設定預覽</div>
              <div className="mt-2 space-y-1.5 text-muted-foreground">
                <p>
                  當有人訪問{" "}
                  <span className="font-mono font-semibold text-sky-600 dark:text-sky-400">
                    {scheme}://{previewDomain}
                  </span>
                </p>
                <p>
                  → 系統會自動轉到你的{" "}
                  <span className="font-semibold text-foreground">
                    {selectedResource?.name ?? `VM ${selectedVmid}`}
                  </span>{" "}
                  的 Port{" "}
                  <span className="font-mono font-semibold text-foreground">
                    {effectivePort}
                  </span>
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={handleCreate}
            disabled={
              createRuleMutation.isPending ||
              resources.length === 0 ||
              !selectedVmid ||
              !previewDomain
            }
          >
            {createRuleMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Globe className="mr-2 h-4 w-4" />
            )}
            建立網域規則
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
