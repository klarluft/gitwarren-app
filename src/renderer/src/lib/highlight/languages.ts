/**
 * Which grammar a file is highlighted with, and where that grammar comes from.
 *
 * The list is curated rather than Shiki's whole catalogue on purpose. Shiki
 * ships some 240 grammars - ten megabytes, four times the size of the rest of
 * the renderer - and the same bundle is what `npx gitwarren serve` downloads.
 * The languages below cover what code review is overwhelmingly done on; a file
 * in anything else is shown exactly as it was before highlighting existed,
 * which is a fine answer for a language nobody here has asked for yet.
 *
 * Every grammar is a dynamic import, so a review of a Go service never
 * downloads the TypeScript grammar, and nothing at all is fetched until the
 * first highlighted line is drawn. Vite turns each `import()` into a chunk of
 * its own; a grammar that embeds others (Vue embeds CSS and TypeScript, HTML
 * embeds JavaScript) pulls them in through its own imports.
 *
 * DOM-free, so it is unit-tested under node.
 */
import type { LanguageRegistration } from 'shiki/core'

type GrammarModule = Promise<{ default: LanguageRegistration[] }>

/** Grammar id, in Shiki's spelling, to the import that loads it. */
export const GRAMMARS = {
  astro: () => import('shiki/langs/astro.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  clojure: () => import('shiki/langs/clojure.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  erlang: () => import('shiki/langs/erlang.mjs'),
  fsharp: () => import('shiki/langs/fsharp.mjs'),
  'git-commit': () => import('shiki/langs/git-commit.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  json5: () => import('shiki/langs/json5.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsonl: () => import('shiki/langs/jsonl.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  julia: () => import('shiki/langs/julia.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  nix: () => import('shiki/langs/nix.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  ocaml: () => import('shiki/langs/ocaml.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  solidity: () => import('shiki/langs/solidity.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  terraform: () => import('shiki/langs/terraform.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  zig: () => import('shiki/langs/zig.mjs')
} satisfies Record<string, () => GrammarModule>

export type LanguageId = keyof typeof GRAMMARS

/** Extension, lowercased and without its dot, to grammar. */
const EXTENSIONS: Record<string, LanguageId> = {
  astro: 'astro',
  bat: 'bat',
  cmd: 'bat',
  c: 'c',
  h: 'c',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  edn: 'clojure',
  cmake: 'cmake',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  ino: 'cpp',
  cs: 'csharp',
  csx: 'csharp',
  css: 'css',
  dart: 'dart',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'docker',
  env: 'dotenv',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  fs: 'fsharp',
  fsi: 'fsharp',
  fsx: 'fsharp',
  go: 'go',
  graphql: 'graphql',
  gql: 'graphql',
  groovy: 'groovy',
  gradle: 'groovy',
  hs: 'haskell',
  hcl: 'hcl',
  htm: 'html',
  html: 'html',
  xhtml: 'html',
  ini: 'ini',
  cfg: 'ini',
  properties: 'ini',
  java: 'java',
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  json: 'json',
  json5: 'json5',
  jsonc: 'jsonc',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  jsx: 'jsx',
  jl: 'julia',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  lua: 'lua',
  mk: 'make',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  nix: 'nix',
  m: 'objective-c',
  ml: 'ocaml',
  mli: 'ocaml',
  pl: 'perl',
  pm: 'perl',
  php: 'php',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  prisma: 'prisma',
  proto: 'proto',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  r: 'r',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  rs: 'rust',
  scala: 'scala',
  sc: 'scala',
  sbt: 'scala',
  scss: 'scss',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  fish: 'shellscript',
  ksh: 'shellscript',
  sol: 'solidity',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  tf: 'terraform',
  tfvars: 'terraform',
  toml: 'toml',
  tsx: 'tsx',
  ts: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  vue: 'vue',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  csproj: 'xml',
  xaml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zig: 'zig'
}

/**
 * Whole file names that say what they are without an extension, or in spite of
 * one. Matched lowercased, before the extension is looked at - `CMakeLists.txt`
 * is CMake, not plain text.
 */
const FILE_NAMES: Record<string, LanguageId> = {
  dockerfile: 'docker',
  containerfile: 'docker',
  makefile: 'make',
  gnumakefile: 'make',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  brewfile: 'ruby',
  vagrantfile: 'ruby',
  jenkinsfile: 'groovy',
  '.bashrc': 'shellscript',
  '.bash_profile': 'shellscript',
  '.profile': 'shellscript',
  '.zshrc': 'shellscript',
  '.zprofile': 'shellscript',
  '.env': 'dotenv',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  commit_editmsg: 'git-commit',
  'tsconfig.json': 'jsonc',
  'jsconfig.json': 'jsonc',
  '.eslintrc': 'jsonc',
  '.babelrc': 'jsonc',
  'devcontainer.json': 'jsonc',
  'settings.json': 'jsonc',
  'launch.json': 'jsonc',
  'tasks.json': 'jsonc',
  'extensions.json': 'jsonc'
}

/**
 * What a fenced code block's info string may say, beyond the extensions above
 * and the grammar ids themselves - the names people actually type after three
 * backticks.
 */
const FENCE_NAMES: Record<string, LanguageId> = {
  bash: 'shellscript',
  shell: 'shellscript',
  console: 'shellscript',
  shellsession: 'shellscript',
  golang: 'go',
  'c++': 'cpp',
  'c#': 'csharp',
  'f#': 'fsharp',
  dockerfile: 'docker',
  makefile: 'make',
  ps: 'powershell',
  pwsh: 'powershell',
  objc: 'objective-c',
  protobuf: 'proto',
  rb: 'ruby',
  py: 'python',
  python3: 'python',
  js: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  yml: 'yaml',
  terraform: 'terraform',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
  sqlite: 'sql',
  patch: 'diff',
  gitcommit: 'git-commit'
}

function isLanguageId(value: string): value is LanguageId {
  return Object.hasOwn(GRAMMARS, value)
}

/** The grammar for a path in the repository, or null to show it plain. */
export function languageForPath(path: string): LanguageId | null {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase()
  const byName = FILE_NAMES[name]
  if (byName) return byName

  // `.env.local`, `.env.production` and the rest of that family.
  if (name.startsWith('.env.')) return 'dotenv'
  // `Dockerfile.dev`, `api.Dockerfile`.
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'docker'

  const dot = name.lastIndexOf('.')
  // A leading dot is a hidden file, not an extension: `.gitignore` has none.
  if (dot <= 0) return null
  // `foo.d.ts` ends in `ts` like any other TypeScript file; nothing to special-case.
  return EXTENSIONS[name.slice(dot + 1)] ?? null
}

/**
 * The grammar named by a fenced code block's info string - ```ts, ```bash,
 * ```diff title="x" - or null for one with no language or an unknown one.
 */
export function languageForFence(info: string): LanguageId | null {
  const word = info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  if (word === '') return null
  if (isLanguageId(word)) return word
  return FENCE_NAMES[word] ?? EXTENSIONS[word] ?? null
}
