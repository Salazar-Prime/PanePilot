import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  Files,
  History,
  Network,
  SquareTerminal,
} from 'lucide-react';

const features = [
  {
    icon: SquareTerminal,
    title: 'Persistent workspaces',
    description:
      'Run shells, Codex, Claude Code, and custom commands locally or over SSH, with tmux persistence when available.',
  },
  {
    icon: Bot,
    title: 'Attention at a glance',
    description:
      'See which agent terminals are working or need review without walking through every open session.',
  },
  {
    icon: Files,
    title: 'Project context',
    description:
      'Browse and edit bounded project files, open discovered repositories, and search local or remote provider archives.',
  },
  {
    icon: Network,
    title: 'Remote control',
    description:
      'Import SSH aliases, browse remote folders, test connections, and manage loopback-only port forwards.',
  },
];

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <div className="hero-grid pointer-events-none absolute inset-0" />
      <div className="hero-glow pointer-events-none absolute inset-0" />

      <section className="relative mx-auto flex w-full max-w-6xl flex-col px-6 pb-16 pt-20 md:pt-28">
        <div className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border bg-fd-card/80 px-3 py-1.5 text-xs text-fd-muted-foreground">
          <History className="size-3.5 text-indigo-400" />
          Documentation reflects the repository as of July 23, 2026
        </div>
        <h1 className="max-w-4xl text-balance text-5xl font-semibold tracking-[-0.045em] md:text-7xl">
          Keep every project and agent{' '}
          <span className="bg-gradient-to-r from-indigo-400 to-cyan-300 bg-clip-text text-transparent">
            in view.
          </span>
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-fd-muted-foreground">
          PanePilot is a desktop control center for local and SSH projects worked on by
          people and coding agents. This site explains the product, its current
          behavior, and the architecture behind it.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/docs"
            className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-4 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Read the docs <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/docs/getting-started"
            className="inline-flex items-center gap-2 rounded-lg border bg-fd-card px-4 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            Run PanePilot
          </Link>
        </div>

        <div className="signal-strip mt-12" aria-label="Terminal status examples">
          <span className="signal-pill running">Working</span>
          <span className="signal-pill attention">Needs attention</span>
          <span className="signal-pill ready">Ready</span>
          <span className="signal-pill error">Error</span>
        </div>

        <div className="mt-16 grid gap-4 md:grid-cols-2">
          {features.map(({ icon: Icon, title, description }) => (
            <article className="feature-card" key={title}>
              <div className="feature-icon">
                <Icon aria-hidden="true" />
              </div>
              <h2 className="mt-4 text-lg font-semibold">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
                {description}
              </p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
