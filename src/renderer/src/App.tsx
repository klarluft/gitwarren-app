/**
 * The app shell and its five screens.
 *
 * Routing is a hash and a switch (see `lib/router`). The screens are given
 * different amounts of the window - see `reviewWidth` - because a diff needs
 * the room and the rest of the app reads better narrow.
 *
 * Since M4.3 the route may also name a *machine*, and this is the only place
 * that reads it. `HostScopeProvider` puts it where every screen below can get
 * at the api bound to it (`lib/host-scope`), so nothing in `features/` takes a
 * host as a prop and nothing has to remember to pass one on. A route with no
 * host - which is every route this app produced before M4 - provides the local
 * api, and the tree below is byte-for-byte the tree it was.
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
import { AgentAccessCard } from './features/agent/agent-access-card'
import { AgentAccessPage } from './features/agent/agent-access-page'
import { CommandCenter } from './features/commands/command-center'
import { CommandRegistryProvider } from './features/commands/command-registry'
import { HostBanner } from './features/hosts/host-banner'
import { HostsCard } from './features/hosts/hosts-card'
import { HostsPage } from './features/hosts/hosts-page'
import { SettingsPanel } from './features/settings/settings-panel'
import { RepositoryDetail } from './features/repositories/repository-detail'
import { RepositoryList } from './features/repositories/repository-list'
import { ReviewDetail } from './features/reviews/review-detail'
import { HostScopeProvider } from './lib/host-scope'
import { useRoute, type ReviewTab } from './lib/router'
import { cn } from './lib/utils'

/**
 * How much of the window a review is allowed to use.
 *
 * The diff gets the room and the reading tabs do not, because they want
 * different things. A diff is code plus two gutters plus a file tree, and on a
 * narrow column every second line wraps or scrolls sideways; prose and comment
 * threads stretched across a wide monitor are simply hard to read. The ceiling
 * on the diff is there for the same reason - past about this width a line of
 * code has more empty space after it than characters in it.
 */
function reviewWidth(tab: ReviewTab): string {
  return tab === 'files' ? 'max-w-[110rem]' : 'max-w-5xl'
}

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
      {/* The machine every screen below is about. Read here and nowhere else:
          the route is the only thing that knows, and one reader means no
          component can disagree with another about which host it is showing. */}
      <HostScopeProvider host={route.host}>
        {/* Wraps the screens, because a screen contributes its own commands
            while it is mounted and the palette has to outlive any one of them. */}
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
                route.name === 'review' ? reviewWidth(route.tab) : 'max-w-3xl'
              )}
            >
              <div className="mb-6">
                <UpdateBanner />
              </div>

              {/* Above every screen rather than on each of them: whichever one
                  you are looking at, the first thing worth knowing is whose
                  machine it belongs to. Renders nothing when the answer is
                  "this one". */}
              <HostBanner />

              {/* The home screen is this machine's, and only this machine's -
                  the logo, the agent prompt and the settings are all about the
                  install you are sitting at. A host's home is its repositories
                  and nothing else, which is what `#/h/<instance>/` means. */}
              {route.name === 'repositories' &&
                (route.host === undefined ? <HomeScreen /> : <RepositoryList />)}
              {route.name === 'agent' && <AgentAccessPage />}
              {route.name === 'hosts' && <HostsPage />}
              {route.name === 'repository' && (
                <RepositoryDetail repositoryId={route.repositoryId} />
              )}
              {route.name === 'review' && (
                <ReviewDetail reviewId={route.reviewId} tab={route.tab} focus={route.focus} />
              )}
            </main>

            <ScrollToTop target={scroller} />
            <CommandCenter scroller={scroller} />
          </div>
        </CommandRegistryProvider>
      </HostScopeProvider>
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
        <HostsCard />
        <AgentAccessCard />
        <SettingsPanel />
      </div>
    </>
  )
}
