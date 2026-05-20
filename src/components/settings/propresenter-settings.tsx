import { useState } from "react"
import { toast } from "sonner"
import { Wifi, WifiOff, RefreshCw, Eye, EyeOff } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useProPresenterStore } from "@/stores/propresenter-store"
import { useProPresenter } from "@/hooks/use-propresenter"

const STATUS_LABELS: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  connected:    { label: "Connected",     variant: "default" },
  connecting:   { label: "Connecting...", variant: "secondary" },
  disconnected: { label: "Disconnected",  variant: "outline" },
  error:        { label: "Error",         variant: "destructive" },
}

export function ProPresenterSettings() {
  const host         = useProPresenterStore((s) => s.host)
  const port         = useProPresenterStore((s) => s.port)
  const password     = useProPresenterStore((s) => s.password)
  const enabled      = useProPresenterStore((s) => s.enabled)
  const slides       = useProPresenterStore((s) => s.slides)
  const presentation = useProPresenterStore((s) => s.currentPresentation)
  const lastPushed   = useProPresenterStore((s) => s.lastPushedText)

  const setHost     = useProPresenterStore((s) => s.setHost)
  const setPort     = useProPresenterStore((s) => s.setPort)
  const setPassword = useProPresenterStore((s) => s.setPassword)
  const setEnabled  = useProPresenterStore((s) => s.setEnabled)

  const { connectionStatus, refreshSlides } = useProPresenter()
  const [showPassword, setShowPassword] = useState(false)

  const statusInfo = STATUS_LABELS[connectionStatus] ?? STATUS_LABELS.disconnected

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              {connectionStatus === "connected" ? (
                <Wifi className="h-4 w-4 text-green-500" />
              ) : (
                <WifiOff className="h-4 w-4 text-muted-foreground" />
              )}
              ProPresenter Integration
            </CardTitle>
            <CardDescription className="mt-1">
              Automatically push transcribed lyrics to the matching slide in
              ProPresenter via Remote Control.
            </CardDescription>
          </div>
          <Badge variant={statusInfo.variant}>{statusInfo.label}</Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Enable toggle */}
        <div className="flex items-center justify-between">
          <Label htmlFor="pp-enabled" className="text-sm font-medium">
            Enable ProPresenter integration
          </Label>
          <Switch
            id="pp-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>

        {/* Host + Port */}
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pp-host">Host</Label>
            <Input
              id="pp-host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.100"
              disabled={!enabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pp-port">Port</Label>
            <Input
              id="pp-port"
              type="number"
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              placeholder="1025"
              className="w-24"
              disabled={!enabled}
            />
          </div>
        </div>

        {/* Password */}
        <div className="space-y-1.5">
          <Label htmlFor="pp-password">Remote Control Password</Label>
          <div className="relative">
            <Input
              id="pp-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Set in ProPresenter > Preferences > Network"
              disabled={!enabled}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              tabIndex={-1}
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Enable Remote Control in ProPresenter under{" "}
            <strong>Preferences &gt; Network &gt; Enable Remote</strong>.
          </p>
        </div>

        {/* Live status panel (only when connected) */}
        {connectionStatus === "connected" && (
          <div className="rounded-md border bg-muted/40 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Loaded Presentation
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  refreshSlides()
                  toast.info("Refreshing slides...")
                }}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Refresh
              </Button>
            </div>

            {presentation ? (
              <>
                <p className="text-sm font-medium">{presentation.name}</p>
                <p className="text-xs text-muted-foreground">
                  {slides.length} slide{slides.length !== 1 ? "s" : ""} loaded
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No presentation loaded in ProPresenter.
              </p>
            )}

            {lastPushed && (
              <p className="text-xs text-muted-foreground truncate">
                Last pushed:{" "}
                <span className="font-medium text-foreground">
                  &ldquo;{lastPushed}&rdquo;
                </span>
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
