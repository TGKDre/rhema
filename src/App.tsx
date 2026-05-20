import { useEffect } from "react"
import { Dashboard } from "@/components/layout/dashboard"
import { useRemoteControl } from "@/hooks/use-remote-control"
import { useProPresenter } from "@/hooks/use-propresenter"
import { hydrateProPresenterSettings } from "@/stores/propresenter-store"
import { TutorialOverlay } from "@/components/tutorial/tutorial-overlay"
import { Toaster } from "sonner"

export function App() {
  useRemoteControl()
  useProPresenter()

  useEffect(() => {
    hydrateProPresenterSettings()
  }, [])

  return (
    <>
      <Dashboard />
      <TutorialOverlay />
      <Toaster position="bottom-right" />
    </>
  )
}

export default App
