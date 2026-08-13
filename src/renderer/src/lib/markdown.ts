import GithubSlugger from 'github-slugger'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { Marked, Renderer, TextRenderer, type Tokens } from 'marked'

const ALERT_TYPES = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const

export type MarkdownAlertType = (typeof ALERT_TYPES)[number]

export type MarkdownTarget =
  | { kind: 'external'; url: string }
  | { kind: 'fragment'; fragment: string }
  | { kind: 'project'; path: string; fragment: string | null }
  | { kind: 'unsupported' }

const languageRegistrations = {
  bash,
  c,
  cpp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  ruby,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml
}

for (const [name, language] of Object.entries(languageRegistrations)) {
  hljs.registerLanguage(name, language)
}

hljs.registerAliases(['sh', 'zsh', 'console'], { languageName: 'shell' })
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['md', 'mdown'], { languageName: 'markdown' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['rb'], { languageName: 'ruby' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })

export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path)
}

export function renderMarkdownDocument(source: string): string {
  const slugger = new GithubSlugger()
  const renderer = new Renderer()

  renderer.heading = function ({ tokens, depth }: Tokens.Heading): string {
    const content = this.parser.parseInline(tokens)
    const label = this.parser.parseInline(tokens, new TextRenderer())
    const slug = slugger.slug(label)
    return `<h${depth} id="${escapeAttribute(slug)}"><a class="markdown-heading-anchor" href="#${escapeAttribute(slug)}" aria-label="Link to ${escapeAttribute(label)}"><span aria-hidden="true">#</span></a>${content}</h${depth}>\n`
  }

  renderer.code = function ({ text, lang }: Tokens.Code): string {
    const requestedLanguage = lang?.trim().split(/\s+/)[0] ?? ''
    const language = requestedLanguage && hljs.getLanguage(requestedLanguage)
      ? requestedLanguage
      : null
    const rendered = language
      ? hljs.highlight(text, { language }).value
      : escapeHtml(text)
    const languageClass = language
      ? ` language-${escapeAttribute(language)}`
      : ''
    return `<pre><code class="hljs${languageClass}">${rendered}</code></pre>\n`
  }

  renderer.blockquote = function (token: Tokens.Blockquote): string {
    const match = token.text.match(
      new RegExp(`^\\[!(${ALERT_TYPES.join('|')})\\](?:\\r?\\n|$)`, 'i')
    )
    if (!match) return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`
    const type = match[1].toLocaleUpperCase() as MarkdownAlertType
    const body = this.parser
      .parse(token.tokens)
      .replace(new RegExp(`\\[!${type}\\]\\s*`, 'i'), '')
    const label = titleCase(type)
    return `<div class="markdown-alert markdown-alert-${type.toLocaleLowerCase()}"><p class="markdown-alert-title"><span class="markdown-alert-icon" aria-hidden="true">!</span>${label}</p>${body}</div>\n`
  }

  renderer.link = function ({ href, title, tokens }: Tokens.Link): string {
    const titleAttribute = title
      ? ` title="${escapeAttribute(title)}"`
      : ''
    return `<a href="${escapeAttribute(href)}" data-markdown-href="${escapeAttribute(href)}"${titleAttribute}>${this.parser.parseInline(tokens)}</a>`
  }

  renderer.image = function ({ href, title, text }: Tokens.Image): string {
    const titleAttribute = title
      ? ` title="${escapeAttribute(title)}"`
      : ''
    return `<img data-markdown-src="${escapeAttribute(href)}" alt="${escapeAttribute(text)}"${titleAttribute} loading="lazy" decoding="async">`
  }

  const parser = new Marked()
  parser.setOptions({
    async: false,
    breaks: false,
    gfm: true,
    pedantic: false,
    renderer
  })
  return parser.parse(source, { async: false })
}

export function resolveMarkdownTarget(
  markdownPath: string,
  rawHref: string
): MarkdownTarget {
  const href = rawHref.trim()
  if (!href) return { kind: 'unsupported' }

  if (href.startsWith('#')) {
    return { kind: 'fragment', fragment: decodeFragment(href.slice(1)) }
  }

  if (href.startsWith('//')) {
    return { kind: 'external', url: `https:${href}` }
  }

  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(href)) {
    try {
      const url = new URL(href)
      return ['http:', 'https:'].includes(url.protocol)
        ? { kind: 'external', url: url.toString() }
        : { kind: 'unsupported' }
    } catch {
      return { kind: 'unsupported' }
    }
  }

  const hashIndex = href.indexOf('#')
  const rawFragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : null
  const withoutFragment = hashIndex >= 0 ? href.slice(0, hashIndex) : href
  const rawPath = withoutFragment.split('?')[0]
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawPath).replaceAll('\\', '/')
  } catch {
    return { kind: 'unsupported' }
  }
  if (!decodedPath) {
    return {
      kind: 'project',
      path: markdownPath.replaceAll('\\', '/'),
      fragment: rawFragment == null ? null : decodeFragment(rawFragment)
    }
  }

  const base = decodedPath.startsWith('/')
    ? []
    : markdownPath.replaceAll('\\', '/').split('/').slice(0, -1)
  for (const part of decodedPath.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (base.length === 0) return { kind: 'unsupported' }
      base.pop()
      continue
    }
    base.push(part)
  }
  const path = base.join('/')
  if (!path) return { kind: 'unsupported' }
  return {
    kind: 'project',
    path,
    fragment: rawFragment == null ? null : decodeFragment(rawFragment)
  }
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLocaleLowerCase()
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('`', '&#96;')
}
