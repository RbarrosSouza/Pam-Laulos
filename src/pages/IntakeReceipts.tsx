import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useExamAuth } from '@/contexts/exam-auth'
import { IntakeHeader, IntakeReceiptsView, isIntakePanel } from '@/components/intake/IntakeReceiptsView'
export function IntakeReceipts() {
  const auth=useExamAuth()
  const query=useQuery({queryKey:['intake-panel-v2',auth.session?.user.id],enabled:!!auth.session&&!!auth.membership,refetchInterval:30_000,queryFn:async()=>{
    const {data,error}=await supabase.rpc('get_exam_intake_panel',{p_limit:100})
    if(error)throw error
    if(!isIntakePanel(data))throw new Error('A resposta não comprovou o contrato de cobertura dos recebimentos')
    return data
  }})
  if(query.data&&!query.isError)return <IntakeReceiptsView data={query.data} refreshing={query.isFetching} onRefresh={()=>void query.refetch()}/>
  return <main className="mx-auto max-w-6xl space-y-6 p-4 md:p-8"><IntakeHeader refreshing={query.isFetching} onRefresh={()=>void query.refetch()}/>{query.isError?<p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">A conferência está indisponível. A consulta falhou ou retornou informações incompletas; não foi possível comprovar a cobertura dos recebimentos.</p>:<p role="status">Carregando a conferência dos recebimentos…</p>}</main>
}
