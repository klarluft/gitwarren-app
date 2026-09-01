import { UpdateBanner } from './components/update-banner'
import { AgentAccessPanel } from './features/agent/agent-access-panel'
import { RepositoryList } from './features/repositories/repository-list'

export function App() {
  return (
    <div className="flex h-full flex-col">
      {/* Draggable strip so the frameless macOS title bar still moves the window. */}
      <div className="titlebar-drag h-11 shrink-0" />

      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-6 pb-10">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">GitWarren</h1>
          <p className="text-sm text-muted-foreground">Local code review for your git repositories</p>
        </div>

        <div className="flex flex-col gap-6">
          <UpdateBanner />
          <RepositoryList />
          <AgentAccessPanel />
        </div>
      </main>
    </div>
  )
}
