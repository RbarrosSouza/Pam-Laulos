import { Component, type ReactNode } from 'react'

/** A lazy module can reject on a lost connection or an obsolete deploy chunk. */
export class RouteBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  render() {
    if (!this.state.failed) return this.props.children
    return <section role="alert" className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-balance text-xl font-semibold">Não foi possível abrir esta tela.</h1>
      <p className="mt-3 text-pretty text-sm text-[hsl(var(--muted-foreground))]">Tente recarregar esta página.</p>
      <button type="button" onClick={() => window.location.reload()} className="mt-6 min-h-12 rounded-xl bg-[hsl(var(--foreground))] px-6 text-sm font-semibold text-[hsl(var(--background))]">Recarregar</button>
    </section>
  }
}
