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
 * That is still true in a browser tab, where the token is rewritten to a path
 * on the page's own origin: `img-src 'self'` is not a loosening of the rule but
 * the same rule spelled the way that shell spells it.
 *
 * Repo-relative paths land in the same branch. Rendering those live against the
 * repository is worth doing later, but it needs repository context down here
 * that the renderer does not have, so for now they read as links rather than as
 * broken image icons.
 */
import { useMemo, useState, type ComponentProps } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ExternalLink } from 'lucide-react'
import { ATTACHMENT_URL_PREFIX } from '@shared/attachments'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useApi } from '@/lib/host-scope'
import { languageForFence, type LanguageId } from '@/lib/highlight/languages'
import { segmentLine } from '@/lib/highlight/segments'
import { renderPieces, useHighlightedBlocks } from '@/lib/highlight/use-highlight'
import { cn } from '@/lib/utils'

/**
 * Let attachment tokens through the URL filter, and nothing else new.
 *
 * react-markdown strips URLs whose protocol it does not recognise, which is the
 * behaviour that keeps `javascript:` out of an href - so the default is kept
 * for every other URL and only `gitwarren:` is added. The token names a file
 * this app copied into its own store and serves itself, over a custom scheme in
 * the window (`main/attachment-protocol.ts`) and over HTTP in a browser tab
 * (`core/web/attachments.ts`).
 */
function urlTransform(url: string): string {
  return url.startsWith(ATTACHMENT_URL_PREFIX) ? url : defaultUrlTransform(url)
}

/**
 * The app's own type scale, applied element by element.
 *
 * `@tailwindcss/typography` would be the quick way to get here, but `prose`
 * brings its own scale, colours and spacing, and this text sits inside cards
 * that already have one. Writing the overrides out keeps comment bodies looking
 * like part of the app rather than like an article pasted into it.
 *
 * Every override destructures `node` away before spreading the rest. That is
 * not decoration: react-markdown sets `passNode: true` unconditionally, so each
 * component is handed the mdast node alongside its real props, and spreading it
 * onto a DOM element makes React warn about an unrecognised attribute - once
 * per element, on every comment rendered.
 */
const components: Components = {
  h1: ({ node: _node, className, ...props }) => (
    <h1 className={cn('mt-4 mb-2 text-base font-semibold first:mt-0', className)} {...props} />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2 className={cn('mt-4 mb-2 text-base font-semibold first:mt-0', className)} {...props} />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3 className={cn('mt-3 mb-1.5 text-sm font-semibold first:mt-0', className)} {...props} />
  ),
  h4: ({ node: _node, className, ...props }) => (
    <h4 className={cn('mt-3 mb-1.5 text-sm font-semibold first:mt-0', className)} {...props} />
  ),
  h5: ({ node: _node, className, ...props }) => (
    <h5 className={cn('mt-3 mb-1.5 text-sm font-semibold first:mt-0', className)} {...props} />
  ),
  h6: ({ node: _node, className, ...props }) => (
    <h6
      className={cn('mt-3 mb-1.5 text-sm font-semibold text-muted-foreground first:mt-0', className)}
      {...props}
    />
  ),

  p: ({ node: _node, className, ...props }) => (
    <p className={cn('my-2 leading-relaxed first:mt-0 last:mb-0', className)} {...props} />
  ),

  // `li:has(> input)` is the task-list case: GFM renders a checkbox as the
  // item's first child, and a bullet next to a checkbox reads as noise.
  ul: ({ node: _node, className, ...props }) => (
    <ul
      className={cn(
        'my-2 ml-5 list-disc space-y-1 first:mt-0 last:mb-0',
        '[&_li:has(>input)]:ml-[-1.15rem] [&_li:has(>input)]:list-none',
        className
      )}
      {...props}
    />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol className={cn('my-2 ml-5 list-decimal space-y-1 first:mt-0 last:mb-0', className)} {...props} />
  ),
  li: ({ node: _node, className, ...props }) => <li className={cn('leading-relaxed', className)} {...props} />,

  // Task-list checkboxes stay disabled. Ticking one here would have to write
  // back to the body to mean anything, and a click that silently does nothing
  // is worse than a control that is visibly not offered.
  input: ({ node: _node, className, ...props }) =>
    props.type === 'checkbox' ? (
      <input
        className={cn('mr-1.5 translate-y-[1px] align-baseline accent-primary', className)}
        {...props}
        disabled
      />
    ) : null,

  blockquote: ({ node: _node, className, ...props }) => (
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
  //
  // A fence that names a language - ```ts - is coloured the way GitHub colours
  // it, with the same grammars and theme as the diff. remark puts the name in
  // a `language-*` class, and only fenced blocks get one.
  code: ({ node: _node, className, children, ...props }) => {
    const fence = /(?:^|\s)language-(\S+)/.exec(className ?? '')?.[1]
    const lang = fence === undefined ? null : languageForFence(fence)
    const styles = cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]', className)

    if (lang !== null && typeof children === 'string') {
      return <FencedCode language={lang} code={children} className={styles} {...props} />
    }
    return (
      <code className={styles} {...props}>
        {children}
      </code>
    )
  },
  pre: ({ node: _node, className, ...props }) => (
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
  a: ({ node: _node, className, ...props }) => (
    <a
      target="_blank"
      rel="noreferrer noopener"
      className={cn('text-primary underline underline-offset-2 hover:no-underline', className)}
      {...props}
    />
  ),

  img: ({ node: _node, src, alt, title, className, ...props }) => {
    const url = typeof src === 'string' ? src : ''
    if (!url.startsWith(ATTACHMENT_URL_PREFIX)) {
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
      <AttachmentImage url={url} alt={alt} title={title} className={className} {...props} />
    )
  },

  hr: ({ node: _node, className, ...props }) => (
    <hr className={cn('my-3 border-t border-border', className)} {...props} />
  ),

  // A wide table has to scroll inside itself; letting it widen the card would
  // push the whole conversation column sideways.
  table: ({ node: _node, className, ...props }) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table className={cn('w-full border-collapse text-left', className)} {...props} />
    </div>
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      className={cn('border border-border bg-muted/50 px-2 py-1 font-semibold', className)}
      {...props}
    />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td className={cn('border border-border px-2 py-1 align-top', className)} {...props} />
  )
}

