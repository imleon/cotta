import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { healthResponseSchema, type HealthResponse } from '@cotta/shared'
import './styles.css'

async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health')
  if (!response.ok) {
    throw new Error(`Health request failed: ${response.status}`)
  }
  return healthResponseSchema.parse(await response.json())
}

function App() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: false,
  })

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Cotta v2</p>
        <h1>Claude Code Project Dashboard</h1>
        <p className="lede">
          MVP skeleton for the Web-first continuation layer described in docs/product-goal-v2.md.
        </p>
        <div className="status-card">
          <span>Server health</span>
          <strong>
            {health.isLoading ? 'checking…' : health.isError ? 'unavailable' : (health.data?.service ?? 'unknown')}
          </strong>
        </div>
      </section>
    </main>
  )
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
