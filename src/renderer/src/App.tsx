/**
 * The app shell and its three screens.
 *
 * Routing is a hash and a switch (see `lib/router`). The review screen is given
 * a wider column than the others, because a diff needs the room and the rest of
 * the app reads better narrow.
 */
import { useRef } from 'react'
// `?inline` rather than a bundled file URL: the packaged renderer is loaded
// over file://, where the `img-src 'self'` in index.html does not cover a
// sibling file. A data: URI is allowed by that same policy, and at this size
// costs less than the exception would.
import logo from './assets/logo.png?inline'
import { ScrollToTop } from './components/scroll-to-top'
import { Kbd } from './components/ui/kbd'
import { TooltipProvider } from './components/ui/tooltip'
import { UpdateBanner } from './components/update-banner'
import { AgentAccessPanel } from './features/agent/agent-access-panel'
import { CommandCenter } from './features/commands/command-center'
import { CommandRegistryProvider } from './features/commands/command-registry'
import { RepositoryDetail } from './features/repositories/repository-detail'
import { RepositoryList } from './features/repositories/repository-list'
import { ReviewDetail } from './features/reviews/review-detail'
import { useRoute } from './lib/router'
import { cn } from './lib/utils'

export function App() {
  const route = useRoute()
  // The app scrolls inside <main>, not the window, so anything that wants to
  // know or change the scroll position needs a handle on that element.
  const scroller = useRef<HTMLElement>(null)

  return (
    // One provider for the whole app: Base UI groups tooltips through it, so
    // the first one waits and moving along a row of icon buttons then shows
    // each immediately - which is the behaviour that makes a toolbar readable.
    <TooltipProvider>
      {/* Wraps the screens, because a screen contributes its own commands while
          it is mounted and the palette has to outlive any one of them. */}
      <CommandRegistryProvider>
        <div className="flex h-full flex-col">
          {/* Draggable strip so the frameless macOS title bar still moves the window. */}
          <div className="titlebar-drag h-11 shrink-0" />

          <main
            ref={scroller}
            // Focusable only under program control, so returning to the top can
            // put the keyboard back there too without adding a tab stop.
            tabIndex={-1}
            className={cn(
              'mx-auto w-full flex-1 overflow-y-auto px-6 pb-10 outline-none',
              route.name === 'review' ? 'max-w-5xl' : 'max-w-3xl'
            )}
          >
            <div className="mb-6">
              <UpdateBanner />
            </div>

            {route.name === 'repositories' && <HomeScreen />}
            {route.name === 'repository' && <RepositoryDetail repositoryId={route.repositoryId} />}
            {route.name === 'review' && (
              <ReviewDetail reviewId={route.reviewId} tab={route.tab} focus={route.focus} />
            )}
          </main>

          <ScrollToTop target={scroller} />
          <CommandCenter scroller={scroller} />
        </div>
      </CommandRegistryProvider>
    </TooltipProvider>
  )
}

function HomeScreen() {
  return (
    <>
      <div className="mb-6 flex items-center gap-3">
        {/* Decorative: the wordmark next to it already names the app. */}
        <img src={logo} alt="" className="size-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight">GitWarren</h1>
          <p className="text-sm text-muted-foreground">
            Local code review for your git repositories
          </p>
        </div>
        {/* The one place the palette is advertised. A shortcut nobody is told
            about is a shortcut nobody uses, and the home screen is where a new
            reader is most likely to be looking around. */}
        <p className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Kbd binding="mod+k" />
          <span className="hidden sm:inline">to search</span>
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <RepositoryList />
        <AgentAccessPanel />
      </div>
    </>
  )
}
