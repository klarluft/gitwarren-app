/**
 * A folder picker for a filesystem this window cannot see.
 *
 * `repository-form-dialog.tsx` has carried a comment since M3 saying that a
 * browser tab has no `pickDirectory` and that a native picker on a remote host
 * would browse the wrong machine. This is that comment made real, and the shape
 * follows from the two cases rather than from wanting a nicer picker:
 *
 * - In a **browser tab** there is no shell dialog to open at all. The core is
 *   on the same machine as the files, so a listing is one method call.
 * - On a **remote host** there is a shell dialog, and using it would be worse
 *   than not having one: it would show this Mac's folders and produce a path
 *   `pc-wsl` has never heard of. The native picker is *withheld* here even
 *   though the shell has one, which is the case that proves this cannot just be
 *   a capability fallback.
 *
 * ## One column, not a tree
 *
 * A tree is the obvious shape and the wrong one over a connection. Every
 * expanded node is a round trip, an open tree is a screenful of them, and the
 * thing being looked for is one folder rather than a structure worth
 * understanding. So: one folder at a time, its parent above it, and the path
 * always visible and always editable - because for someone who knows where they
 * are going, typing it is faster than any number of clicks, and on a machine
 * with a hundred repositories under `~/github.com` it is the only reasonable
 * way in.
 *
 * The `.git` badge is the whole reason this beats a text field. It answers "is
 * this the folder I want" without descending into it, and it is why a listing
 * carries `isRepository` rather than the screen guessing from a name.
 */
import { useState, type FormEvent } from 'react'
import useSWR from 'swr'
import { AlertCircle, ChevronRight, CornerLeftUp, Folder, House, Loader2 } from 'lucide-react'
import { Breakable } from '@/components/breakable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CACHE_KEYS } from '@/lib/api'
import { errorMessage } from '@/lib/errors'
import { useApi, useHost } from '@/lib/host-scope'
import type { DirectoryListing } from '@shared/schemas'

interface DirectoryBrowserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Where to start. Absent starts at the answering machine's home directory. */
  initialPath?: string | undefined
  /** Called with an absolute path on the machine being browsed. */
  onChoose: (path: string) => void
}

export function DirectoryBrowserDialog({
  open,
  onOpenChange,
  initialPath,
  onChoose
}: DirectoryBrowserDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted only while open, so each opening starts from wherever the
            form's path field points now rather than from wherever the last
            visit wandered to. Same trick the repository form uses. */}
        {open && (
          <Browser
            initialPath={initialPath}
            onChoose={(path) => {
              onChoose(path)
              onOpenChange(false)
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Browser({
  initialPath,
  onChoose,
  onCancel
}: {
  initialPath: string | undefined
  onChoose: (path: string) => void
  onCancel: () => void
}) {
  const api = useApi()
  const host = useHost()

  // `undefined` means "wherever you start", which the answering machine
  // decides. Kept distinct from the empty string so that clearing the field
  // does not silently mean "home" while the field says otherwise.
  const [path, setPath] = useState<string | undefined>(initialPath)
  const [typed, setTyped] = useState(initialPath ?? '')
  const [showHidden, setShowHidden] = useState(false)

  const { data, error, isLoading } = useSWR<DirectoryListing, unknown>(
    CACHE_KEYS.directory(path, host),
    () => api.fs.list(path === undefined ? {} : { path }),
    // The filesystem is not something to poll. A person who has just made a
    // folder in another window presses Go, which re-reads.
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true }
  )

  function go(next: string): void {
    setPath(next)
    setTyped(next)
  }

  function submitTyped(event: FormEvent): void {
    event.preventDefault()
    const trimmed = typed.trim()
    // An empty field means home, which is where an empty `path` starts. Saying
    // so is better than refusing an empty box.
    setPath(trimmed === '' ? undefined : trimmed)
  }

  const entries = (data?.entries ?? []).filter((entry) => showHidden || !entry.isHidden)
  const hiddenCount = (data?.entries ?? []).length - entries.length

  return (
    <>
      <DialogHeader>
        <DialogTitle>Choose a folder</DialogTitle>
        <DialogDescription>
          {host === undefined
            ? 'Folders on this computer. A repository is marked; a subfolder of one works too.'
            : // Named rather than "on the host": the sentence is the reminder
              // that these are not this machine's folders.
              'Folders on the machine this list belongs to. A repository is marked.'}
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-col gap-3">
        <form onSubmit={submitTyped} className="flex gap-2" noValidate>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={data?.home ?? '/path/to/folder'}
            className="font-mono text-xs"
            aria-label="Folder to list"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" variant="outline" className="shrink-0">
            Go
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              setPath(undefined)
              setTyped('')
            }}
          >
            <House />
            Home
          </Button>
          {/* Absent at the root of the filesystem, where there is nothing
              above: `parent` being null is the listing saying so. */}
          {data?.parent && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => go(data.parent as string)}
            >
              <CornerLeftUp />
              Up
            </Button>
          )}
          <span className="flex-1" />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={showHidden} onCheckedChange={setShowHidden} />
            Hidden
            {hiddenCount > 0 && !showHidden && <span>({hiddenCount})</span>}
          </label>
        </div>

        {error !== undefined && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <Breakable text={errorMessage(error)} />
          </p>
        )}

        {/* A fixed height rather than one that grows with the folder: a dialog
            that is three rows tall in one directory and fills the screen in the
            next makes the buttons under it move while someone is clicking. */}
        <ul className="h-64 overflow-y-auto rounded-md border">
          {isLoading && (
            <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Reading…
            </li>
          )}
          {!isLoading && entries.length === 0 && error === undefined && (
            <li className="px-3 py-2 text-sm text-muted-foreground">
              {hiddenCount > 0 ? 'Only hidden folders in here.' : 'No folders in here.'}
            </li>
          )}
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                onClick={() => go(entry.path)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.isRepository && (
                  <Badge variant="outline" className="shrink-0">
                    repository
                  </Badge>
                )}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>

        {data?.truncated && (
          <p className="text-xs text-muted-foreground">
            Only the first folders are listed. Type a path above to go straight there.
          </p>
        )}

        {data && (
          <p data-selectable className="break-words font-mono text-xs text-muted-foreground">
            <Breakable text={data.path} />
          </p>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {/* Chooses the folder being *looked at*, not a highlighted row. Rows
            navigate, because that is what a folder in a picker mostly means,
            and "the one I am in" is unambiguous in a way a selection that
            survives a navigation is not. */}
        <Button type="button" disabled={!data} onClick={() => data && onChoose(data.path)}>
          Use this folder
        </Button>
      </DialogFooter>
    </>
  )
}
