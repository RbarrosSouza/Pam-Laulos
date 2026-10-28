import {useQuery} from '@tanstack/react-query'
import {supabase} from '@/lib/supabase'
import {useExamAuth} from '@/contexts/exam-auth'
import {isIntakePanel} from '@/components/intake/IntakeReceiptsView'
import {useEffect,useState} from 'react'

/** One authenticated, read-only cache shared by Início and Conferência. */
export function useIntakePanel(){
  const auth=useExamAuth()
  const [now,setNow]=useState(()=>Date.now())
  useEffect(()=>{
    const tick=()=>setNow(Date.now()),timer=window.setInterval(tick,30_000)
    window.addEventListener('focus',tick);window.addEventListener('online',tick);window.addEventListener('offline',tick)
    return ()=>{window.clearInterval(timer);window.removeEventListener('focus',tick);window.removeEventListener('online',tick);window.removeEventListener('offline',tick)}
  },[])
  const query=useQuery({queryKey:['intake-panel-v2',auth.session?.user.id],enabled:!!auth.session&&!!auth.membership,staleTime:30_000,refetchInterval:30_000,queryFn:async()=>{
    const {data,error}=await supabase.rpc('get_exam_intake_panel',{p_limit:100})
    if(error)throw error
    if(!isIntakePanel(data))throw new Error('A resposta não comprovou o contrato de cobertura dos recebimentos')
    return data
  }})
  return {...query,now,snapshotPaused:query.fetchStatus==='paused'}
}
