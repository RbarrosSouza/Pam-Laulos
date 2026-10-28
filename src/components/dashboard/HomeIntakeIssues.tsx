import {useExamIntakeFailures} from '@/hooks/useExamIntakeFailures'
import {ExamFailuresView} from '@/components/intake/ExamFailuresView'
export function HomeIntakeIssues(){
  const query=useExamIntakeFailures()
  return <ExamFailuresView compact data={query.data} loading={query.isPending} error={query.isError} refreshing={query.isFetching} paused={query.fetchStatus==='paused'} onRefresh={()=>void query.refetch()}/>
}
