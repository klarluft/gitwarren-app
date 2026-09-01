/**
 * The branch/tag picker used for both endpoints of a review.
 *
 * Refs are grouped the way a reviewer thinks about them - local branches first,
 * then remotes, then tags - and each local branch says whether it is checked out
 * somewhere and whether that worktree is dirty. Surfacing the dirty flag *here*,
 * before the review exists, is the point: it is how the user discovers there is
 * uncommitted work they could be reviewing.
 */
import { CircleDot, GitBranch, Tag } from 'lucide-react'
import { useMemo } from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
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

export function RefSelect({ id, refs, value, onChange, disabled, invalid }: RefSelectProps) {
  // `items` is what lets the trigger render the chosen ref's label rather than
  // its raw value; it also keeps a since-deleted ref displayable.
  const items = useMemo(
    () => refs.map((ref) => ({ value: ref.name, label: ref.name })),
    [refs]
  )

  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onChange(typeof next === 'string' ? next : '')}
      disabled={disabled}
    >
      <SelectTrigger id={id} data-invalid={invalid ? '' : undefined}>
        <SelectValue className="truncate font-mono text-xs" />
      </SelectTrigger>
      <SelectContent>
        {GROUPS.map(({ kind, label, icon: Icon }) => {
          const group = refs.filter((ref) => ref.kind === kind)
          if (group.length === 0) return null

          return (
            <SelectGroup key={kind}>
              <SelectGroupLabel>{label}</SelectGroupLabel>
              {group.map((ref) => (
                <SelectItem key={ref.fullName} value={ref.name}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs">{ref.name}</span>
                    {ref.hasUncommittedChanges && (
                      <span
                        className="flex shrink-0 items-center gap-1 text-[0.6875rem] font-medium text-warning"
                        title={`Uncommitted changes in ${ref.checkedOutAt ?? 'its worktree'}`}
                      >
                        <CircleDot className="size-3" />
                        uncommitted
                      </span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          )
        })}
      </SelectContent>
    </Select>
  )
}
