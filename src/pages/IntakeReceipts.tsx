import {useState} from 'react'
import '@/components/intake/exam-conference.css'
import {useExamIntakeFailures} from '@/hooks/useExamIntakeFailures'
import {ExamFailuresView, type ExamFailuresCursor} from '@/components/intake/ExamFailuresView'
export function IntakeReceipts() {
  const [cursors,setCursors]=useState<(ExamFailuresCursor|null)[]>([null]),[refreshVersion,setRefreshVersion]=useState(0)
  const query=useExamIntakeFailures(cursors[cursors.length-1],refreshVersion)
  const refresh=()=>{setCursors([null]);setRefreshVersion(v=>v+1)}
  return <main className="exam-conference-page"><header><h1 className="text-2xl font-semibold tracking-tight">Conferência dos exames</h1></header><ExamFailuresView data={query.data} loading={query.isPending} error={query.isError} refreshing={query.isFetching} paused={query.fetchStatus==='paused'} onRefresh={refresh} pageNumber={cursors.length} onPrevious={()=>setCursors(items=>items.slice(0,-1))} onNext={()=>{const next=query.data?.next_cursor;if(next)setCursors(items=>[...items,next])}}/></main>
}