/**
 * Whether a drawable `src` is also somewhere a browser tab can be sent.
 *
 * Asked of the URL rather than of the shell: in a tab the attachment is a path
 * on the page's own origin and a new tab can open it as it is, while in the
 * window it is the `gitwarren:` scheme, which only this renderer can resolve -
 * handed to the real browser it would come back to the OS as a deep link.
 */
function openableInTab(src: string): boolean {
  try {
    const { protocol } = new URL(src, window.location.href)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * One attachment, drawn from the store that holds it.
 *
 * A component of its own rather than an expression inside the `img` override,
 * because it needs `useApi()` and that is a hook. The hook is the point: the
 * api it hands back is bound to the machine this screen is about, so the `src`
 * is asked for on behalf of the right store without the body, the comment card
 * or anything between them learning that hosts exist. Before M4.4 this read the
 * module-scope `api`, which is always this install - which is precisely why an
 * image on a remote review rendered as a broken one.
 */
/**
 * A fenced block in its syntax colours. Drawn plain on the first frame and
 * coloured when the tokens land, like every other highlighted view.
 */
function FencedCode({
  language,
  code,
  ...props
}: { language: LanguageId; code: string } & Omit<ComponentProps<'code'>, 'children'>) {
  // The fence's own closing newline is not a line of code.
  const lines = useMemo(() => code.replace(/\n$/, '').split('\n'), [code])
  const blocks = useMemo(() => [lines], [lines])
  const tokens = useHighlightedBlocks(blocks, language)?.[0] ?? null

  return (
    <code {...props}>
      {lines.map((line, index) => (
        <span key={index}>
          {renderPieces(segmentLine(line, tokens?.[index] ?? null, [])[0]?.pieces ?? [])}
          {index < lines.length - 1 && '\n'}
        </span>
      ))}
    </code>
  )
}

function AttachmentImage({
  url,
  className,
  ...props
}: { url: string; className?: string } & Omit<
  React.ImgHTMLAttributes<HTMLImageElement>,
  'src' | 'className'
>) {
  const api = useApi()
  const [open, setOpen] = useState(false)
  // Fit to the screen, or every pixel the image has. On a desktop the fit is
  // usually enough; on a phone it is barely wider than the thumbnail, and
  // actual size - scrolled around inside the viewer - is what makes a
  // screenshot's text readable.
  const [actualSize, setActualSize] = useState(false)
  // The one place a stored token becomes something fetchable, and the only
  // place that differs between the two shells: the window has a custom scheme
  // registered and passes it through, a tab rewrites it to a path on its own
  // origin. Both attach the host the same way. See `ShellApi.attachmentSrc`.
  const src = api.attachments.src(url)
  const alt = props.alt ?? ''

  return (
    <>
      {/*
        A screenshot in a comment is drawn at the width of the card it sits in,
        which on a phone - or for a before/after pair side by side - is too
        small to read. Clicking it opens the same image as large as the screen
        allows, in the app rather than in a tab, because only a tab can open a
        tab: the window's `gitwarren:` source means nothing to the browser.

        A button rather than a link around the image, for the same reason - and
        `inline-block` so it hugs the image instead of claiming the paragraph's
        whole width as a click target.
      */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="View full size"
        className="my-2 inline-block max-w-full cursor-zoom-in rounded-md align-top"
      >
        <img
          src={src}
          className={cn('block max-w-full rounded-md border border-border', className)}
          {...props}
          alt={alt}
        />
      </button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setActualSize(false)
        }}
      >
        <DialogContent
          // Sized by the image, up to nearly the whole screen, rather than by
          // the dialog's usual reading width. Centred by its two edges rather
          // than by `left: 50%` and a translate: a box sized to its content at
          // `left: 50%` only ever has the right half of the screen to grow
          // into, and drew the image smaller than the thumbnail it enlarges.
          className="left-0 right-0 mx-auto flex w-fit max-w-[96vw] translate-x-0 flex-col gap-2 p-2 pt-10"
        >
          {/* The alt text is the title: it is what the author wrote to say what
              the picture shows, and a dialog needs a name either way. */}
          <DialogTitle className="absolute left-3 right-12 top-3 truncate text-sm font-medium leading-normal text-muted-foreground">
            {alt.length > 0 ? alt : 'Image'}
          </DialogTitle>
          {/* Fit to the screen and never enlarged past the pixels it has, until
              it is tapped; then actual size, scrolling inside this box. */}
          <div className="max-h-[calc(100dvh-7rem)] max-w-full overflow-auto">
            <img
              src={src}
              alt={alt}
              title={actualSize ? 'Fit to screen' : 'Actual size'}
              onClick={() => setActualSize(!actualSize)}
              className={cn(
                'mx-auto block rounded-md',
                actualSize
                  ? 'max-w-none cursor-zoom-out'
                  : 'max-h-[calc(100dvh-7rem)] max-w-full cursor-zoom-in object-contain'
              )}
            />
          </div>
          {openableInTab(src) && (
            <a
              href={src}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1.5 self-end px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              <ExternalLink className="size-3.5" />
              Open in new tab
            </a>
          )}
        </DialogContent>
      </Dialog>
    </>
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
