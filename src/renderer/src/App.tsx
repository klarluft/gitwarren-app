/**
 * The app shell and its three screens.
 *
 * Routing is a hash and a switch (see `lib/router`). The review screen is given
 * a wider column than the others, because a diff needs the room and the rest of
 * the app reads better narrow.
 */
import { UpdateBanner } from './components/update-banner'
import { AgentAccessPanel } from './features/agent/agent-access-panel'
import { RepositoryDetail } from './features/repositories/repository-detail'
import { RepositoryList } from './features/repositories/repository-list'
import { ReviewDetail } from './features/reviews/review-detail'
import { useRoute } from './lib/router'
import { cn } from './lib/utils'

export function App() {
  const route = useRoute()

  return (
    <div className="flex h-full flex-col">
      {/* Draggable strip so the frameless macOS title bar still moves the window. */}
      <div className="titlebar-drag h-11 shrink-0" />

      <main
        className={cn(
          'mx-auto w-full flex-1 overflow-y-auto px-6 pb-10',
          route.name === 'review' ? 'max-w-5xl' : 'max-w-3xl'
        )}
      >
        <div className="mb-6">
          <UpdateBanner />
        </div>

        {route.name === 'repositories' && <HomeScreen />}
        {route.name === 'repository' && <RepositoryDetail repositoryId={route.repositoryId} />}
        {route.name === 'review' && <ReviewDetail reviewId={route.reviewId} tab={route.tab} />}
      </main>
    </div>
  )
}

function HomeScreen() {
  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">GitWarren</h1>
        <p className="text-sm text-muted-foreground">
          Local code review for your git repositories
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <RepositoryList />
        <AgentAccessPanel />
      </div>
    </>
  )
}
