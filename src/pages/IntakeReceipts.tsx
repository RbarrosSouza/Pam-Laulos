import {useIntakePanel} from '@/hooks/useIntakePanel'
import { IntakeHeader, IntakeReceiptsView } from '@/components/intake/IntakeReceiptsView'
export function IntakeReceipts() {
  const query=useIntakePanel()
  if(query.data&&!query.isError)return <IntakeReceiptsView data={query.data} refreshing={query.isFetching} now={query.now} paused={query.snapshotPaused} onRefresh={()=>void query.refetch()}/>
  return <main className="mx-auto max-w-6xl space-y-6 p-4 md:p-8"><IntakeHeader refreshing={query.isFetching} onRefresh={()=>void query.refetch()}/>{query.isError||query.snapshotPaused?<p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">{query.snapshotPaused?'A consulta está pausada e não há conferência atual comprovada.':'A conferência está indisponível. A consulta falhou ou retornou informações incompletas; não foi possível comprovar a cobertura dos recebimentos.'}</p>:<p role="status">Carregando a conferência dos recebimentos…</p>}</main>
}
