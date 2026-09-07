/**
 * The branch/tag picker used for both endpoints of a review.
 *
 * Refs are grouped the way a reviewer thinks about them - local branches first,
 * then remotes, then tags - and each local branch says whether it is checked out
 * somewhere and whether that worktree is dirty. Surfacing the dirty flag *here*,
 * before the review exists, is the point: it is how the user discovers there is
 * uncommitted work they could be reviewing.
 *
 * It is a combobox rather than a plain select for two reasons that only show up
 * on a real repository. A checkout with a hundred branches is not navigable by
 * scrolling, so the popup opens with a search field and scores against the same
 * fuzzy matcher as the command palette - "wsc" finds `worktree-self-compare`,
 * and the matched characters are marked so the hit explains itself. And branch
 * names are long, while the field holding them is half of a dialog, so the
 * popup takes a width of its own and rows *wrap* instead of truncating: the one
 * place the full name is guaranteed legible is the place you pick it.
 */
import { CircleDot, GitBranch, Tag } from 'lucide-react'
import { useMemo, useState } from 'react'
import { HighlightedText } from '@/components/highlighted-text'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue
} from '@/components/ui/combobox'
import { fuzzyMatch } from '@/lib/fuzzy'
import type { GitRef } from '@shared/git'

interface RefSelectProps {
  id: string
  refs: GitRef[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  invalid?: boolean
}

const GROUPS = [
  { kind: 'local-branch' as const, label: 'Branches', icon: GitBranch },
  { kind: 'remote-branch' as const, label: 'Remote branches', icon: GitBranch },
  { kind: 'tag' as const, label: 'Tags', icon: Tag }
]

/** One group as Base UI wants it: a `value` to key on and its `items`. */
interface RefGroup {
  value: string
  items: string[]
}

export function RefSelect({ id, refs, value, onChange, disabled, invalid }: RefSelectProps) {
  const [query, setQuery] = useState('')

  // Names alone are the item values, so selection stays a plain string and the
  // trigger can render a ref that has since been deleted. Everything the rows
  // need beyond the name is looked up here.
  const byName = useMemo(() => {
    const map = new Map<string, GitRef>()
    for (const ref of refs) map.set(ref.name, ref)
    return map
  }, [refs])

  const allGroups = useMemo<RefGroup[]>(
    () =>
      GROUPS.map(({ kind, label }) => ({
        value: label,
        items: refs.filter((ref) => ref.kind === kind).map((ref) => ref.name)
      })).filter((group) => group.items.length > 0),
    [refs]
  )

  // Filtering is ours rather than the primitive's so the ranking and the
  // highlight positions come from the same pass: within a group the best match
  // rises to the top, and each row is told which characters to mark.
  const { groups, marks } = useMemo(() => {
    const trimmed = query.trim()
    if (trimmed === '') return { groups: allGroups, marks: new Map<string, number[]>() }

    const hits = new Map<string, number[]>()
    const filtered: RefGroup[] = []

    for (const group of allGroups) {
      const scored: { name: string; score: number }[] = []
      for (const name of group.items) {
        const match = fuzzyMatch(trimmed, name)
        if (match === null) continue
        hits.set(name, match.indices)
        scored.push({ name, score: match.score })
      }
      if (scored.length === 0) continue

      scored.sort((a, b) => b.score - a.score)
      filtered.push({ value: group.value, items: scored.map((entry) => entry.name) })
    }

    return { groups: filtered, marks: hits }
  }, [allGroups, query])

  const iconFor = (name: string): typeof GitBranch =>
    byName.get(name)?.kind === 'tag' ? Tag : GitBranch

  return (
    <Combobox
      items={allGroups}
      filteredItems={groups}
      value={value}
      onValueChange={(next) => onChange(typeof next === 'string' ? next : '')}
      onInputValueChange={setQuery}
      disabled={disabled}
    >
      <ComboboxTrigger id={id} data-invalid={invalid ? '' : undefined}>
        {/* The trigger is as narrow as the field, so the full name lives in a
            `title` for the times the user only wants to read it. */}
        <span className="min-w-0 truncate font-mono text-xs" title={value || undefined}>
          <ComboboxValue placeholder="Pick a ref" />
        </span>
      </ComboboxTrigger>

      <ComboboxContent minWidth="26rem" aria-label="Select a branch or tag">
        <ComboboxInput placeholder="Search branches and tags" />
        <ComboboxEmpty>No branch or tag matches that.</ComboboxEmpty>
        <ComboboxList>
          {(group: RefGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxGroupLabel>{group.value}</ComboboxGroupLabel>
              <ComboboxCollection>
                {(name: string) => {
                  const ref = byName.get(name)
                  const Icon = iconFor(name)

                  return (
                    <ComboboxItem key={name} value={name}>
                      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      {/* Wrapping rather than truncating: a branch name that
                          does not fit runs onto a second line, so it is never
                          half-shown. `HighlightedText` breaks it at its
                          slashes rather than mid-segment. */}
                      <span className="min-w-0 flex-1 break-words font-mono text-xs">
                        <HighlightedText text={name} indices={marks.get(name) ?? []} />
                      </span>
                      {ref?.hasUncommittedChanges && (
                        <span
                          className="mt-0.5 flex shrink-0 items-center gap-1 text-[0.6875rem] font-medium text-warning"
                          title={`Uncommitted changes in ${ref.checkedOutAt ?? 'its worktree'}`}
                        >
                          <CircleDot className="size-3" />
                          uncommitted
                        </span>
                      )}
                    </ComboboxItem>
                  )
                }}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
