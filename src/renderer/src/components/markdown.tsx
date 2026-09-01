/**
 * Renders a user-written body as markdown.
 *
 * There is exactly one of these, and every place that displays authored text
 * goes through it - comment bodies, review descriptions, and the composer's
 * preview. That is not tidiness: a preview rendered by a second code path would
 * drift from the real thing, and a preview that lies about what you are about
 * to post is worse than having no preview at all.
 *
 * It also matters that most of this text is not typed by the person using the
 * app. Comment bodies arrive over MCP from coding agents, who write markdown by
 * reflex - `**bold**`, bullet lists, fenced code - so rendering it is a bug fix
 * on output the app already produces, not a new feature.
 *
 * ## Raw HTML is not rendered, and there is no sanitiser
 *
 * `rehype-raw` is deliberately absent. react-markdown does not render embedded
 * HTML unless you add it, which means there is no sanitiser to configure and
 * therefore none to misconfigure. This is a real boundary rather than a
 * formality: an agent writing a comment here may have just read untrusted
 * content out of the repository under review, and its comment is stored and
 * replayed into this window. Losing GitHub's inline-HTML subset is a fair price
 * for a class of bug that cannot occur.
 *
 * ## Images are not fetched from the network
 *
 * Only `gitwarren://attachment/...` tokens - files this app copied into its own
 * store - are drawn inline. Every other image URL renders as a visible link.
 * A remote `<img>` would let an agent-authored comment phone home on being
 * read, and the renderer's CSP has no remote `img-src` precisely so that it
 * cannot; rendering the link instead means the reader still sees that an image
 * was referenced, and still gets to decide whether to open it.
 *
 * Repo-relative paths land in the same branch. Rendering those live against the
 * repository is worth doing later, but it needs repository context down here
 * that the renderer does not have, so for now they read as links rather than as
 * broken image icons.
 */
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

/**
 * Let attachment tokens through the URL filter, and nothing else new.
 *
 * react-markdown strips URLs whose protocol it does not recognise, which is the
 * behaviour that keeps `javascript:` out of an href - so the default is kept
 * for every other URL and only `gitwarren:` is added. The scheme resolves to a
 * file this app copied into its own store and serves itself; see
 * `registerAttachmentProtocol` in `main/index.ts`.
 */
function urlTransform(url: string): string {
  return url.startsWith('gitwarren://attachment/') ? url : defaultUrlTransform(url)
}

/**
 * The app's own type scale, applied element by element.
 *
 * `@tailwindcss/typography` would be the quick way to get here, but `prose`
 * brings its own scale, colours and spacing, and this text sits inside cards
 * that already have one. Writing the overrides out keeps comment bodies looking
 * like part of the app rather than like an article pasted into it.
 */
const components: Components = {
  h1: ({ className, ...props }) => (
    <h1 className={cn('mt-4 mb-2 text-base font-semibold first:mt-0', className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cn('mt-4 mb-2 text-base font-semibold first:mt-0', className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cn('mt-3 mb-1.5 text-sm font-semibold first:mt-0', className)} {...props} />
  ),
  h4: ({ className, ...props }) => (
    <h4 className={cn('mt-3 mb-1.5 text-sm font-semibold first:mt-0', className)} {...props} />
  ),
  h5: ({ className, ...props }) => (
    <h5 className={cn('mt-3 mb-1.5 text-sm font-semibold first:mt-0', className)} {...props} />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn('mt-3 mb-1.5 text-sm font-semibold text-muted-foreground first:mt-0', className)}
      {...props}
    />
  ),

  p: ({ className, ...props }) => (
    <p className={cn('my-2 leading-relaxed first:mt-0 last:mb-0', className)} {...props} />
  ),

  // `li:has(> input)` is the task-list case: GFM renders a checkbox as the
  // item's first child, and a bullet next to a checkbox reads as noise.
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        'my-2 ml-5 list-disc space-y-1 first:mt-0 last:mb-0',
        '[&_li:has(>input)]:ml-[-1.15rem] [&_li:has(>input)]:list-none',
        className
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn('my-2 ml-5 list-decimal space-y-1 first:mt-0 last:mb-0', className)} {...props} />
  ),
  li: ({ className, ...props }) => <li className={cn('leading-relaxed', className)} {...props} />,

  // Task-list checkboxes stay disabled. Ticking one here would have to write
  // back to the body to mean anything, and a click that silently does nothing
  // is worse than a control that is visibly not offered.
  input: ({ className, ...props }) =>
    props.type === 'checkbox' ? (
      <input
        className={cn('mr-1.5 translate-y-[1px] align-baseline accent-primary', className)}
        {...props}
        disabled
      />
    ) : null,

  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        'my-2 border-l-2 border-border pl-3 text-muted-foreground first:mt-0 last:mb-0',
        className
      )}
      {...props}
    />
  ),

  // Inline code is styled here; the `pre` override below strips this styling
  // back off again for fenced blocks. react-markdown stopped passing an
  // `inline` flag in v9, and "reset it inside pre" is more robust than
  // reconstructing that flag from the node's parent.
  code: ({ className, ...props }) => (
    <code
      className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]', className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        'my-2 overflow-x-auto rounded-md border border-border bg-muted/50 p-3 first:mt-0 last:mb-0',
        'font-mono text-xs leading-relaxed',
        '[&_code]:block [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-xs',
        className
      )}
      {...props}
    />
  ),

  // `target="_blank"` is what routes the click to the real browser: the main
  // process answers it in `setWindowOpenHandler` with `shell.openExternal`.
  // Without it the link would navigate the app window away from the app.
  a: ({ className, ...props }) => (
    <a
      target="_blank"
      rel="noreferrer noopener"
      className={cn('text-primary underline underline-offset-2 hover:no-underline', className)}
      {...props}
    />
  ),

  img: ({ src, alt, title, className, ...props }) => {
    const url = typeof src === 'string' ? src : ''
    if (!url.startsWith('gitwarren://')) {
      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          title={title ?? url}
          className="text-primary underline underline-offset-2 hover:no-underline"
        >
          {alt && alt.length > 0 ? alt : url}
        </a>
      )
    }
    return (
      <img
        src={url}
        alt={alt ?? ''}
        title={title}
        className={cn('my-2 max-w-full rounded-md border border-border', className)}
        {...props}
      />
    )
  },

  hr: ({ className, ...props }) => (
    <hr className={cn('my-3 border-t border-border', className)} {...props} />
  ),

  // A wide table has to scroll inside itself; letting it widen the card would
  // push the whole conversation column sideways.
  table: ({ className, ...props }) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table className={cn('w-full border-collapse text-left', className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn('border border-border bg-muted/50 px-2 py-1 font-semibold', className)}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td className={cn('border border-border px-2 py-1 align-top', className)} {...props} />
  )
}

interface MarkdownProps {
  body: string
  className?: string
}

export function Markdown({ body, className }: MarkdownProps) {
  return (
    // `data-selectable` sits on the wrapper rather than on each element: the
    // app sets `user-select: none` on the body (see index.css), and user-select
    // inherits, so marking the container makes the whole rendered body
    // selectable the way the plain-text version was.
    <div data-selectable className={cn('text-sm break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {body}
      </ReactMarkdown>
    </div>
  )
}
